// Local end-to-end test with fake Redis, fake Claude and fake carpool webhook.
// Run: node test/local-test.js   (writes test/out-day.html and test/out-week.html)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.KV_REST_API_URL = 'https://redis.test';
process.env.KV_REST_API_TOKEN = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.VIEW_KEY = 'secret-view';
process.env.JOIN_CODE = '4821';
process.env.CARPOOL_WEBHOOK_URL = 'https://carpool.test/api/twilio-webhook';
process.env.DIARY_SENDERS = '972501111111=מאיה,972502222222=אבא';

const { twilioSignature, validSignature, nowLocal, addDays } = require('../api/_lib');
const webhook = require('../api/whatsapp');
const diary = require('../api/diary');

// ---- fake Redis ----
const db = new Map();
function cmd([c, ...a]) {
  c = c.toUpperCase();
  const list = k => (db.has(k) ? db.get(k) : (db.set(k, []), db.get(k)));
  switch (c) {
    case 'GET': return db.has(a[0]) ? db.get(a[0]) : null;
    case 'SET': { if (a.includes('NX') && db.has(a[0])) return null; db.set(a[0], a[1]); return 'OK'; }
    case 'DEL': return db.delete(a[0]) ? 1 : 0;
    case 'RPUSH': list(a[0]).push(...a.slice(1)); return list(a[0]).length;
    case 'LRANGE': return (db.get(a[0]) || []).slice(Number(a[1]), Number(a[2]) === -1 ? undefined : Number(a[2]) + 1);
    case 'LREM': { const l = db.get(a[0]) || []; const i = l.indexOf(a[2]); if (i >= 0) { l.splice(i, 1); return 1; } return 0; }
    case 'HSET': { const h = db.get(a[0]) || {}; h[a[1]] = a[2]; db.set(a[0], h); return 1; }
    case 'HGETALL': return Object.entries(db.get(a[0]) || {}).flat();
    default: throw new Error('unsupported ' + c);
  }
}

// ---- fake Claude: a few canned answers keyed on the message ----
const SUMMARY = 'היי בהמשך לשיחה שלנו:\nארוחת בוקר 3 חצאי לחם זעתר עם קוטג ומלפפון.\nצהריים פתיתים וקציצה. \nמים כמעט ולא שתה, סיפר שיש לו פצע בשפה. \nפיפי 2 \nהיום בריקודי הבוקר היינו אני שירי והילדים. רועי סיפר שאתמול עשה קקי עם אבא בשירותים. \nאמרתי לו תודה ששיתף אותנו ואני גאה בו. \nבחירה יזומה:\nחישוקים וכריות לריקודים, סידור אזור הבובות לריקודים, ובחירת חבר. \nשיהיה לנו בהצלחה';
const canned = {
  [SUMMARY]: { intent: 'entries', entries: [
    { field: 'food', value: 'ארוחת בוקר: 3 חצאי לחם זעתר עם קוטג׳ ומלפפון', time: '08:30', approx: true },
    { field: 'food', value: 'צהריים: פתיתים וקציצה', time: '12:00', approx: true },
    { field: 'drink', value: 'מים – כמעט לא שתה', all_day: true },
    { field: 'pee', value: '1 מתוך 2 בגן', time: '10:00', approx: true },
    { field: 'pee', value: '2 מתוך 2 בגן', time: '14:00', approx: true },
    { field: 'comment', value: 'סיפר שיש לו פצע בשפה (כמעט לא שתה מים)', all_day: true },
    { field: 'comment', value: 'בריקודי הבוקר סיפר שאתמול עשה קקי עם אבא בשירותים. הגננת אמרה לו תודה ששיתף ושהיא גאה בו.', time: '09:00', approx: true },
    { field: 'comment', value: 'בחירה יזומה: חישוקים וכריות לריקודים, סידור אזור הבובות לריקודים, ובחירת חבר', all_day: true },
  ] },
  'רועי אכל תפוח': { intent: 'entries', entries: [{ field: 'food', value: 'תפוח' }] },
  'שתה 120 מל מים ופיפי הרבה בסיר': { intent: 'entries', entries: [{ field: 'drink', value: 'מים 120 מ"ל' }, { field: 'pee', value: 'הרבה (בסיר)' }] },
  'בשעה 07:15 קקי מרקם 4': { intent: 'entries', entries: [{ field: 'poop', value: '4', time: '07:15' }] },
  'אתמול בלילה הרטיב': { intent: 'entries', entries: [{ field: 'wet', value: 'לילה – הרטבה', time: '03:00', day_offset: -1 }] },
  'מגיעים ב-8 מחר': { intent: 'not_diary' },
  'הוא עשה': { intent: 'unclear', question: 'מה עשה – פיפי או קקי?' },
  'Roey peed 11 seconds': { intent: 'entries', entries: [{ field: 'pee', value: '11 שניות' }] },
};
let claudeCalls = 0, carpoolCalls = [];
global.fetch = async (url, opts) => {
  const ok = (obj, status = 200, ct = 'application/json') => ({
    ok: status < 400, status, json: async () => obj, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
    headers: { get: () => ct },
  });
  if (url.startsWith('https://redis.test')) return ok({ result: cmd(JSON.parse(opts.body)) });
  if (url.startsWith('https://api.anthropic.com')) {
    claudeCalls++;
    const body = JSON.parse(opts.body);
    const msg = body.messages[0].content;
    assert.ok(body.tool_choice && body.tools[0].name === 'record');
    const input = canned[msg] || { intent: 'unclear' };
    return ok({ content: [{ type: 'tool_use', name: 'record', input }] });
  }
  if (url === process.env.CARPOOL_WEBHOOK_URL) {
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    assert.ok(validSignature(url, params, opts.headers['X-Twilio-Signature'], 'test-token'), 'forwarded signature must be valid');
    carpoolCalls.push(params);
    return ok('<Response></Response>', 200, 'text/xml');
  }
  throw new Error('unexpected fetch ' + url);
};

