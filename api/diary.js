/**
 * The diary page the therapist opens:  https://<app>.vercel.app/?k=<VIEW_KEY>
 *   &d=YYYY-MM-DD   a specific day (default: today)
 *   &w=1            the 7 days ending on that day (for printing a week)
 */
const crypto = require('crypto');
const { FIELDS, redis, xmlEscape: esc, nowLocal, addDays, weekday, displayDate, childName } = require('./_lib');

function keyOk(given, expected) {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

async function loadDay(date) {
  const rows = await redis(['LRANGE', `day:${date}`, '0', '-1']) || [];
  return rows.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

function cell(list) {
  return list.map(e =>
    `<div class="e"><span class="v">${esc(e.v)}</span><span class="m">${e.allDay ? '' : `${e.approx ? '≈' : ''}${esc(e.t)} · `}${esc(e.by || '')}</span></div>`
  ).join('');
}

function dayTable(date, entries) {
  const byHour = {};
  for (const e of entries) {
    if (e.f === 'comment' || e.f === 'note') continue;
    const h = Number(String(e.t).slice(0, 2));
    const slot = e.allDay ? 'day' : h < 6 ? 'night' : String(h).padStart(2, '0');
    ((byHour[slot] ||= {})[e.f] ||= []).push(e);
  }
  for (const slot of Object.values(byHour)) for (const l of Object.values(slot)) l.sort((a, b) => a.t.localeCompare(b.t));

  const slots = [];
  if (byHour.night) slots.push(['night', '00:00–05:59']);
  for (let h = 6; h <= 23; h++) { const k = String(h).padStart(2, '0'); slots.push([k, `${k}:00`]); }
  if (byHour.day) slots.push(['day', 'במהלך היום']);

  const head = `<tr><th class="h">שעה</th>${FIELDS.map(f => `<th>${f.label}${f.sub ? `<small>${f.sub}</small>` : ''}</th>`).join('')}</tr>`;
  const body = slots.map(([k, label]) =>
    `<tr><td class="h">${label}</td>${FIELDS.map(f => `<td>${cell((byHour[k] || {})[f.key] || [])}</td>`).join('')}</tr>`
  ).join('');
  const count = f => entries.filter(e => e.f === f && !e.allDay).length;
  const total = `<tr class="tot"><td class="h">סה״כ</td>${FIELDS.map(f => `<td>${count(f.key) || ''}</td>`).join('')}</tr>`;

  const byTime = (a, b) => (!!a.allDay - !!b.allDay) || a.t.localeCompare(b.t);
  const item = e => `<li><span class="m">${e.allDay ? '' : `${e.approx ? '≈' : ''}${esc(e.t)} · `}${esc(e.by || '')}</span> ${esc(e.v)}</li>`;
  const comments = entries.filter(e => e.f === 'comment').sort(byTime);
  const notes = entries.filter(e => e.f === 'note').sort(byTime);
  const notesHtml = `<div class="notes"><h2>הערות מיוחדות</h2>${comments.length ? `<ul>${comments.map(item).join('')}</ul>` : '<div class="none">—</div>'}
    ${notes.length ? `<h3>הודעות שלא פוענחו אוטומטית</h3><ul>${notes.map(item).join('')}</ul>` : ''}</div>`;
  const legend = entries.some(e => e.approx) ? '<div class="legend">≈ = שעה משוערת (מתוך הודעת סיכום)</div>' : '';

  return `<section class="day">
  <h1>יומן מעקב נוזלים ויציאות – ${esc(childName())}</h1>
  <div class="date">תאריך: ${displayDate(date)} (יום ${weekday(date)})</div>
  <table><thead>${head}</thead><tbody>${body}${total}</tbody></table>
  ${legend}
  ${notesHtml}
</section>`;
}

function page(inner, ctx) {
  const { k, d, w, today } = ctx;
  const link = (date, week) => `?k=${encodeURIComponent(k)}&d=${date}${week ? '&w=1' : ''}`;
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>יומן מעקב – ${esc(childName())}</title>
<style>
  body { font-family: Arial, "Segoe UI", sans-serif; margin: 0; background: #f4f5f7; color: #111; }
  .bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 10px 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; z-index: 1; }
  .bar a, .bar button { font: inherit; font-size: 15px; padding: 7px 12px; border: 1px solid #bbb; border-radius: 8px; background: #fff; color: #111; text-decoration: none; cursor: pointer; }
  .bar a.on { background: #1f4e79; color: #fff; border-color: #1f4e79; }
  .bar input { font: inherit; font-size: 15px; padding: 6px 8px; border: 1px solid #bbb; border-radius: 8px; }
  .bar .sp { flex: 1; }
  .wrap { padding: 14px; overflow-x: auto; }
  .day { background: #fff; max-width: 980px; margin: 0 auto 18px; padding: 18px 20px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 6px; font-weight: normal; }
  .date { margin-bottom: 10px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; min-width: 640px; }
  th, td { border: 1px solid #333; padding: 3px 5px; vertical-align: top; font-size: 13px; text-align: right; }
  th { font-weight: normal; background: #fafafa; overflow-wrap: anywhere; }
  th small { display: block; font-size: 12px; }
  td.h, th.h { width: 70px; white-space: nowrap; }
  td { height: 24px; }
  .e { margin: 1px 0 3px; line-height: 1.25; }
  .e .v { display: block; }
  .e .m { display: block; font-size: 10.5px; color: #666; }
  tr.tot td { font-weight: bold; background: #fafafa; }
  .notes { margin-top: 14px; font-size: 13.5px; border: 1px solid #333; padding: 8px 12px; min-height: 60px; }
  .notes h2 { font-size: 15px; margin: 0 0 6px; }
  .notes h3 { font-size: 13px; margin: 10px 0 4px; color: #666; font-weight: normal; }
  .notes ul { margin: 0; padding: 0 18px 0 0; }
  .notes li { margin: 3px 0; line-height: 1.4; }
  .notes .m { font-size: 11px; color: #666; }
  .notes .none { color: #aaa; }
  .legend { font-size: 11px; color: #666; margin-top: 4px; }
  .empty { text-align: center; color: #888; padding: 40px; }
  @media (max-width: 600px) {
    .wrap { padding: 6px; }
    .day { padding: 10px 8px; }
    h1 { font-size: 17px; }
    table { min-width: 0; }
    th, td { font-size: 11px; padding: 2px 3px; }
    th small { font-size: 9.5px; }
    td.h, th.h { width: 40px; }
    .e .m { font-size: 9px; }
  }
  @media print {
    @page { size: A4 portrait; margin: 10mm; }
    body { background: #fff; }
    .bar { display: none; }
    .wrap { padding: 0; }
    .day { box-shadow: none; padding: 0; margin: 0; max-width: none; page-break-after: always; break-after: page; }
    .day:last-child { page-break-after: auto; break-after: auto; }
    table { min-width: 0; }
    th, td { font-size: 11px; }
    .e .m { font-size: 9px; }
  }
</style></head><body>
<div class="bar">
  <a href="${link(addDays(d, -1), w)}" title="יום קודם">→</a>
  <input type="date" value="${d}" max="${today}" onchange="location.href='?k=${encodeURIComponent(k)}&d='+this.value+'${w ? '&w=1' : ''}'">
  <a href="${link(addDays(d, 1), w)}" title="יום הבא">←</a>
  <a href="${link(today, w)}">היום</a>
  <span class="sp"></span>
  <a href="${link(d, false)}" class="${w ? '' : 'on'}">יום</a>
  <a href="${link(d, true)}" class="${w ? 'on' : ''}">7 ימים</a>
  <button onclick="window.print()">🖨️ הדפסה / PDF</button>
</div>
<div class="wrap">${inner}</div>
</body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const q = new URL(req.url, 'http://x').searchParams;
  const expected = process.env.VIEW_KEY;
  if (!expected) return res.status(500).send('VIEW_KEY is not set');
  const k = q.get('k') || '';
  if (!k || !keyOk(k, expected)) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).send('<p dir="rtl" style="font-family:Arial;padding:30px">הקישור אינו תקין. בקשו את הקישור המלא מההורים.</p>');
  }

  const today = nowLocal().date;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : today;
  const w = q.get('w') === '1';

  try {
    const dates = w ? Array.from({ length: 7 }, (_, i) => addDays(d, i - 6)) : [d];
    const days = await Promise.all(dates.map(async date => [date, await loadDay(date)]));
    const inner = days.map(([date, entries]) => dayTable(date, entries)).join('');
    return res.status(200).send(page(inner, { k, d, w, today }));
  } catch (e) {
    console.error(e);
    return res.status(500).send('שגיאה בטעינת היומן: ' + esc(e.message || e));
  }
};
