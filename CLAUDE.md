# 4Skills widget — project context

Chat assistant + practice-test launcher for **4skills.co**, an IELTS/PTE institute in
Faisalabad, Pakistan. Ships as one hand-written JS file served from Vercel and loaded
by a legacy PHP site with a single `<script>` tag.

## Non-negotiable constraints

| Constraint | Consequence |
|---|---|
| Host site is flat PHP 8.0 — no framework, no build step, no composer | Widget ships as a pre-built static file. `public/widget.js` is **hand-written and served as-is**. Do not add a bundler, framework, or npm dependency to the widget. |
| Host loads Bootstrap 5, jQuery, and a heavily hand-edited `bootstrap.min.css` | **Shadow DOM is mandatory.** All widget CSS lives in one `<style>` inside the shadow root. Nothing touches host styles or globals. No `!important` wars. |
| Deploy target for the PHP site is cPanel shared hosting, manual uploads, no SSH | The only change to the PHP codebase is one script tag in `footer.php`. |
| Widget runs cross-origin (site `4skills.co`, API on Vercel) | Explicit origin allowlist in `lib/guard.js`. No wildcard CORS, ever. |
| Groq free tier, client's own account | Token budget is the binding constraint — see below. |
| Vercel free tier, client's own account | Hobby plan is licensed **non-commercial**. Flagged to the client in writing; a Pro seat (~$20/mo) is the clean fix. Build so upgrading is a plan change only, never a code change. |
| 20,000 PKR one-time + 1 month maintenance | Must stay maintainable by one person reading the source. No exotic dependencies. |

## Architecture

```
Browser (4skills.co, PHP)
  └── <script src="https://<project>.vercel.app/widget.js" defer>
        └── Shadow DOM root ──► POST /api/chat  ──► Groq (OpenAI-compatible endpoint)
                            └─► POST /api/lead  ──► Apps Script webhook + wa.me handoff
```

No database, no auth, no sessions, no cookies, no streaming. Conversation state lives in
browser memory + `sessionStorage`. Leads go to a Google Sheet **and** hand the visitor a
prefilled WhatsApp link — both, not either.

Backend talks to Groq with plain `fetch` against the OpenAI-compatible endpoint, not
`groq-sdk` — nothing to keep updated.

## Token budget — and the model outage of Aug 2026

**READ THIS BEFORE TRUSTING ANY MODEL ID IN THIS REPO.**

In August 2026 Groq decommissioned the entire Llama family. `llama-3.1-8b-instant`
(the primary) and `llama-3.3-70b-versatile` (the last fallback) both began returning
`404 model_not_found` on the same day. The widget did not go dark only because the middle
entry survived — and at that moment it was rate-limited, so visitors got the WhatsApp
fallback instead of an answer.

The chain did its job. The lesson is that **a model ID is a perishable fact**. Verify
before assuming:

```bash
curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models
```

Current chain, confirmed live from `x-ratelimit-*` response headers:

| Model | Requests/day | TPM | Notes |
|---|---|---|---|
| `openai/gpt-oss-20b` | 1,000 | 8,000 | primary — smallest, so fastest |
| `openai/gpt-oss-120b` | 1,000 | 8,000 | fallback |
| `qwen/qwen3.6-27b` | 1,000 | 8,000 | fallback |

`groq/compound` and `groq/compound-mini` also exist on this key but are agentic
tool-using systems, not plain chat models — do not put them in the chain.

**RPD is no longer the comfortable number it was.** The old 8B model allowed 14,400
requests/day; these allow 1,000. At ~60 requests/day that is still 16× headroom, so it is
not urgent — but a 5× traffic increase now lands at 300/day, not 300/14,400.

**TPD IS 200,000 PER MODEL PER DAY. CONFIRMED 19 Aug 2026, and it is the binding
constraint on this project — not RPD, not TPM.**

It is still not in the response headers. It was confirmed the hard way, from the body of a
live 429:

```
Rate limit reached for model `openai/gpt-oss-20b` ... service tier `on_demand`
on tokens per day (TPD): Limit 200000, Used 196978
```

At the measured mean of ~3,750 tokens per request that is **~53 requests per day per
model, ~160 across the whole chain**. The estimate for real traffic is ~60/day. So the
primary alone covers roughly one ordinary day, and the fallback chain — which exists for
outages — is silently doubling as the daily capacity plan. **There is no 16× headroom.
The RPD figure of 1,000/day above is irrelevant; the token cap binds at ~53.**

What this looks like when you hit it: every model 429s in turn and visitors get the
WhatsApp fallback. It does not announce itself as a quota problem.

