// Turns a free-text WhatsApp message into diary entries, using Claude.
const { childName } = require('./_lib');

const TOOL = {
  name: 'record',
  description: 'Record the result of reading one WhatsApp message.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['entries', 'not_diary', 'unclear'],
        description: 'entries = the message has anything for the diary (events or special comments). not_diary = unrelated (e.g. a carpool reply, logistics, chit-chat). unclear = about the diary but cannot tell what to record.',
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: ['pee', 'poop', 'drink', 'food', 'wet', 'comment'] },
            value: { type: 'string', description: 'Hebrew text for the diary. Short for table fields; for comments keep the substance and any quote verbatim.' },
            time: { type: 'string', description: 'HH:MM (24h). Stated, implied by a relative time, or estimated (then set approx=true). Omit for whole-day items.' },
            approx: { type: 'boolean', description: 'true if the time is an estimate rather than stated by the sender.' },
            all_day: { type: 'boolean', description: 'true for an observation about the whole day with no sensible single time (e.g. "almost didn\'t drink today").' },
            day_offset: { type: 'integer', description: '-1 if this item is explicitly about yesterday, else omit.' },
          },
          required: ['field', 'value'],
        },
      },
      question: { type: 'string', description: 'For unclear: one short Hebrew question to ask back.' },
    },
    required: ['intent'],
  },
};

function systemPrompt(now, senderName) {
  const child = childName();
  const hours = process.env.DAYCARE_HOURS || '07:30-16:00';
  return `You read WhatsApp messages sent by parents and daycare staff to fill a medical tracking diary for a toddler named ${child} (fluids and toilet diary, requested by his therapist).
Current local time in Israel: ${now.date} ${now.time}. Sender: ${senderName}. Daycare hours: ${hours}.

Diary fields:
- pee (פיפי): amount קצת / בינוני / הרבה, or a duration if given (e.g. "11 שניות"). Note potty/toilet vs diaper if stated.
- poop (קקי): texture on the 1-7 scale (Bristol) if a number is given. If only described in words, write the description as given. Never invent a number.
- drink (שתיה): what and how much if stated.
- food (אוכל): what he ate, concise.
- wet (הרטבה/החתמה): an accident - wet or soiled pants/bed. Prefix with "יום" or "לילה".
- comment (הערות מיוחדות): anything worth telling the therapist that is not one of the above: sentences ${child} said (keep his words exactly, in quotes), behaviour, mood, health remarks (e.g. a sore, pain), how he reacted, activities he chose, what the staff said to him. One comment per topic. Light trimming is fine, but do not paraphrase quotes.

Messages come in two styles:
1. A single event right after it happened ("אכל תפוח"). Use no time (the message time is used).
2. A summary of a whole day or part of it, often from the daycare at the end of the day. Split it into all its events and estimate a time for each:
   - Use cues: ארוחת בוקר ≈ 08:30, ארוחת עשר/פרי ≈ 10:00, צהריים ≈ 12:00, after nap / ארוחת ארבע ≈ 15:00, ארוחת ערב ≈ 18:30, morning circle/dances ≈ 09:00.
   - A count without times ("פיפי 2") becomes that many separate entries spread evenly across the period the message covers (daycare hours for a daycare summary), each with a value describing it (e.g. "1 מתוך 2 בגן").
   - Whole-day remarks about a field ("כמעט ולא שתה מים") -> that field with all_day=true.
   - Comments in a summary: an estimated time if the text places them (e.g. during morning dances), otherwise all_day=true.
   - Mark every estimated time with approx=true.
   - Events from a summary sent the next morning about "yesterday" get day_offset -1.

Rules:
- Messages may be Hebrew or English and may not mention the child's name. Write values in Hebrew. Do not add facts.
- "טיטול רטוב" when changing a diaper = pee (not an accident).
- Relative times ("לפני חצי שעה") are converted to HH:MM from the current time (approx=false).
- Things ${child} tells about events elsewhere (e.g. "he told us he pooped with dad yesterday") are comments, not table events.
- Greetings, sign-offs and logistics ("היי", "בהמשך לשיחה שלנו", "שיהיה בהצלחה") are ignored.
- If the message is only about something else (carpool, logistics, thanks) -> not_diary.`;
}

async function parseMessage(text, now, senderName) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 2000,
      system: systemPrompt(now, senderName),
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'record' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${JSON.stringify(j.error || j)}`);
  const block = (j.content || []).find(b => b.type === 'tool_use');
  if (!block) throw new Error('Claude did not return a result');
  const out = block.input || {};
  out.entries = (out.entries || []).filter(e => e && e.field && e.value);
  if (out.intent === 'entries' && !out.entries.length) out.intent = 'unclear';
  return out;
}

module.exports = { parseMessage, systemPrompt };
