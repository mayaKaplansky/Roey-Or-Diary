# יומן מעקב – רועי (WhatsApp → diary)

Parents and daycare staff send a WhatsApp message to the business number
(+972-83-762-2229). Claude reads it and writes it into the fluids/toilet diary
at the time the message was sent. The therapist opens one private link.

```
WhatsApp ──► Twilio ──► /api/whatsapp (this app)
                              │
             diary sender + diary text ──► Claude ──► Redis ──► confirmation reply
             anything else (carpool buttons, other parents, non-diary text)
                              └──► forwarded unchanged to the carpool webhook
```

The number can have only one incoming webhook, so this app receives the messages
and passes all carpool traffic on to the carpool app. It re-signs each forwarded
request with the same Twilio auth token, so the carpool app doesn't need any changes.

---

## Setup (about 20 minutes)

### 1. Deploy
```
cd roey-diary
vercel            # new project, name it e.g. roey-diary
vercel --prod
```

### 2. Storage
Vercel → roey-diary project → **Storage** → **Upstash Redis (Marketplace)** → create a **new**
database (not the carpool one) → connect it to the project. The KV_* variables are added automatically.

### 3. Environment variables
Vercel → Settings → Environment Variables:

| Name | Value |
|---|---|
| `TWILIO_AUTH_TOKEN` | same as in the carpool project |
| `ANTHROPIC_API_KEY` | from console.anthropic.com → API keys |
| `VIEW_KEY` | a long random string, e.g. output of `openssl rand -hex 16`. This is the therapist's "password" inside the link |
| `DIARY_SENDERS` | `972501234567=מאיה,972521234567=אבא` (digits only, with 972, no leading 0) |
| `JOIN_CODE` | a short code for the daycare staff, e.g. `4821` |
| `CARPOOL_WEBHOOK_URL` | the URL **currently** set as the incoming webhook in Twilio (step 4), e.g. `https://dvir-carpool.vercel.app/api/twilio-webhook` |
| `CHILD_NAME` | optional, default `רועי` |
| `DAYCARE_HOURS` | optional, default `07:30-16:00`. Used to spread untimed counts in daycare summaries |
| `CLAUDE_MODEL` | optional, default `claude-haiku-5-5` |

Then run `vercel --prod` again so the variables take effect.

### 4. Point Twilio at this app
In Twilio, find where the incoming-message webhook for the WhatsApp number is set. It's one of:
- **Messaging → Services →** (your service) **→ Integration → Incoming messages → Send a webhook**, or
- **Messaging → Senders → WhatsApp senders →** +97283762229 **→ Webhook URL for incoming messages**.

1. Copy the current URL into `CARPOOL_WEBHOOK_URL` (step 3).
2. Replace it with `https://<your-diary-app>.vercel.app/api/whatsapp` (method POST).

### 5. Test
- From your phone, send `עזרה` to the number. You should get the instructions back.
- Send `רועי אכל תפוח`. You should get `✓ נרשם … אוכל: תפוח`.
- Open `https://<your-diary-app>.vercel.app/?k=<VIEW_KEY>`. The entry should be there.
- Check that the carpool replies page still receives replies (e.g. send a test message from a
  number that isn't in the diary list).

If Twilio shows 403 "Invalid signature", set `PUBLIC_WEBHOOK_URL` to the exact URL entered in Twilio.

---

## Daily use

**Senders** just write what happened, in Hebrew or English:
`אכל תפוח` · `שתה 120 מ"ל מים` · `פיפי בסיר, הרבה` · `קקי מרקם 4` · `הרטבה בצהריים` · `בשעה 10:30 שתה חלב` · `אתמול בלילה הרטיב`

- The time recorded is when the message was sent, unless the message gives a time.
- One message can hold several events.
- **Full-day summaries** (e.g. from the daycare at the end of the day) are split into separate entries.
  Hours are estimated from cues (breakfast ≈08:30, lunch ≈12:00, morning dances ≈09:00…). Counts like
  "פיפי 2" are spread across daycare hours. Whole-day remarks ("כמעט לא שתה") go in a "במהלך היום" row.
  Estimated times are marked **≈** in the reply and on the page.
- **Special comments** (things Roey says, mood, health remarks, activities he chose) go into the
  "הערות מיוחדות" box under each day's table. His words are kept verbatim.
- `ביטול` removes your last message. `עזרה` shows examples.
- If Claude can't parse a message, it's saved as a note at the bottom of that day, so nothing is lost.
- Voice notes and photos aren't supported. The sender gets asked to write it out.

**Daycare staff**: send them this once:
> שמרו את המספר 083762229 ושלחו אליו בוואטסאפ: `הצטרפות 4821 <השם שלכן>`
> אחר כך פשוט כותבים מה רועי אכל/שתה/פיפי/קקי, והיומן מתמלא לבד.

To remove someone who joined: Upstash console → Data Browser → hash `senders` → delete their number.
Change `JOIN_CODE` if the code has leaked.

**Therapist**: send her the link `https://<your-diary-app>.vercel.app/?k=<VIEW_KEY>`.
- Opens on today's date. Arrows / date picker move between days.
- **7 ימים** shows the last week, and **הדפסה / PDF** prints one A4 page per day.
- Anyone with the link can see the diary. To revoke it, change `VIEW_KEY` and redeploy.

## Files
- `api/whatsapp.js`: Twilio webhook: routing, commands, saving
- `api/_parse.js`: the Claude prompt that turns a message into diary entries
- `api/diary.js`: the therapist page
- `api/_lib.js`: Redis, Twilio signature, Israel time, senders
- `test/local-test.js`: `npm test` runs an end-to-end test with fake Redis/Claude/carpool

## Cost
Messages users send to the business are free on WhatsApp's side, and Twilio charges about half a cent per message.
Claude Haiku costs a fraction of a cent per message. Upstash and Vercel stay on their free tiers.