**A full `prompt-check` run costs ~135,000 tokens — 68% of one model's entire day.** Two
runs exhaust the primary, a third exhausts the primary and the first fallback. That is
exactly what happened on 19 Aug 2026: run 1 was clean at 36/36 on the primary, run 2 came
back 27/36 on fallbacks, run 3 came back 34/36 — and increasing the pacing gap made it
*worse*, because a daily cap does not care about spacing. **If a run reports mass fallback,
check TPD before touching `PROMPT_CHECK_GAP`.** Budget one suite run per day, and do not
schedule one on a day the client is demoing.

**Raise this with the client before launch.** A Groq paid tier is the fix; the code needs
no change.

### The numbers, and where to read them

| Limit | Value | Where it is reported |
|---|---|---|
| TPD | **200,000 per model per day** | **The 429 response BODY only.** Never in a header. |
| TPM | 8,000 per model | `x-ratelimit-*-tokens` |
| RPD | 1,000 per model | `x-ratelimit-*-requests` |

**Do not try to read TPD from `x-ratelimit-*`.** It is not there, and looking only at the
headers is exactly why this file called TPD "unverified" for the whole build. `lib/groq.js`
now captures the headers AND the body on every failed attempt for this reason.

**The three daily buckets are per model, so the chain multiplies daily capacity, not just
TPM.** Three models × 200,000 = 600,000 tokens/day ≈ **155 requests/day** at the measured
cost, against a ~60/day traffic estimate. The fallback chain is therefore doing double duty:
it exists for outages, and it is also the capacity plan. Losing one model to
decommissioning costs a third of the daily budget, not just a fallback.

Measured cost per request, mean over live traffic:

| | tokens |
|---|---|
| Before the Aug 2026 cuts | ~3,750 |
| After (static prompt 3,714 → **2,671**) | **~2,700** |
| Daily capacity at that cost | ~74/model, **~222 across the chain** |

The estimate logged as `[chat] tokens~ static=… reference=… history=…` runs about 2% high
against Groq's own `usage.prompt_tokens` — close enough to answer "which part grew", which
is the only question it is for. History is the only part that grows, which is why the
widget sends a 4-message window.

### Which Groq key is which — check this before blaming quota

**There are two keys, and they never meet.**

| Key | Lives in | Whose quota |
|---|---|---|
| Developer key | `.env.local`, git-ignored, never deployed | The developer's (Ahmad's) |
| Client key | The client's Vercel environment variables only | The client's |

The client's key is **never present locally**. Nothing you run from this repo — `npm run dev`,
`prompt-check`, a `curl` against `api.groq.com` — can touch the client's daily budget, and
nothing the client's visitors do eats into yours. Local TPD exhaustion and a production
outage are independent events that look identical in the error body.

**So an org id in a 429 identifies which key hit the wall, not which environment matters.**
A previous session read a local 429 (`org_01kc3…`), assumed it was the client's key, and
concluded that its own `prompt-check` runs had taken the live widget down. That was wrong:
the org was the developer's. Do not repeat the inference. If production is failing, the
evidence is in Vercel's logs, not in anything reproducible here.

`prompt-check` is ~36 requests, roughly 100,000 tokens at the post-cut size — **half of one
model's daily budget on the DEVELOPER key.** Budget accordingly, but it is not a production
risk.

### The fallback chain is correct — do not "fix" it

`lib/groq.js` advances to the next model on **any non-ok status except 401/403**, with no
retry and no sleeping on `retry-after`. This is deliberate:

- Groq's limits are per model, so the next model has its own budget and trying it costs one
  round trip.
- Honouring `retry-after` would park a visitor for a whole rate-limit window behind a model
  already known to be refusing.
- 401/403 is a key problem, not a model problem, so the rest of the chain is pointless.

Confirmed live 19 Aug 2026: a single request produced 429 on `gpt-oss-20b`, 429 on
`gpt-oss-120b` and 429 on `qwen`, in chain order. A build prompt has already been written
on the incorrect assumption that the chain only advanced on 404/5xx. It never did.

TPM is 8,000, up from 6,000. At ~3,800 tokens per request that is ~2 concurrent requests
per minute. Hence, non-negotiably:

- Retrieve **top 3–4** FAQ entries. Never stuff all of `knowledge.json` into the prompt.
- Cap history sent to the model at the **last 6 messages**.
- Hard-cap `max_tokens` at **420**.
- Reject user messages over 500 chars client-side with a friendly nudge.

Fallback chain on 429/5xx **and on 404** — a retired ID returns 404, not 429, so
`groq.js` treats any non-ok status as a reason to try the next model. All three fail →
graceful message offering WhatsApp, never a raw error. The chain lives in `GROQ_MODELS`
so it can be repaired from the Vercel dashboard without a code change. The serving model
is echoed in `x-fs-model`.

