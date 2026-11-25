/**
 * Twilio calls this URL for EVERY WhatsApp message to the shared number.
 *
 *  - Diary messages from known senders  -> saved to the diary, confirmation sent back.
 *  - Everything else (carpool button replies, other parents, non-diary text)
 *    -> passed on unchanged to the carpool app's webhook (CARPOOL_WEBHOOK_URL),
 *       so the carpool reply tracking keeps working exactly as before.
 *
 * Commands (sent as a WhatsApp message):
 *   ביטול / undo          - removes your last diary message
 *   עזרה / help           - how to use
 *   הצטרפות <קוד> <שם>    - adds a new sender (e.g. a new caregiver), JOIN_CODE needed
 */
const {
  FIELD_LABEL, redis, readParams, twilioSignature, validSignature, twiml,
  nowLocal, addDays, digits, allSenders, childName,
} = require('./_lib');
const { parseMessage } = require('./_parse');

function ownUrl(req) {
  if (process.env.PUBLIC_WEBHOOK_URL) return process.env.PUBLIC_WEBHOOK_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}${req.url}`;
}

// Re-send the original Twilio request to the carpool webhook, signed for its URL.
async function forwardToCarpool(params, res) {
  const url = process.env.CARPOOL_WEBHOOK_URL;
  if (!url) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(''));
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilioSignature(url, params, process.env.TWILIO_AUTH_TOKEN),
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await r.text();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'text/xml');
  return res.status(r.status).send(body);
}

function helpText() {
  const c = childName();
  return `יומן המעקב של ${c} 📋