// ---- fake req/res ----
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.send = b => { r.body = String(b); return r; };
  r.json = o => r.send(JSON.stringify(o));
  return r;
}
let n = 0;
async function send(from, fields) {
  const url = 'https://diary.test/api/whatsapp';
  const params = { MessageSid: 'SM' + (++n), From: 'whatsapp:+' + from, NumMedia: '0', ...fields };
  const req = { method: 'POST', url: '/api/whatsapp', headers: { host: 'diary.test', 'x-twilio-signature': twilioSignature(url, params, 'test-token') }, body: params };
  const res = fakeRes();
  await webhook(req, res);
  return res;
}
const msgOf = res => (res.body.match(/<Message>([\s\S]*)<\/Message>/) || [])[1] || '';

(async () => {
  const today = nowLocal().date;

  // bad signature rejected
  { const res = fakeRes(); await webhook({ method: 'POST', url: '/api/whatsapp', headers: { host: 'diary.test', 'x-twilio-signature': 'nope' }, body: { Body: 'x' } }, res); assert.equal(res.statusCode, 403); }

  // diary entries
  let r = await send('972501111111', { Body: 'רועי אכל תפוח' });
  assert.match(msgOf(r), /אוכל: תפוח/); console.log('food ->', msgOf(r).split('\n')[1]);
  r = await send('972502222222', { Body: 'שתה 120 מל מים ופיפי הרבה בסיר' });
  assert.match(msgOf(r), /שתיה/); assert.match(msgOf(r), /פיפי/);
  r = await send('972502222222', { Body: 'בשעה 07:15 קקי מרקם 4' });
  assert.match(msgOf(r), /07:15 קקי: 4/);
  r = await send('972501111111', { Body: 'אתמול בלילה הרטיב' });
  assert.match(msgOf(r), /\(\d\d\.\d\d\.\d{4}\)/, 'yesterday shows date');

  // undo removes the last message of that sender only
  r = await send('972501111111', { Body: 'Roey peed 11 seconds' });
  r = await send('972501111111', { Body: 'ביטול' });
  assert.match(msgOf(r), /בוטל/); assert.match(msgOf(r), /11 שניות/);
  r = await send('972501111111', { Body: 'ביטול' });
  assert.match(msgOf(r), /אין מה לבטל/);

  // unclear -> question back
  r = await send('972501111111', { Body: 'הוא עשה' });
  assert.match(msgOf(r), /פיפי או קקי/);

  // full-day summary from the daycare
  r = await send('972503333333', { Body: 'הצטרפות 4821 נועה מהגן' });
  r = await send('972503333333', { Body: SUMMARY });
  console.log(msgOf(r));
  assert.match(msgOf(r), /≈08:30 אוכל/); assert.match(msgOf(r), /במהלך היום שתיה/); assert.match(msgOf(r), /≈ = שעה משוערת/);
  r = await send('972503333333', { Body: 'ביטול' });
  assert.match(msgOf(r), /בוטל/);
  r = await send('972503333333', { Body: SUMMARY });

  // routing to carpool
  const before = claudeCalls;
  r = await send('972509999999', { Body: 'מגיעים' });                    // unknown sender
  r = await send('972501111111', { Body: 'אישור', ButtonText: 'אישור' }); // template button
  assert.equal(claudeCalls, before, 'no AI call for carpool traffic');
  r = await send('972501111111', { Body: 'מגיעים ב-8 מחר' });              // known sender, not diary
  assert.equal(carpoolCalls.length, 3, 'three messages forwarded to carpool');
  assert.equal(carpoolCalls[0].From, 'whatsapp:+972509999999');

  // join flow for daycare staff
  r = await send('972503333333', { Body: 'הצטרפות 0000 נועה' });
  assert.match(msgOf(r), /קוד שגוי/);
  r = await send('972503333333', { Body: 'הצטרפות 4821 נועה מהגן' });
  assert.match(msgOf(r), /נוספת/);
  r = await send('972503333333', { Body: 'רועי אכל תפוח' });
  assert.match(msgOf(r), /תפוח/);

  // duplicate delivery (Twilio retry) is ignored
  const dupParams = { MessageSid: 'SMdup', From: 'whatsapp:+972501111111', Body: 'רועי אכל תפוח', NumMedia: '0' };
  for (let i = 0; i < 2; i++) {
    const url = 'https://diary.test/api/whatsapp';
    const res = fakeRes();
    await webhook({ method: 'POST', url: '/api/whatsapp', headers: { host: 'diary.test', 'x-twilio-signature': twilioSignature(url, dupParams, 'test-token') }, body: dupParams }, res);
  }
  const todayRows = cmd(['LRANGE', `day:${today}`, '0', '-1']).map(JSON.parse);
  assert.equal(todayRows.filter(e => e.v === 'תפוח').length, 3, 'two tapuach + one dup-protected');
  assert.equal(todayRows.filter(e => e.f === 'comment').length, 3, 'summary comments saved once (after undo + resend)');

  // seed a fuller example day to look at
  const demo = [
    ['06', '06:40', 'pee', 'הרבה (טיטול לילה)', 'מאיה'], ['07', '07:05', 'drink', 'חלב 180 מ"ל', 'אבא'], ['07', '07:20', 'food', 'קורנפלקס', 'אבא'],
    ['08', '08:30', 'pee', 'בינוני, בסיר', 'נועה'], ['09', '09:45', 'drink', 'מים חצי כוס', 'נועה'], ['10', '10:10', 'food', 'פרוסה עם גבינה, מלפפון', 'נועה'],
    ['11', '11:00', 'wet', 'יום – הרטבה קלה במשחק', 'נועה'], ['12', '12:30', 'food', 'אורז ועוף', 'נועה'], ['12', '12:40', 'drink', 'מים 100 מ"ל', 'נועה'],
    ['13', '13:15', 'poop', '5 (רך)', 'נועה'], ['15', '15:30', 'pee', '11 שניות', 'נועה'], ['17', '17:10', 'drink', 'מיץ מדולל', 'מאיה'],
    ['18', '18:40', 'food', 'פסטה', 'אבא'], ['19', '19:50', 'pee', 'קצת', 'מאיה'],
  ];
  const demoDate = addDays(today, -2);
  for (const [, t, f, v, by] of demo) cmd(['RPUSH', `day:${demoDate}`, JSON.stringify({ id: t, t, f, v, by })]);
  cmd(['RPUSH', `day:${demoDate}`, JSON.stringify({ id: 'n', t: '16:02', f: 'note', v: 'היה עצבני אחרי השינה', by: 'נועה' })]);
  cmd(['RPUSH', `day:${demoDate}`, JSON.stringify({ id: 'c1', t: '19:30', f: 'comment', v: 'רועי אמר: "אני כבר גדול, אני עושה פיפי בסיר"', by: 'מאיה' })]);

  // diary page
  const view = async (q) => { const res = fakeRes(); await diary({ url: '/api/diary' + q, headers: {} }, res); return res; };
  assert.equal((await view('?k=wrong')).statusCode, 401);
  const day = await view(`?k=secret-view&d=${demoDate}`);
  assert.equal(day.statusCode, 200);
  assert.match(day.body, /קורנפלקס/);
  const tday = await view(`?k=secret-view`);
  assert.match(tday.body, /תפוח/);
  assert.match(tday.body, /הערות מיוחדות/); assert.match(tday.body, /בחירה יזומה/); assert.match(tday.body, /במהלך היום/);
  const week = await view(`?k=secret-view&d=${today}&w=1`);
  assert.equal((week.body.match(/class="day"/g) || []).length, 7);
  fs.writeFileSync(path.join(__dirname, 'out-day.html'), day.body);
  fs.writeFileSync(path.join(__dirname, 'out-today.html'), tday.body);
  fs.writeFileSync(path.join(__dirname, 'out-week.html'), week.body);

  console.log('ALL TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