### The new primary is a reasoning model, and that nearly broke it silently

`openai/gpt-oss-*` spend tokens thinking before they answer, and that thinking comes out of
`max_tokens`. Measured on a request asking for a five-item list at `max_tokens: 420`:

```
finish_reason  length
completion     420 tokens, of which reasoning 405
content        29 characters
```

The visitor gets nothing. Worse, `groq.js` correctly treats an empty completion as a
failure and moves down the chain, so the symptom is "the bot is slow and then falls back"
rather than anything pointing at token budgets.

`REASONING_EFFORT` in `lib/groq.js` sets `reasoning_effort: 'low'` for the gpt-oss models.
The same request then used **19** reasoning tokens, finished cleanly, and answered fully in
124 completion tokens — fewer tokens and a better answer. The parameter is only sent to
models listed in that map, so an unfamiliar model gets a plain request instead of a 400.

**If you add a model to the chain, check whether it reasons.** `qwen/qwen3.6-27b` does not,
but it is verbose — it ran past `max_tokens: 420` on the same prompt and needed
`reasoning_effort: 'none'` to stop at a sensible length.

**The prompt was tuned against `llama-3.1-8b-instant`, which no longer exists — and has
now been re-verified against `openai/gpt-oss-20b`.** Full `prompt-check` run, 17 Aug 2026,
36 requests: **209 passed, 2 failed.** Every behavioural finding recorded below — the bullet
shape, the language directive position, the lead marker, the refusal rules — was originally
measured on a model that is gone, and all of it carried over. The five liability refusals
(band prediction, essay grading, visa advice, university acceptance, unconfirmed fees) all
hold on the new model.

The two failures were both benign and neither is a behaviour regression:

- *"under 25 words — 57 words"*: the reply was a correct three-bullet enrolment answer that
  then opened the lead form. The 25-word assertion assumes the pre-form line is the whole
  reply; here the visitor's question deserved an answer first. **Answer-first beat the
  assertion, which is the priority this project wants** — see "Answer first" in the prompt.
- *"second identical request reports cached tokens"*: see the caching section below.

Re-run this suite after any model swap. It is the only thing that catches a new model
quietly ignoring a refusal rule, and refusals are the ones with legal exposure.

## Prompt caching — why message order is load-bearing

Groq does not count prompt-cache hits toward the rate limits. `STATIC_PROMPT` is identical
on every request, so caching it is the difference between roughly 2 and 5 requests per
minute of headroom against the **8,000** TPM ceiling.

Caching only fires on a **byte-identical prefix**. That is why `buildMessages()`
assembles:

```js
[
  { role: 'system', content: STATIC_PROMPT },              // never varies
  { role: 'system', content: `Reference material for this turn:\n${entries}` },
  ...history.slice(-6)
]
```

Retrieved FAQ material and the per-turn language directive both go **after** message zero,
never interpolated into it. Never put a timestamp, session id, visitor name or page URL in
message zero — anything that varies breaks the cache for every visitor, not just that one.

**Groq's caching is best-effort, and on `gpt-oss-20b` it mostly does not fire. Budget every
request at the full ~3,650 tokens and treat any hit as a bonus.** Measured over the 17 Aug
2026 run of 31 scored requests: **3 reported a cache hit, 28 reported zero** — and the
dedicated back-to-back cache pair was one of the zeros, which is why `prompt-check` shows a
`FAIL` on "second identical request reports cached tokens". That assertion is checking a
best-effort feature and will flap. It is **not** evidence of prefix drift.

The assertion that actually detects drift is the one beside it — *"identical payloads
produce identical prompt tokens"* — and it passed (3,666 vs 3,666). The hits that did land
were 3,328 tokens against a 3,666-token prompt, about 91%, which is the prefix being cached
exactly as designed. **Read those two assertions together: identical-token PASS plus
cached-token FAIL means the prefix is fine and Groq simply did not serve the cache. An
identical-token FAIL is the one to panic about.**

Real traffic at ~60 requests/day arrives minutes apart, so caching was never in the capacity
maths anyway.

**Do not promote a fallback to primary to fix model BEHAVIOUR.** If a reply is wrong, fix
the prompt or the knowledge entry — swapping models hides the cause and moves the daily
budget. (This rule did not apply to the Aug 2026 swap: the primary had ceased to exist.)

## Language is decided in code, not by the prompt

`detectLanguage()` in `lib/prompt.js` picks English or Roman Urdu from the visitor's last
message, and `buildMessages()` appends a one-line directive as the **last** message in the
array.

Both details are load-bearing, and both were established by measurement:

- **"Match the visitor's language" as a prompt rule was not enough.** Over three runs, four
  of twelve English questions came back in Roman Urdu — mostly by the model lifting the
  closing line verbatim out of the Roman Urdu worked example.