פשוט כתבו מה קרה, למשל:
• "${c} אכל תפוח"
• "שתה 100 מ״ל מים"
• "פיפי בסיר, הרבה"
• "קקי מרקם 4"
• "הרטבה בצהריים"
• "בשעה 10:30 שתה חלב"
• "רועי אמר: 'אני גדול, עשיתי בסיר'" (נרשם בהערות המיוחדות)
השעה נרשמת לפי זמן ההודעה, אלא אם כתבתם שעה.
אפשר גם לשלוח סיכום של כל היום בהודעה אחת. השעות ישוערו ויסומנו ב-≈.
לביטול ההודעה האחרונה: ביטול`;
}

function entryLine(e, today) {
  const when = e.allDay ? 'במהלך היום' : `${e.approx ? '≈' : ''}${e.t}`;
  const day = e.d && e.d !== today ? ` (${e.d.split('-').reverse().join('.')})` : '';
  const v = e.f === 'comment' && e.v.length > 60 ? e.v.slice(0, 57) + '…' : e.v;
  return `• ${when}${day} ${FIELD_LABEL[e.f] || 'הערה'}: ${v}`;
}

function confirmText(saved, today) {
  const approx = saved.some(e => e.approx);
  return `✓ נרשם\n${saved.map(e => entryLine(e, today)).join('\n')}` +
    (approx ? '\n≈ = שעה משוערת' : '') + '\nטעות? שלחו: ביטול';
}

async function undoLast(phone) {
  const last = await redis(['GET', `last:${phone}`]);
  if (!last) return 'אין מה לבטל.';
  const parsed = JSON.parse(last);
  const items = parsed.items.map(it => (typeof it === 'string' ? { key: parsed.key, s: it } : it));
  for (const it of items) await redis(['LREM', it.key, '1', it.s]);
  await redis(['DEL', `last:${phone}`]);
  const today = nowLocal().date;
  return `🗑️ בוטל:\n${items.map(it => entryLine(JSON.parse(it.s), today)).join('\n')}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return res.status(500).send('TWILIO_AUTH_TOKEN is not set');

  const params = await readParams(req);
  if (!validSignature(ownUrl(req), params, req.headers['x-twilio-signature'], authToken)) {
    return res.status(403).send('Invalid signature');
  }

  const reply = text => { res.setHeader('Content-Type', 'text/xml'); return res.status(200).send(twiml(text)); };

  let claimed = null;
  try {
    const phone = digits(String(params.From || '').replace(/^whatsapp:/, ''));
    const text = String(params.Body || '').trim();

    // Template quick-reply buttons belong to the carpool reminders.
    if (params.ButtonText || params.ButtonPayload) return forwardToCarpool(params, res);

    // Joining: "הצטרפות 1234 נועה מהגן"
    const join = text.match(/^(?:הצטרפות|join)\s+(\S+)\s*(.*)$/i);
    if (join && process.env.JOIN_CODE) {
      if (join[1] !== process.env.JOIN_CODE) return reply('קוד שגוי.');
      const name = join[2].trim() || params.ProfileName || phone;
      await redis(['HSET', 'senders', phone, name]);
      return reply(`שלום ${name}, נוספת ליומן של ${childName()} ✓\n\n${helpText()}`);
    }

    const senders = await allSenders();
    const sender = senders[phone];
    if (!sender) return forwardToCarpool(params, res);

    if (/^(עזרה|help|\?)$/i.test(text)) return reply(helpText());
    if (/^(ביטול|בטל|undo)$/i.test(text)) return reply(await undoLast(phone));

    if (!text) {
      if (Number(params.NumMedia) > 0) return reply('כרגע אפשר לרשום רק הודעות טקסט (לא הקלטות/תמונות). אפשר לכתוב במילים?');
      return forwardToCarpool(params, res);
    }

    // Twilio retries on timeouts: handle each message once.
    const sid = params.MessageSid || params.SmsMessageSid;
    if (sid) {
      const fresh = await redis(['SET', `msg:${sid}`, '1', 'NX', 'EX', '604800']);
      if (!fresh) return reply('');
      claimed = sid;
    }

    const now = nowLocal();
    let parsed;
    try {
      parsed = await parseMessage(text, now, sender);
    } catch (e) {
      console.error(e);
      // Don't lose the message: keep it as a note on today's page.
      const note = JSON.stringify({ id: sid || Date.now().toString(36), d: now.date, t: now.time, f: 'note', v: text, by: sender });
      await redis(['RPUSH', `day:${now.date}`, note]);
      await redis(['SET', `last:${phone}`, JSON.stringify({ items: [{ key: `day:${now.date}`, s: note }] }), 'EX', '86400']);
      return reply('⚠️ לא הצלחתי לפענח, ההודעה נשמרה כהערה ביומן.');
    }

    if (parsed.intent === 'not_diary') {
      if (sid) await redis(['DEL', `msg:${sid}`]);
      return forwardToCarpool(params, res);
    }
    if (parsed.intent === 'unclear') {
      return reply(parsed.question || 'לא הבנתי מה לרשום. אפשר לנסח שוב? (עזרה = דוגמאות)');
    }

    // Save entries. Each entry can have its own date (day_offset -1 = yesterday).
    const saved = [], items = [];
    parsed.entries.forEach((e, i) => {
      const date = e.day_offset === -1 ? addDays(now.date, -1) : now.date;
      const hasTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time || '');
      const entry = {
        id: `${sid || Date.now().toString(36)}-${i}`,
        d: date,
        t: hasTime ? e.time : now.time,
        f: e.field,
        v: String(e.value).slice(0, e.field === 'comment' ? 1000 : 200),
        by: sender,
      };
      if (hasTime && e.approx) entry.approx = true;
      if (e.all_day && !hasTime) entry.allDay = true;
      saved.push(entry);
      items.push({ key: `day:${date}`, s: JSON.stringify(entry) });
    });
    for (const it of items) await redis(['RPUSH', it.key, it.s]);
    await redis(['SET', `last:${phone}`, JSON.stringify({ items }), 'EX', '86400']);
    return reply(confirmText(saved, now.date));
  } catch (e) {
    console.error(e);
    if (claimed) { try { await redis(['DEL', `msg:${claimed}`]); } catch (_) {} }
    return res.status(500).send('Error'); // Twilio will retry
  }
};
