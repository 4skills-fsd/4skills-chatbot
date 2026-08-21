# 4Skills website assistant

The chat button in the bottom-right corner of [4skills.co](https://4skills.co), and the
"Practice tests" button next to it.

This guide is written for whoever looks after the website. It does not assume you are a
programmer. Developer notes live in [CLAUDE.md](CLAUDE.md).

---

## What it does

- **Chat** — answers questions about courses, fees, timings and admissions, then offers to
  take a visitor's name and phone number so the team can call them on WhatsApp.
- **Practice tests** — a plain link to [4skills.app](https://4skills.app).

Leads go to a Google Sheet **and** the visitor gets a WhatsApp link. Both, every time.

The assistant only knows what is in one file, `lib/knowledge.json`, plus a fixed list of
business facts. It is built so that it says "the office will confirm that" rather than
guessing. If it starts saying something wrong, the fix is almost always in that one file.

---

## The five things you will actually need

### 1. Change an answer, a fee, or add a question

Everything the assistant knows is in **`lib/knowledge.json`**. Each block looks like this:

```json
{
  "id": "ielts-fee",
  "question": "How much does the IELTS course cost?",
  "answer": "IELTS Academic and IELTS General Training are both Rs 35,000 for the full 8-week course.",
  "keywords": ["ielts", "fee", "fees", "cost", "kitna", "kitne"],
  "category": "fees"
}
```

- **`answer`** is what the assistant will say. Keep it short, two or three sentences.
- **`keywords`** are the words a visitor might type to reach this answer. This is the part
  people get wrong. **Include Roman Urdu**: `kitna`, `kitni`, `kab`, `kahan`, `kaise`,
  `fees kya hai`. A lot of enquiries come in Roman Urdu and an English-only list misses them
  silently — the assistant will just say it does not know.
- Keep keyword phrases to **three words or less**.
- **`id`** must be unique. **`category`** is one of `fees`, `logistics`, `courses`,
  `admissions`, `contact`, `about`, `teaching`, `portal`.

Rules of thumb:

- Every comma, quote and bracket matters. Copy an existing block and edit it rather than
  typing one from scratch.
- Changing a fee? Change it here **and** on the website page that shows it, or the assistant
  and the site will disagree.
- Do not put anything in here you are not certain of. If a fee is not confirmed, leave it out
  — the assistant will offer a call back instead, which is the correct answer.

After editing, run `npm run retrieval-check`. It takes two seconds and tells you whether the
questions still find the right answers. If it prints `X` lines, something broke — undo your
change and try again. Then redeploy (see below).

### 2. Read the leads

Open the **4Skills leads** Google Sheet. One row per enquiry:

| Timestamp | Name | Phone | Course | Session ID | Transcript | Page URL | Referrer |

- **Phone** is already normalised to `+92...`, ready to paste into WhatsApp.
- **Transcript** is the last few things they asked. Read it before you call — it is usually
  obvious what they want.
- **Page URL** is the page they were on when they left their details.

A visitor can leave details at most **three times per hour**, so you will not get flooded by
one person.

You also get an **email for each new enquiry**, subject `New 4Skills enquiry — [name]`, with
the name, phone, course, a tap-to-open WhatsApp link and what they asked. Change the address
it goes to by editing `NOTIFY_EMAIL` near the top of the Apps Script (see
[docs/apps-script.gs](docs/apps-script.gs)) and redeploying it as a new version. If the
email ever fails to arrive, **the row is still written to the sheet** — the sheet is the
record, the email is only a nudge.

### 3. Replace the Groq key

The key is what lets the assistant think. Replace it if it stops working or you believe it
has leaked.

1. Go to [console.groq.com/keys](https://console.groq.com/keys), sign in as 4Skills.
2. **Create API Key**, name it something like `4skills-widget-2026`, copy it.
3. Go to [vercel.com](https://vercel.com) → the `4skills-widget` project → **Settings** →
   **Environment Variables**.
4. Edit `GROQ_API_KEY`, paste the new value, save.
5. **Deployments** → the most recent one → **⋯** → **Redeploy**. The change does not take
   effect until you do this.
6. Back on the Groq page, **delete the old key**.

The key lives only on Vercel. It is never sent to the browser and never appears in the
website's code.

### 4. The assistant says it cannot reach the team

> **This is the most likely thing to go wrong, and it has already happened once.**

If visitors see:

> I cannot reach the assistant at the moment. Please WhatsApp 0332 241 0155…

the assistant is down. It is failing *politely* — the chat button, the practice-tests link
and the WhatsApp number all still work — which is good for visitors and bad for you,
because **an outage looks exactly like a quiet day**. Nothing on the site turns red.

**Check it in ten seconds, any time:**

```bash
npm run health-check
```

It sends one message and tells you which model answered, or says plainly that none did.

#### Cause 1: Groq retired a model (most likely)

Groq removes AI models from service **without notice**. In August 2026 they removed two of
the three this widget used, on the same day, and the assistant went down until the model
list was changed.

Nothing is broken in the code when this happens. The fix is to tell it which models to use
now, and it is a settings change — **no developer, no code change, no redeploy of the
website**:

1. Go to [console.groq.com](https://console.groq.com) → **Models**. That page lists every
   model currently available. (Or, if you prefer, the list is also at
   [console.groq.com/docs/models](https://console.groq.com/docs/models).)
2. Pick two or three, preferring the smaller/faster ones. Note their exact IDs — they look
   like `openai/gpt-oss-20b`.
3. Go to [vercel.com](https://vercel.com) → the `4skills-widget` project → **Settings** →
   **Environment Variables** → edit **`GROQ_MODELS`**.
4. Put the IDs in, separated by commas, best first:
   `openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.6-27b`
5. **Deployments** → most recent → **⋯** → **Redeploy**.
6. Run `npm run health-check` again, or just open the site and say hello.

The widget tries each model in turn, so listing three means two can disappear before
visitors notice anything.

> If a new model behaves oddly — wrong language, ignoring the format, inventing facts —
> tell whoever maintains this. The wording the assistant follows was tuned for a specific
> model and may need adjusting for a different one.

#### Cause 2: the daily free allowance ran out

Check [console.groq.com](https://console.groq.com) → Usage. It resets at midnight UTC
(5:00 AM Pakistan time).

#### Cause 3: Groq itself is down

Check [groqstatus.com](https://groqstatus.com). Nothing to do but wait.

### 4a. Being told automatically

A daily automatic check runs at **6:00 AM UTC (11:00 AM Pakistan time)** and emails
`NOTIFY_EMAIL` — the same address that gets the lead emails — if the assistant is not
answering. The subject is **"4Skills website assistant is DOWN"**.

**Be clear about what this does and does not cover.** Vercel's free plan allows a scheduled
job to run **once per day, and no more often**. So:

- If the assistant breaks just after the check runs, **you will not hear about it for
  almost 24 hours**.
- Visitors during that window get the WhatsApp number, not answers.
- This is a safety net, not monitoring.

If a day of silent downtime is not acceptable, the options are a Vercel Pro plan (which
allows more frequent checks) or a free external uptime service — [UptimeRobot](https://uptimerobot.com)
and similar will call `https://<your-vercel-url>/api/health` every five minutes and text or
email you when it fails. The endpoint already returns a normal "healthy" or "failed"
response for exactly that purpose. Neither is set up; both are a decision for the client.

To set the automatic check up, add two environment variables in Vercel:

| Variable | Value |
|---|---|
| `NOTIFY_EMAIL` | where the alert should go (usually the same as the leads email) |
| `CRON_SECRET` | any long random string — stops strangers triggering the check |

### 5. Deploy a change

1. Commit and push to the repository.
2. Vercel rebuilds automatically, usually under a minute.
3. Changes to the widget itself take up to **5 minutes** to appear for visitors, because
   browsers cache it. Hard-refresh (`Ctrl+F5`) to see it immediately.

---

## The one line on the website

This sits just before `</body>` in `footer.php`. It is the only change to the website:

```html
<!-- 4Skills assistant widget -->
<script
  src="https://4skills-chatbot.vercel.app/widget.js"
  data-api="https://4skills-chatbot.vercel.app"
  data-teaser-delay="8000"
  data-teaser-interval="45000"
  data-teaser-max="3"
  defer></script>
```

The three `data-teaser-*` values control the little pop-up bubble that appears near the chat
button, and can be changed **without a redeploy** — just edit `footer.php`:

| Attribute | Meaning | Default |
|---|---|---|
| `data-teaser-delay` | Wait before the first bubble, in milliseconds | `8000` (8 seconds) |
| `data-teaser-interval` | Gap between bubbles | `45000` (45 seconds) |
| `data-teaser-max` | How many times per visit, then it stops for good | `3` |

Set `data-teaser-max="0"` to switch the bubble off entirely. Dismissing it, or opening the
chat, stops it for that visitor's whole visit.

> `footer.php` is edited through cPanel's editor, which saves Windows line endings. That is
> harmless in HTML, but check the rest of the file still looks right after saving.

---

## Two things to keep an eye on

**Vercel's free plan is licensed for non-commercial use.** This site is a business. Nothing
technical depends on it — upgrading to a Pro seat (about $20/month) is a billing change with
no code change — but it should be a deliberate decision, not an oversight.

**The Groq free tier is generous but finite.** At roughly 50 visitors a day the assistant
uses about a fifth of the daily allowance. Traffic can grow several times over before it
becomes a problem. If the "cannot reach the assistant" message starts appearing daily, that
is the signal.

There is a discount for repeated identical questions, but it only applies when requests
arrive within seconds of each other, which real visitors do not. **Assume every question
costs the full amount** — do not count on that discount when judging whether there is room
to grow. The first model in the list is also the only one with a daily allowance big enough
to carry the site; the others are emergency backups, not alternatives.

---

## Settings reference

On Vercel, under Settings → Environment Variables:

| Name | What it is |
|---|---|
| `GROQ_API_KEY` | The key from console.groq.com. Server-side only. |
| `GROQ_MODELS` | Which AI models to use, in order. **Expect to change this** — see section 4. |
| `ALLOWED_ORIGINS` | Which websites may use the assistant. Add a domain here if the site moves. |
| `LEAD_WEBHOOK_URL` | The Google Sheet address that receives leads. |
| `WHATSAPP_NUMBER` | Digits only, country code first: `923322410155`. |
| `NOTIFY_EMAIL` | Where the daily "assistant is DOWN" alert goes. |
| `CRON_SECRET` | Any long random string. Stops strangers triggering the daily check. |

The leads sheet itself is set up from [docs/apps-script.gs](docs/apps-script.gs), which has
step-by-step instructions at the top of the file.

---

## For developers

Setup, testing, retrieval design, prompt caching and the open questions for the client are
all in **[CLAUDE.md](CLAUDE.md)**.

```bash
cp .env.example .env.local     # add GROQ_API_KEY and LEAD_WEBHOOK_URL
npm run dev                    # http://localhost:3000 — always this port
npm run dev:kill               # frees port 3000 if something is holding it
npm run health-check           # is the live assistant answering?
npm run retrieval-check        # no key needed
npm run render-check           # no key needed
npm run teaser-check           # no key needed
npm run prompt-check           # needs a real key, takes ~8 minutes
```

**The dev port is fixed at 3000 and will not fall back.** If it is busy the
server prints `PORT 3000 IN USE` and exits — run `npm run dev:kill`. A silent
fallback meant an old server kept answering on 3000 while the new one ran
elsewhere, and changes appeared not to apply when they had.

On boot the server prints a **build hash** and the widget's gzipped size. The
same hash appears in the browser console (`[4Skills] widget build …`) and on
`/api/chat` as `x-fs-build`. **If the browser's hash differs from the server's,
that tab is running a cached widget** — hard-refresh. In dev, `widget.js` is
served `no-store` so a plain refresh is enough.

Open `http://localhost:3000/dev-test.html` to see the widget on a simulated version of the
real site. Add `?fast` to watch the teaser, `?resume` to test the unread state, `?rich` to see a
formatted reply with links, `?clear` to reset.

```
api/chat.js          the assistant turn
api/lead.js          lead capture
docs/apps-script.gs  paste into the Google Sheet
lib/knowledge.json   everything the assistant knows
lib/retrieve.js      picks which answers to show it
lib/prompt.js        its instructions
lib/groq.js          talks to the AI
lib/guard.js         origin checks and rate limiting
public/widget.js     the whole thing the browser loads
```