- **Position matters more than wording.** With the directive at message index one, replies
  started in English and switched to Roman Urdu for the closing question. Moving the same
  sentence to the end of the array — the last thing read before generation — took language
  failures from four to zero across three runs.

It costs about ten tokens and sits after the cached prefix, so caching is unaffected.

`x-fs-cached` on the response reports Groq's cached-token count. If it sits at 0 across
two identical requests in production, caching has broken and the headroom maths above
no longer holds.

## Retrieval — how the scoring works and why

`lib/retrieve.js`, roughly 100 lines, no dependencies, index built once at module load.

- **IDF weighting**, `1 / (1 + df)`. This is the important part. Generic terms
  (`course`, `class`, `ielts`, `fee`) appear across most of the corpus, so a plain
  term-overlap count lets a teaching entry outrank a fees entry on a vague query. With
  IDF, a term in 20 of 33 entries contributes almost nothing while `spouse`, `oet`,
  `refund` or `kitni` dominate. **Fix ranking here, not by deleting entries** — extra
  entries cost nothing at retrieval time, since top-4-above-a-floor returns four either
  way.
- **Stopwords**, English and Roman Urdu, stripped from index and query alike. Not
  cosmetic: without them `"what is the weather today"` matches `what`/`is`/`the` — its
  only overlap with the corpus — then normalises against a denominator built from those
  same three terms and scores ~0.6 on a fees entry. The floor cannot catch that. Removing
  function words leaves nothing scorable, which is the correct answer.
  Interrogatives are deliberately **not** stopwords: `how`, `when`, `where`, `who`,
  `kitna`, `kitne`, `kitni`, `kab`, `kahan`, `kaise` carry real signal here and several
  appear verbatim in keyword lists.
- **Keyword field weighted 2×** over the question field. A term in both counts once, at
  the higher weight.
- **Phrase bonus** for multi-word keyword hits (`kitne baje`, `letter writing`,
  `online class`). Exact phrase matches are a much stronger signal than their terms
  landing separately, and this is what breaks ties between genuinely close entries.
- **Normalised against the query's own ceiling**, not against the best-scoring entry.
  Per-query max-normalisation would make the top hit 1.0 every time and the floor would
  never reject anything. Query terms absent from the corpus are excluded from the
  denominator, otherwise one unknown word drags a whole verbose query under the floor.
- **Category boost** ×1.15 for `fees` and `logistics`, the highest-intent categories, so
  they win ties.
- **Floor 0.15, max 4 entries.** Passing no reference material is better than passing
  four irrelevant ones — the system prompt handles the empty case.

Chosen ids are echoed in the `x-fs-retrieved` response header, so retrieval is
debuggable in production without a logging service.

## Testing

```bash
npm run dev                 # ALWAYS port 3000, fails loudly if busy
npm run dev:kill            # frees port 3000
npm run retrieval-check     # no key needed — fixed queries + floor cases
npm run render-check        # no key needed — assistant-reply renderer + link allowlist
npm run mock-groq           # fake Groq, for fallback-chain tests without a key
npm run dev                 # local server, handlers run unchanged from Vercel
npm run prompt-check        # REQUIRES a real GROQ_API_KEY
```

`scripts/mock-groq.js` fails whichever models `MOCK_FAIL` names, so the fallback chain
can be exercised without burning quota or deliberately exhausting one:

```bash
MOCK_FAIL="openai/gpt-oss-20b:429,openai/gpt-oss-120b:503" npm run mock-groq
GROQ_BASE_URL=http://localhost:4010/openai/v1 GROQ_API_KEY=test npm run dev
```

It also logs a length and checksum of message zero on every call, which is how prefix
drift gets caught without a real key.

## Staleness is the recurring failure mode in this project

Two full debugging sessions were lost to stale state, both looking exactly like a broken
fix: once an orphaned dev server still holding port 3000 while the new one silently fell
back to another port, once a browser serving a cached `widget.js`. Three guards now make
it visible:

- **The dev port is hard-coded to 3000 and never falls back.** On `EADDRINUSE` it prints
  `PORT 3000 IN USE`, points at `npm run dev:kill`, and exits non-zero.
- **`widget.js` is served `no-store` in dev**, so a plain refresh always gets current code.
  Production keeps its 5-minute cache.
- **A build hash** — first 8 hex of sha256 over the widget source, in `lib/build.js` — is
  printed on server boot, returned as `x-fs-build` from `/api/chat`, and logged by the
  widget itself. The three must agree; if the browser disagrees, it has a cached file.

The dev server prepends one `window.__FS_BUILD__` line to `widget.js` — dev only, and the
only way to make the stamp self-reporting without introducing a build step. Production
serves the file byte-for-byte and the widget logs `prod`.

