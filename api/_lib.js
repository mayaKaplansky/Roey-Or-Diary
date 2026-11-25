// Shared helpers. Files starting with "_" are not exposed as URLs by Vercel.
const crypto = require('crypto');

const TZ = 'Asia/Jerusalem';

// The diary columns, in the order of the paper form (right to left).
const FIELDS = [
  { key: 'pee',   label: 'פיפי',  sub: '(קצת/בינוני/הרבה)' },
  { key: 'poop',  label: 'קקי',   sub: '(מרקם 1-7)' },
  { key: 'drink', label: 'שתיה',  sub: '' },
  { key: 'food',  label: 'אוכל',  sub: '' },
  { key: 'wet',   label: 'הרטבה/החתמה', sub: 'יום/לילה' },
];
const FIELD_LABEL = { ...Object.fromEntries(FIELDS.map(f => [f.key, f.label])), comment: 'הערה מיוחדת', note: 'הערה' };

// ---------- Upstash Redis (REST) ----------
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not connected (missing KV_REST_API_URL / KV_REST_API_TOKEN)');
  return { url, token };
}

async function redis(command) {
  const { url, token } = redisConfig();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`Redis error: ${j.error || r.status}`);
  return j.result;
}

// ---------- Twilio ----------
async function readParams(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

function twilioSignature(url, params, authToken) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function validSignature(url, params, signature, authToken) {
  if (!signature) return false;
  const a = Buffer.from(twilioSignature(url, params, authToken)), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function twiml(text) {
  return text ? `<Response><Message>${xmlEscape(text)}</Message></Response>` : '<Response></Response>';
}

// ---------- Time (Israel) ----------
function nowLocal(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function weekday(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return HEB_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function displayDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

// ---------- Senders ----------
// DIARY_SENDERS="972501234567=מאיה,972521234567=אבא"  (fixed list)
// + anyone who joined with the JOIN_CODE (stored in Redis hash "senders")
function digits(s) { return String(s || '').replace(/\D/g, ''); }

function envSenders() {
  const out = {};
  for (const pair of String(process.env.DIARY_SENDERS || '').split(',')) {
    const [num, ...name] = pair.split('=');
    const d = digits(num);
    if (d) out[d] = (name.join('=') || '').trim() || d;
  }
  return out;
}

async function allSenders() {
  const fromEnv = envSenders();
  let joined = {};
  try {
    const flat = await redis(['HGETALL', 'senders']) || [];
    for (let i = 0; i < flat.length; i += 2) joined[flat[i]] = flat[i + 1];
  } catch (e) { console.error(e); }
  return { ...joined, ...fromEnv };
}

function childName() { return process.env.CHILD_NAME || 'רועי'; }

module.exports = {
  FIELDS, FIELD_LABEL, redis, readParams, twilioSignature, validSignature, xmlEscape, twiml,
  nowLocal, addDays, weekday, displayDate, digits, allSenders, childName,
};