## The teaser schedule is verified, not assumed

`npm run teaser-check` extracts the real scheduler out of `widget.js` and drives it
against a virtual clock. Observed, from a fresh session with no interaction:

```
   8s  SHOW  "Ask about IELTS or PTE fees"
  15s  hide
  53s  SHOW  "Confused about IELTS vs PTE? Ask us"
  60s  hide
  98s  SHOW  "Next batch timings? Ask here"
 105s  hide          -> retired for the session
```

Three bubbles at 8s / +45s / +45s, each visible exactly 7s, then done. It extracts the
functions rather than reimplementing them, because the two teaser bugs this project has
had were both schedule bugs that looked fine on inspection — a reimplementation would have
passed while the shipped widget was broken.

`retrieval-check` exits non-zero on regression, so it works as a pre-deploy gate. Run it
after **any** edit to `knowledge.json` or `retrieve.js`.

## The widget

`public/widget.js`, hand-written, zero dependencies, served as-is. One global:
`window.__fourskillsWidget`, the double-injection guard.

**`all: initial` on `:host` is what makes isolation work.** Shadow DOM blocks the host
page's selectors, but *inherited* properties — `font-family`, `line-height`, `color`,
`letter-spacing`, `text-transform` — cross the boundary regardless. The host's
`body{font-family:"Comic Sans MS";line-height:3}` would land inside the panel without it.
`all: initial` wipes the lot, then the widget declares what it needs on `.fs-root`.

**`all: initial` on `:host` is not sufficient on its own, and this bit us.** The host
element is a `<div>` in the *outer* document, and outer-document rules beat `:host` rules
regardless of specificity. So the site's `div{letter-spacing:2px}` matched the host, won
against `all: initial`, and inherited straight down into the shadow tree — every word in
the widget came out tracked out. `font-family` and `line-height` survived only because
they happened to be redeclared on `.fs-root`.

The rule that follows: **redeclare every inheritable property that matters on `.fs-root`**,
inside the shadow root, where no outer selector can reach. `letter-spacing`, `word-spacing`,
`text-transform`, `text-align`, `text-indent`, `font-style`, `font-weight`, `font-variant`,
`white-space` and `direction` are all pinned there now. If the host site adds an inheritable
property, add it there too.

The widget no longer consumes the site's colour tokens at all — it defines fixed neutrals
so it stays neutral whatever `tokens.css` does. Heebo is still inherited rather than
fetched, so `dev-test.html` loads Heebo itself and asserts `document.fonts.check` — without
that, local testing silently renders a fallback and looks nothing like production.

Other things that are load-bearing, not incidental:

- **Focus rings are declared inside the shadow root.** The host stylesheet cannot reach in
  to provide them, so if the widget doesn't define them, keyboard users get nothing. The
  composer is the one exception: its outline is suppressed and the pill border darkens
  instead, because an outline on top of the border was the doubled-border bug.
- **Assistant replies are rendered to DOM nodes, never `innerHTML`.** `renderRich` /
  `appendInline` / `appendWithLinks` support exactly three things — `**bold**`, `- ` bullet
  lines, and links — built with `createElement` and `textContent`. No markdown library.
  Model output is untrusted: parse it as HTML once and a reply containing a tag becomes
  markup on a school's website. `npm run render-check` proves this without a browser,
  including `<script>` and `<img onerror>` payloads rendering as inert text.
- **Links are allowlisted, not validated.** Only five URLs become anchors; anything else the
  model emits renders as plain text. A lookalike (`https://4skills.app.evil.com`) and a
  hallucinated path (`https://4skills.co/pricing`) are both covered by tests. An 8B model
  inventing a plausible URL is a matter of when, not whether — and a visitor cannot click
  text. `data-practice-url` is likewise assigned as a property and rejected unless `http(s)`.

  **Adding a URL the bot can share takes FOUR edits, not one:** `LINK_ALLOWLIST` in
  `public/widget.js`, its duplicates in `scripts/render-check.js` and
  `scripts/prompt-check.js`, and the link list in `lib/prompt.js` — which ends "never share
  any address other than these N" and will otherwise instruct the model to suppress the URL
  entirely, so the allowlist never even gets a chance to reject it. Miss the allowlist and
  the URL renders as dead plain text; miss the prompt and it never appears at all.
- **`role="dialog"` with a Tab trap, and deliberately no `aria-modal`.** Focus is trapped
  for keyboard users, but the host background is *not* inert — making it inert would mean
  touching the host document, which the constraints forbid. Some screen readers treat
  `aria-modal="true"` as permission to drop the rest of the page from virtual cursor
  navigation, so claiming it here would silently strand a screen-reader user inside the
  widget with no way back to the site. Do not add it back.
- **No `url()` anywhere, no `@import`, no font file.** Heebo is inherited from the host
  page. The only external URLs in the file are the practice-tests link and the WhatsApp
  fallback.
- **The gold Band Rule appears once**, on the assistant's opening message, matching the
  site's nav and success-story cards. Gold is decorative only — gold text uses
  `--fs-gold-ink`, since `--fs-gold` fails contrast on white.

**Conversation state.** `sessionStorage` under `fourskills.chat` (turns),
`fourskills.session` (lead flags) and `fourskills.sid` (session id). Every link on the PHP
site is a full page load, so without this the chat resets on any click. Not
`localStorage` — a conversation should not outlive the session. All access is wrapped in
`try`, because Safari private mode throws; without storage the widget still works, it just
forgets on navigation.

Only real turns enter `history`. The greeting is chrome — re-rendered on every restore,
never stored, never sent to the model, so it costs no tokens. Error notices and
rate-limit messages are rendered but never stored, because replaying them to the model
would have the assistant appearing to have said things it did not.

**Size budget is 35 KB gzipped, raised from 30 KB (and 20 KB before that). Raw size is unconstrained.** Gzipped is the honest number — it is what crosses the
wire, and Vercel compresses by default.

The limit lives in `SIZE_LIMIT_GZIP` in `lib/build.js`, and `npm run dev` prints the
current size as a percentage of it and marks it `*** OVER LIMIT ***` if breached.

Two things this budget explicitly does **not** license:

- **Do not split the widget into a second lazily-fetched file.** An extra request is an
  extra failure mode on a slow connection, which is the connection this audience is on.
- **Do not trim the comments to save bytes.** They compress to almost nothing, and the
  constraint that matters is that one person can open this file in a year and read it.

**The teaser.** Keys: `fourskills.teaser.done` and `fourskills.teaser.n`. Both are written
to `sessionStorage` immediately, because every link on the PHP site is a full page load —
without persisting the count, a visitor browsing five pages would get fifteen bubbles.

The restraint is the feature. Three appearances per session, in fixed order, 7s auto-hide,
and dismissing it *or* opening the chat retires it permanently for the session. It is not
`aria-live`: an unsolicited nudge announced mid-sentence is exactly the interruption the
rest of the design avoids. It is a real button, reachable by Tab.

When stored history exists at boot the rotation is suppressed entirely and replaced with a
single "Continue your chat" bubble plus a gold unread dot on the FAB, both cleared on open.
Rotating sales-shaped nudges at someone who is already mid-conversation is noise. The panel
still does **not** auto-open — that would be intrusive on every page of the site.

**Lead capture.** `api/lead.js` writes to a Google Apps Script webhook and returns a
prefilled `wa.me` link. These are deliberately independent: **a failed sheet write still
returns `ok: true` with the WhatsApp URL.** The visitor's path forward must never depend on
our logging working. `recorded` in the response says whether the sheet write succeeded and
exists for our logs, not for their journey. `docs/apps-script.gs` is the sheet side, with
setup instructions for a non-developer at the top.

Phone numbers are normalised to `+92XXXXXXXXXX` from `03XXXXXXXXX`, `+923XXXXXXXXX` and
`00923XXXXXXXXX`, separators stripped first — people type `0332-241-0155` far more often
than they type it clean. The client checks the same shapes so a typo costs no round trip,
but the server validates regardless; a client check is a convenience, never a control.
Course is an allowlist, not free text, because that string ends up in a URL and a
spreadsheet.

The form is an inline card in the message thread, **not an overlay**. The composer stays
live underneath the whole time, so a visitor who would rather keep asking questions than
hand over their number simply keeps typing. Dismissing sets `leadDeclined`, which is sent
up on every later request and hard-gates `leadPrompt` server-side for the rest of the
session — asked once, then dropped. The footer "Request a call back" link returns after a
decline, because reopening it is the visitor's choice to make, not ours.

`public/dev-test.html` is a host-page simulator: Bootstrap 5, jQuery, and deliberately
hostile CSS (`button{background:hotpink!important}`, `[hidden]{display:block!important}`,
`body{line-height:3}`). It asserts isolation in both directions at runtime and prints a
pass/fail table. `.vercelignore` keeps it off the production domain.

```bash
npm run dev     # then open http://localhost:3000/dev-test.html
```

## Known limitations, deliberately accepted

## Rate limiting is keyed on the SESSION, not the IP — and that is deliberate

| Endpoint | Per person | Per IP backstop |
|---|---|---|
| `/api/chat` | 20 per session / 10 min | 200 per IP / 10 min |
| `/api/lead` | 5 per session / hour | 3 per IP / hour |

**Do not re-key the primary limit to IP.** Pakistani mobile carriers run CGNAT: hundreds
of Jazz or Zong subscribers share one public address. A 20-per-IP cap does not stop one
abusive visitor — it locks out everyone behind a busy carrier gateway, and they get a "you
have sent a lot of messages" notice having sent nothing at all. On a Faisalabad audience
that is most of the mobile traffic.

`sessionId` is client-supplied and trivially spoofable; an abuser just rotates it. That is
precisely why the IP backstop stays. **The session key is there to be fair to real people,
the IP key is there to stop scripts, and neither is sufficient alone.** The IP check runs
first because it needs no request body, so a script is turned away before anything is
parsed.

Requests with no `sessionId` fall back to keying on the IP, so they cannot all share one
bucket.

Two limits are env-tunable: `CHAT_THROTTLE_LIMIT` (raise to 200 for a `prompt-check` run,
which makes ~32 requests) and `LEAD_IP_LIMIT`. **The lead endpoint's 3-per-IP-per-hour is
still exposed to the CGNAT problem** — a considered trade, since lead spam is worth
blocking hard, but if real leads start being refused from one carrier, raise
`LEAD_IP_LIMIT` rather than removing the session key.

- **The throttle in `guard.js` is not a real limiter.** It is an in-memory `Map` keyed by
  IP, so it resets on every cold start and is not shared across Vercel instances. It stops
  casual abuse from one browser, nothing more. `guard.js` is written so an Upstash Redis
  free tier drops in behind the same interface as a one-file change if the client ever
  needs a real one.
- No retry on network failure beyond the model fallback chain.
- `sessionStorage` means the chat survives page navigation but not a new tab.

## Open questions for the client — do NOT resolve these by guessing

The bot must never state an unconfirmed fact. Current status:

1. **Class timings conflict between the two client documents.** `FAQs.docx` Q8 gives
   IELTS evening 18:00–20:00, PTE 15:00–16:30, Spoken English 13:30–15:00, OET 16:30–18:00.
   `linksinfo.txt` gives IELTS classes at 09:00–11:00 / 11:00–13:00 / 15:00–17:00 /
   18:30–20:00, PTE at 13:00–14:30 / 17:00–18:30, and Life Skills/Spoken at 09:30–10:30
   (its second Spoken slot, "17:00 - 16:30", is a typo). These cannot both be current.
   Chase the client — it is the second-most-asked question after fees.

   Meanwhile the prompt turns the gap into the **lead-capture moment** rather than an
   "ask the office" dead end. That is intended behaviour, not a stopgap: keep it that
   way even after the real timings land, for any question about the slot of a specific
   upcoming batch. Only the office knows which batch currently has room.
2. **Course duration — resolved as 8 weeks.** `FAQs.docx` Q3 states "standard duration is
   8 weeks for all courses" explicitly. `linksinfo.txt` describes fees as a "two months"
   package, which is the same thing loosely worded. Widget says 8 weeks. Keep the `/faq`
   page on 4skills.co consistent with that.
3. **Mock-test frequency — resolved as bi-weekly.** FAQ Q2 and Q17 both say bi-weekly;
   `linksinfo.txt` says "4 Bi-weekly Mock Tests". The "weekly" claim came only from a
   student testimonial. Stated as bi-weekly in `knowledge.json`.
4. **Fees for UKVI IELTS, PTE Core, OET, Oxford ELLT, LanguageCert and IT short courses
   are NOT confirmed.** `linksinfo.txt` does contain figures (Oxford ELLT Rs 26,000 plus
   Rs 5,000 AI account; LanguageCert Rs 28,000; a Rs 7,000 PTE AI practice ID; portal at
   $25/2mo and $35/3mo) but the client's own brief lists these as unconfirmed, and the
   two documents disagree on whether the portal charge is mandatory. The bot says the
   course is offered and offers a callback. **Do not promote these figures into
   `knowledge.json` until the client confirms them in writing.**

   The PTE AI practice ID (Rs 7,000) and the 4skills.app portal subscription
   ($25 / 2 months) are **add-ons on top of the course fee**, and the two documents
   disagree on whether either is mandatory. A bot that half-states an add-on fee
   creates a billing dispute at the counter. Silence plus a callback is the safe path.
5. Three phone numbers appear in client material (0332 241 0155, 0308 677 6211,
   0313 726 9787). Only **0332 241 0155** is used, per the brief.

## Editing `knowledge.json`

Flat array of `{ id, question, answer, keywords, category }`. Retrieval is keyword
scoring in `lib/retrieve.js`: the user's message is lowercased and stripped of
punctuation, then scored on term overlap against `question` + `keywords`, with
`keywords` weighted 2×. Top 4 above a floor score are passed to the model; if nothing
clears the floor, no FAQ context is sent and the system prompt's fallback rules handle it.

**Keywords must include Roman Urdu.** This is a Faisalabad audience and a meaningful
share of enquiries arrive as `kitna`, `kitne`, `fees kya hai`, `kab shuru`,
`admission kaise`, `kahan`. A pure-English keyword list silently misses them.

The seed set covers the enquiry-shaped questions (fees, timings, location, enrolment,
duration, batch size, mocks, IELTS vs PTE, online, results). The teaching-methodology
questions from `FAQs.docx` (Q18, Q20–Q21, Q24–Q25, Q27–Q28) are lower frequency for an
admissions bot and can be appended later as a pure data change.

## Build phases

1. ✅ Scaffold — repo, `vercel.json`, `.env.example`, `CLAUDE.md`, seeded `knowledge.json`
2. ✅ Backend — `groq.js`, `retrieve.js`, `prompt.js`, `guard.js`, `api/chat.js`.
   Fallback chain, origin checks, throttle, validation and marker handling all verified
   against a mock Groq. `npm run prompt-check` is written but **still pending a real
   `GROQ_API_KEY`** — no model behaviour has been observed yet.
3. ✅ Widget shell — shadow DOM, launcher cluster, practice-tests pill, panel, keyboard/focus.
   Replies come from `stubReply()`; no network calls yet.
4. ✅ Wire up chat — real API calls, history, sessionStorage, error states, starter chips
5. ✅ Teaser — timing, rotation, dismissal, reduced-motion, plus the resume state
   (unread dot + "Continue your chat") when a stored conversation exists at boot
6. ✅ Lead capture — `api/lead.js`, Apps Script sheet, form, WhatsApp handoff
7. ✅ Harden and hand over — origin checks verified (including lookalike domains), throttle
   in place, no key client-side, non-developer README written

## Known model behaviour, measured over three full prompt-check runs

Fixed and holding at 0/3 failures: band figures anywhere, word-count overage, language
drift, degraded responses, fallback to a non-primary model.

**Fixed by removing an instruction conflict: the missing fast-track offer.** For three runs
the bot answered "my IELTS test is in 5 weeks" with "Academic or General Training?" and
never mentioned fast-track. Four prompt strengthenings did not move it, because the model
was not disobeying — it was obeying. Two rules governed the same moment: `Never` said "ask
which test first", `Recommending` said "mention the fast-track option", and it resolved the
conflict in favour of the more explicit one. The fix was to merge them into a single rule
that asks *and* mentions fast-track in the same reply, and to leave `Never` as a pure
prohibition pointing at it.

Worth generalising: **before strengthening a rule, check whether a second rule is competing
with it.** Adding force to one side of a contradiction just makes the model pick harder.

**Fixed by data, not by prompting: the acceptance liability.** The bot was asserting
"Sheffield University accepts PTE Academic" in 2 of 3 runs. The prompt rule forbidding it
was ignored. The actual cause was that retrieval had nothing to offer on acceptance
questions, so the model filled the gap — `pte-fee` outscored everything because the course
name covered more of the query than the acceptance verb did. Adding the `test-acceptance`
entry, with `accept ielts` / `accept pte` style phrases so the verb can compete, fixed it.

The general lesson, worth remembering before editing the prompt again: **when this model
invents something, check first whether retrieval left it with nothing to say.** A prompt
rule tells it what not to do; a knowledge entry tells it what to do instead, and the second
works far better on an 8B model.

**Prompt size is now the tightest number in the project.** Measured on the 17 Aug 2026 run:
whole requests are **3,550–3,823 tokens (mean 3,652)**, up from ~2,000 before the rules and
worked examples were added, and counted by a different tokenizer than the old figures were.

At the **8,000 TPM** ceiling that is **two concurrent requests per minute**, down from three.
Two visitors typing at the same moment is now the limit, and a third gets the fallback chain.

Before adding another rule or worked example, delete one. The prompt has roughly doubled
across this project's life and every addition is now paid for in concurrency. If a
behaviour needs fixing, prefer a `knowledge.json` entry — it costs ~40 tokens on the
requests that retrieve it and **zero on the ones that don't**, whereas a prompt rule is
charged on every single request forever.

## Do not

- Do not add a build step, bundler, or framework to the widget.
- Do not add a database, auth, or user accounts.
- Do not stuff all FAQ entries into the prompt.
- Do not invent any fact — no "typical" durations, "usual" batch start dates, or
  accreditation claims beyond what the client documents state.
- Do not put the Groq key anywhere client-side.
- Do not let the teaser reappear after dismissal.
- Do not write marketing copy in the bot's voice. It answers questions.
