// npm run prompt-check   — REQUIRES A REAL GROQ_API_KEY
//
// The §6 prompt-behaviour acceptance tests. Each case is a specific behaviour
// the system prompt is supposed to produce, not a smoke test.
//
//   1. put a real key in .env.local
//   2. npm run dev            (in another terminal)
//   3. npm run prompt-check
//
// Mechanical checks (word count, forbidden fee figures, invented clock times,
// band figures, [[LEAD]] leakage) are asserted automatically and print PASS or
// FAIL. Cases that need a human read — tone, language matching, whether a
// refusal is graceful — print REVIEW with the full reply. An LLM assertion
// suite that claims to auto-grade those is lying to you.
//
// PACING. Requests are spaced REQUEST_GAP_MS apart, 32s by default.
//
// Derived, not guessed: the chain's TPM ceiling divided by the measured mean
// request size. As of Aug 2026 that is 8,000 TPM and ~3,800 tokens per request,
// so ~2.1 requests per minute, so ~29s minimum — 32s carries the jitter.
//
// THIS NUMBER GOES STALE, twice over: the prompt grows, and the chain changes.
// It has already been wrong both ways — 20s when the prompt doubled (the suite
// drew 429s and silently measured a fallback model instead of the primary), and
// 40s after the ceiling rose from 6,000 to 8,000 (correct, just slow).
//
// TO RE-DERIVE: every run prints its mean prompt tokens and warns if any request
// was served by a non-primary model. Take the TPM ceiling from CLAUDE.md, divide
// by (mean + ~150 completion), and that is your requests per minute.
//
// Override with PROMPT_CHECK_GAP=0 only when pointed at a mock.
//
// THROTTLE. A full run is ~32 requests from one IP; api/chat.js allows 20 per
// 10 minutes. Start the dev server with CHAT_THROTTLE_LIMIT=200 for a suite run.

import { models } from '../lib/groq.js';

const BASE = process.env.CHECK_URL || 'http://localhost:3000';
const ORIGIN = process.env.CHECK_ORIGIN || 'http://localhost:3000';
const REQUEST_GAP_MS =
  process.env.PROMPT_CHECK_GAP !== undefined ? Number(process.env.PROMPT_CHECK_GAP) : 32000;

// Read the real chain rather than restating it. This constant used to hardcode
// `llama-3.1-8b-instant` as its default, and when that model was decommissioned
// the suite would have reported every single request as "non-primary".
const PRIMARY_MODEL = models()[0];

const RS = /\bRs\.?\s?\d{1,3}(,\d{3})+|\b\d{2},000\b/g;
const CLOCK = /\b\d{1,2}[:.]\d{2}\s?(am|pm)?\b/gi;
const ALLOWED_CLOCK = new Set(['9:00', '8:00', '11:00', '4:00', '09:00', '04:00']);

// Band figures. Checked on EVERY reply, not just the band-prediction case —
// knowledge.json no longer contains a single band number, so one appearing
// anywhere means the model invented it.
const BAND_RANGE = /\d\.\d\s*[-–—]\s*\d\.\d/;
const BAND_SINGLE = /\b[4-9]\.\d\b/;

// Hedge markers, English AND Roman Urdu. The English-only version false-failed a
// perfectly good reply — "Aapko unke consultant se puchhna chahiye ki ve PTE
// accept karte hain ya nahin" is hedged three ways over and contains not one
// English hedge word. The bot is expected to answer in Roman Urdu; the checks
// have to be able to read it.
const HEDGE =
  /confirm|check|cannot|can't|not sure|unable|may |might |should |whether|if they|chahiye|puchh|puch|pooch|pata kar|ya nahi|ya nahin|karna hoga|consult/i;

// Distinctive Roman Urdu tokens. Short particles (ka, ke, ki, se) are left out
// deliberately — they collide with English fragments and inflate the count.
const URDU_MARKERS =
  /\b(aap|aapko|aapki|hain|karna|karne|kijiye|nahi|nahin|chahiye|sakte|sakta|sakti|hoga|hogi|bataunga|kitna|kitni|kitne|kaise|kahan|hafton|hafte|zaroorat|liye|behtar|rahega|seekhna|puchhna)\b/gi;
const URDU_THRESHOLD = 3;

function looksRomanUrdu(text) {
  return (text.match(URDU_MARKERS) || []).length >= URDU_THRESHOLD;
}

const CASES = [
  {
    name: 'Roman Urdu fee question',
    messages: ['ielts ki fees kitni hai'],
    lang: 'ur',
    must: [/35,000/],
    review: 'Reply should be in Roman Urdu and ask what the test is for.',
  },
  {
    name: 'Unconfirmed IT course fee',
    messages: ['how much is the web development course'],
    lang: 'en',
    mustNotFee: true,
    must: [/0332\s?241\s?0155|call|callback|call back|office/i],
    review: 'Must NOT state a fee. Should offer a callback.',
  },
  {
    name: 'Unknown class timing',
    messages: ['what time is the evening batch'],
    lang: 'en',
    mustNotInventClock: true,
    review: 'Must NOT invent a slot time. Should turn the gap into a callback offer.',
  },
  {
    name: 'Deadline without a named test',
    messages: ['my test is in 5 weeks'],
    lang: 'en',
    mustNot: [/\bIELTS\b|\bPTE\b|\bOET\b/],
    review: 'Visitor named no test. Must ask WHICH test before recommending one.',
  },
  {
    name: 'Named test plus deadline surfaces fast-track',
    messages: ['my IELTS test is in 5 weeks'],
    lang: 'en',
    must: [/fast.?track|double class|one month/i],
    review: 'Test is named, so fast-track is fair game here.',
  },
  {
    name: 'Spouse visa -> Life Skills A1',
    messages: ["I need A1 for my wife's visa"],
    lang: 'en',
    must: [/26,000/, /life skills/i],
    mustNot: [/you (will|should) (get|apply|qualify)/i],
    review: 'Recommends Life Skills A1 at Rs 26,000. Gives NO visa advice.',
  },
  {
    name: 'University acceptance is not ours to answer',
    messages: ['will Sheffield accept PTE'],
    lang: 'en',
    must: [/confirm|check with|university|admissions office|consultant/i],
    hedgedAcceptance: true,
    review: 'Declines to confirm acceptance, redirects to the university, keeps helping.',
  },
  {
    name: 'Refuses to review writing',
    messages: ['can you check my essay: Many people thinks that education are important'],
    mustNot: [/corrected version|should be written|grammar mistake/i, /send (it|me)|share it|paste/i],
    must: [/class|trainer|feedback is given|in class/i],
    review: 'Declines to review. Must NOT offer to receive it. Says feedback is given in class.',
  },
  {
    name: 'Refuses to predict a band',
    messages: ['what band will I get if I join'],
    lang: 'en',
    mustNot: [/\bband\s?[4-9](\.\d)?\b/i],
    review: 'Declines to predict any score, and quotes no past-student figures either.',
  },
  {
    name: 'Refuses typical/average student results',
    messages: ['what band do most of your students get'],
    lang: 'en',
    review: 'Must NOT quote 7.0, 7.5 or any range. May point at the success stories page.',
  },
  {
    name: 'Vague opener gets the purpose question, not an acknowledgement',
    messages: ['I want to learn english'],
    must: [/\?/],
    review: 'Must ask the single purpose question. Not "sure, I can help with that."',
  },
  // English is the default. A greeting carries no language signal, so guessing
  // Urdu from "salam" is a worse answer than not guessing.
  // A greeting must not be answered with the address or a fee. Retrieval used
  // to hand "hi" the location entry, so every greeting opened with the office
  // address; retrieval is now skipped entirely for greeting-only input.
  {
    name: 'Greeting "hi" — English, no address, no fee',
    messages: ['hi'],
    lang: 'en',
    mustNot: [/Kohinoor|Jaranwala|96-97A|Faisalabad/i, /Rs\s?\d/, /\d{2},000/],
  },
  {
    name: 'Greeting "hello" — English, no address, no fee',
    messages: ['hello'],
    lang: 'en',
    mustNot: [/Kohinoor|Jaranwala|96-97A|Faisalabad/i, /Rs\s?\d/, /\d{2},000/],
  },
  {
    name: 'Greeting "salam" — English, no address, no fee',
    messages: ['salam'],
    lang: 'en',
    mustNot: [/Kohinoor|Jaranwala|96-97A|Faisalabad/i, /Rs\s?\d/, /\d{2},000/],
  },
  {
    name: 'Roman Urdu question is answered in Roman Urdu',
    messages: ['fees kitni hai'],
    lang: 'ur',
  },
  {
    name: 'Multi-fact answer uses bullets — course info',
    messages: ['i need info about ielts'],
    lang: 'en',
    must: [/35,000/],
    minBullets: 2,
    minBold: 1,
    review: 'Lead-in, blank line, bullets, blank line, closing question.',
  },
  {
    name: 'Multi-fact answer uses bullets — course list',
    messages: ['what courses do you offer'],
    lang: 'en',
    minBullets: 2,
    minBold: 1,
    review: 'A list of courses is a list. Never a paragraph.',
  },
  {
    name: 'Multi-fact answer uses bullets — fees',
    messages: ['what are your fees'],
    lang: 'en',
    minBullets: 2,
    minBold: 1,
    review: 'Five fees is five bullets, with the course and fee bolded.',
  },
  {
    name: 'Location is structured, not a paragraph',
    messages: ['where is your location'],
    lang: 'en',
    minBullets: 2,
    review: 'Even an address is a list. Lead-in, bullets, closing.',
  },
  {
    name: 'Timings are structured',
    messages: ['what are your timings'],
    lang: 'en',
    minBullets: 2,
    review: 'Days and hours are separate facts.',
  },
  {
    name: 'Enrolment steps are structured',
    messages: ['how do I enrol'],
    lang: 'en',
    minBullets: 2,
    review: 'Three steps is three bullets.',
  },
  {
    name: 'Roman Urdu multi-fact answer uses bullets too',
    messages: ['ielts ki fees kitni hai'],
    lang: 'ur',
    must: [/35,000/],
    minBullets: 2,
    review: 'Bullets are not an English-only format.',
  },
  {
    name: 'Course answer carries the practice link — ielts academic',
    messages: ['ielts academic'],
    lang: 'en',
    must: [/https:\/\/4skills\.app/],
    review: 'Course answers end with the practice-tests link.',
  },
  {
    name: 'Course answer carries the practice link — tell me about pte',
    messages: ['tell me about pte'],
    lang: 'en',
    must: [/https:\/\/4skills\.app/, /28,000/],
    review: 'Course answers end with the practice-tests link.',
  },
  {
    name: 'Practice-test question surfaces 4skills.app',
    messages: ['where can I do practice tests'],
    lang: 'en',
    must: [/https:\/\/4skills\.app/],
    review: 'Must link the practice portal.',
  },
  {
    name: 'Unanswerable question surfaces the FAQ page and invents nothing',
    messages: ['do you have a hostel or accommodation for students'],
    lang: 'en',
    must: [/https:\/\/4skills\.co\/faq|0332\s?241\s?0155/],
    // It previously answered this by offering to help find somewhere to stay —
    // a service 4Skills does not provide and was never told about.
    mustNot: [/we can help you find|recommend|recommendations|arrange|assist you (in|with) find/i],
    review: 'Cannot answer this. Points at /faq or the phone. Offers no invented service.',
  },
  {
    name: 'Answer first, and never re-ask what was already answered',
    messages: ['ielts', null, 'IELTS fees'],
    lang: 'en',
    must: [/35,000/],
    mustNot: [/study abroad|what is it for|what.s it for|purpose|kis liye/i],
    answerFirst: true,
    review: 'Second reply leads with the fee. The purpose question must NOT come back.',
  },
  {
    name: 'Direct question is answered before anything else',
    messages: ['what are your class timings'],
    lang: 'en',
    answerFirst: true,
    review: 'Must not open with a question of its own.',
  },
  {
    name: 'Named course means no purpose question at all',
    messages: ['how much is PTE Academic'],
    lang: 'en',
    must: [/28,000/],
    mustNot: [/study abroad|what is it for|purpose/i],
    answerFirst: true,
    review: 'They named the course. Answer and stop.',
  },
  {
    // The model wrote "Name: ______" as literal text instead of emitting the
    // marker — a form nobody can fill in, collecting nothing.
    name: 'Lead ask opens the real form, never a typed one',
    messages: ['how do I enrol', null, 'yes'],
    lang: 'en',
    wantsLeadMarker: true,
    maxWords: 25,
    mustNot: [/_{3,}/, /Name\s*:/i, /Phone\s*(Number)?\s*:/i],
    review: 'One short sentence, then the form opens. No typed fields.',
  },
  {
    name: 'Declining a lead ask is respected',
    messages: ['how do I enrol', null, 'no thanks, just browsing for now'],
    mustNot: [/name and (phone|number)|contact number|leave your/i],
    review: 'Must NOT ask for the number again after a decline.',
  },
];

const WORD_LIMIT = 110;
// A reply that lists four or more courses is allowed 140. Listing every course
// honestly costs words; the alternative is omitting courses or dropping the
// "fee confirmed by the office" caveat, both of which are worse than being long.
const WORD_LIMIT_LIST = 140;
const LIST_THRESHOLD = 4;

// The only four URLs the assistant may share. The widget refuses to linkify
// anything else, so a stray URL is not clickable — but it still reaches the
// visitor as text, and a hallucinated address in a fee answer is a support
// call. Checked on every reply.
const LINK_ALLOWLIST = [
  'https://4skills.app',
  'https://www.youtube.com/@4SKILLS256',
  'https://4skills.co/faq',
  'https://4skills.co/success-stories-ielts',
];
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"']+/g;

function offAllowlistUrls(text) {
  return (text.match(URL_PATTERN) || [])
    .map((u) => u.replace(/[.,;:!?]+$/, ''))
    .filter((u) => !LINK_ALLOWLIST.includes(u));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let requestCount = 0;
const modelsSeen = new Map();
const promptTokens = [];

async function send(messages, session = {}, { nopace = false } = {}) {
  // Space requests so the TPM ceiling does not turn this into a fallback-chain test.
  if (!nopace && lastRequestAt && REQUEST_GAP_MS > 0) {
    const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) {
      process.stdout.write(`   …pacing ${Math.ceil(wait / 1000)}s\r`);
      await sleep(wait);
      process.stdout.write('                    \r');
    }
  }
  lastRequestAt = Date.now();
  requestCount++;

  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ messages, sessionId: 'prompt-check', session }),
  });
  const body = await res.json();

  const model = res.headers.get('x-fs-model');
  if (model) modelsSeen.set(model, (modelsSeen.get(model) || 0) + 1);

  const tokens = Number(res.headers.get('x-fs-tokens') || 0);
  if (tokens) promptTokens.push(tokens);

  return {
    status: res.status,
    body,
    model,
    retrieved: res.headers.get('x-fs-retrieved'),
    tokens,
    cached: Number(res.headers.get('x-fs-cached') || 0),
  };
}

let pass = 0;
let fail = 0;
let degraded = 0;
let throttled = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`   PASS  ${label}`);
  } else {
    fail++;
    console.log(`   FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

console.log(`\nprompt-check against ${BASE}`);
console.log(`primary model: ${PRIMARY_MODEL}   pacing: ${REQUEST_GAP_MS / 1000}s between requests`);
console.log('='.repeat(66));

for (const c of CASES) {
  console.log(`\n${c.name}`);

  // Earlier turns are run for real so multi-turn cases carry genuine assistant
  // replies rather than fabricated ones.
  const turns = [];
  let last = null;
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m === null) {
      turns.push({ role: 'assistant', content: last.body.reply });
      continue;
    }
    turns.push({ role: 'user', content: m });
    if (i < c.messages.length - 1) last = await send(turns);
  }

  const out = await send(turns);
  const reply = out.body.reply || '';
  const words = reply.trim().split(/\s+/).filter(Boolean).length;

  console.log(`   > ${c.messages.filter(Boolean).join('  |  ')}`);
  console.log(`   ${reply.replace(/\n/g, '\n   ')}`);
  console.log(
    `   [${out.model} · ${words}w · retrieved: ${out.retrieved} · ${out.tokens}tok ${out.cached}cached]`,
  );

  /*
   * A degraded reply is the fallback chain having exhausted itself — every
   * model 429'd or errored. It is canned copy, not model output, so asserting
   * prompt behaviour against it is meaningless. Scoring it as prompt failures
   * is worse than meaningless: it sends you editing the prompt to fix a rate
   * limit. Report it as infrastructure and move on.
   */
  // Our own per-IP limiter, not Groq. Worth separating: the fix is a server
  // env var, and the previous message sent you to change the pacing instead.
  if (out.status === 429 || (out.body && out.body.error === 'rate_limited')) {
    throttled++;
    console.log("   ERROR  hit THIS WIDGET'S OWN throttle, not Groq — assertions skipped");
    console.log('          restart the dev server with CHAT_THROTTLE_LIMIT=200');
    continue;
  }

  if (out.body.degraded || out.model === 'none' || !out.model) {
    degraded++;
    console.log('   ERROR  degraded response — no model served this turn, assertions skipped');
    console.log('          every model in the chain failed; raise PROMPT_CHECK_GAP');
    continue;
  }

  const bulletCount = reply.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  const limit = bulletCount >= LIST_THRESHOLD ? WORD_LIMIT_LIST : WORD_LIMIT;
  check(
    `under ${limit} words${limit === WORD_LIMIT_LIST ? ' (list answer)' : ''}`,
    words <= limit,
    `${words} words, ${bulletCount} bullets`,
  );

  // Rule 5, "match the visitor's language", previously had zero coverage — and
  // the bot does drift into Roman Urdu on English questions.
  if (c.lang) {
    const isUrdu = looksRomanUrdu(reply);
    check(
      c.lang === 'ur' ? 'replies in Roman Urdu' : 'replies in English',
      c.lang === 'ur' ? isUrdu : !isUrdu,
      isUrdu ? 'reply reads as Roman Urdu' : 'reply reads as English',
    );
  }
  check('no [[LEAD]] in reply', !/\[\[\s*LEAD\s*\]\]/i.test(reply));

  // The marker is stripped before the reply is returned, so its presence is
  // observable only through leadPrompt — which is what actually opens the form.
  if (c.wantsLeadMarker) {
    check('lead form was triggered (leadPrompt true)', out.body.leadPrompt === true,
      'leadPrompt=' + out.body.leadPrompt);
  }
  if (c.maxWords) {
    check(`under ${c.maxWords} words`, words <= c.maxWords, `${words} words`);
  }

  // Global, every case: no band figure may appear anywhere, ever.
  const bandHit = reply.match(BAND_RANGE) || reply.match(BAND_SINGLE);
  check('states no band figure or range', !bandHit, bandHit ? bandHit[0] : '');

  // Global, every case: no URL outside the allowlist.
  const strayUrls = offAllowlistUrls(reply);
  check('shares no URL outside the allowlist', strayUrls.length === 0, strayUrls.join(', '));

  for (const re of c.must || []) check(`contains ${re}`, re.test(reply));
  for (const re of c.mustNot || []) check(`does not contain ${re}`, !re.test(reply));

  if (c.mustNotFee) {
    const fees = reply.match(RS) || [];
    check('states no fee figure', fees.length === 0, fees.join(', '));
  }
  /*
   * "Sheffield University accepts PTE Academic." passed the old assertion,
   * because the sentence AFTER it said "best to confirm with them" and the
   * `must` regex only looked at the whole reply. A flat claim followed by a
   * hedge is still a flat claim.
   *
   * So: any sentence that asserts acceptance must carry its own hedge.
   */
  if (c.hedgedAcceptance) {
    const unhedged = reply
      .split(/(?<=[.?!])\s+/)
      .filter((s) => /\baccepts?\b|\baccepted\b/i.test(s))
      .filter((s) => !HEDGE.test(s));
    check('no unhedged acceptance claim', unhedged.length === 0, unhedged.join(' | '));
  }
  if (c.minBullets) {
    const bullets = reply.split('\n').filter((l) => /^\s*-\s+\S/.test(l)).length;
    check(`uses at least ${c.minBullets} bullet lines`, bullets >= c.minBullets, `${bullets} found`);
  }
  if (c.minBold) {
    const bold = (reply.match(/\*\*[^*]+\*\*/g) || []).length;
    check(`uses at least ${c.minBold} bold span`, bold >= c.minBold, `${bold} found`);
  }

  // "Answer first" is checkable: the opening sentence must not be a question.
  if (c.answerFirst) {
    const first = (reply.split(/(?<=[.?!])\s+/)[0] || '').trim();
    check('does not open with a question', !first.endsWith('?'), first);
  }
  if (c.mustNotInventClock) {
    const times = (reply.match(CLOCK) || []).filter(
      (t) => !ALLOWED_CLOCK.has(t.replace(/\s?(am|pm)/i, '')),
    );
    check('invents no class time', times.length === 0, times.join(', '));
  }
  if (c.review) console.log(`   REVIEW  ${c.review}`);
}

/*
 * Prompt cache.
 *
 * Two requests with a byte-identical payload, shaped exactly like a widget
 * request. The earlier version of this test sent a bare one-message array whose
 * retrieval pulled a larger reference block (~1,580 prompt tokens) than any real
 * turn (~1,440–1,500), so it was not measuring the shape production actually
 * sends.
 *
 * Three things are asserted, in order of what they would tell you:
 *   1. both requests report the same prompt_tokens — if not, something varies
 *      per request and the cached prefix is broken by construction
 *   2. both were served by the same model — a fallback mid-test makes the
 *      cached-token comparison meaningless, not failing
 *   3. the second reports cached tokens — Groq caches in blocks, so expect a
 *      round number like 512 or 1024 rather than the full prefix
 *
 * The pair fires BACK TO BACK, deliberately bypassing the 20s pacing. Groq's
 * cache TTL is short enough that a 20s gap evicts the prefix, so a paced pair
 * reports 0 cached and tells you nothing about whether caching works. The
 * normal gap is still taken before the pair, so the burst does not draw a 429.
 */
console.log(`\nprompt cache`);
const warm = [{ role: 'user', content: 'ielts ki fees kitni hai' }];
const first = await send(warm);
const second = await send(warm, {}, { nopace: true });

console.log(`   first:  ${first.tokens} prompt tokens, ${first.cached} cached  [${first.model}]`);
console.log(`   second: ${second.tokens} prompt tokens, ${second.cached} cached  [${second.model}]`);

check('both served by the same model', first.model === second.model,
  `${first.model} vs ${second.model}`);

if (first.model === second.model) {
  check('identical payloads produce identical prompt tokens', first.tokens === second.tokens,
    `${first.tokens} vs ${second.tokens}`);
  check('second identical request reports cached tokens', second.cached > 0);
} else {
  // Different models tokenise differently, so 3567 vs 3570 across a fallback
  // says nothing about prefix stability — it is the SAME payload counted by two
  // different tokenisers. Asserting it produced a failure that looked like
  // prompt drift and was not.
  console.log('   SKIP  token-equality and cached-token checks (models differed,');
  console.log('         different tokenisers make the comparison meaningless)');
}

/* --------------------------------------------------------------- summary */

console.log(`\n${'='.repeat(66)}`);

const nonPrimary = [...modelsSeen].filter(([m]) => m !== PRIMARY_MODEL);
if (nonPrimary.length) {
  const served = nonPrimary.reduce((n, [, c]) => n + c, 0);
  console.log(
    `WARNING: ${served}/${requestCount} requests were served by a NON-PRIMARY model ` +
      `(${nonPrimary.map(([m, c]) => `${m}×${c}`).join(', ')}).`,
  );
  console.log(
    '         The fallback chain fired, so those results describe a model that is not',
  );
  console.log(
    '         the one production will use. Increase PROMPT_CHECK_GAP and re-run.',
  );
} else {
  console.log(`All ${requestCount} requests served by ${PRIMARY_MODEL}.`);
}

if (promptTokens.length) {
  console.log(
    `Prompt tokens: ${Math.min(...promptTokens)}–${Math.max(...promptTokens)} ` +
      `(mean ${Math.round(promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length)}).`,
  );
}

if (throttled) {
  console.log(
    `${throttled} case(s) hit the widget's OWN rate limit and were not scored. ` +
      `Restart the dev server with CHAT_THROTTLE_LIMIT=200 and re-run.`,
  );
}
if (degraded) {
  console.log(
    `${degraded} case(s) got a DEGRADED response and were not scored. Those are rate ` +
      `limits, not prompt problems — re-run before drawing conclusions.`,
  );
}
console.log(`${pass} passed, ${fail} failed. REVIEW lines need a human read.\n`);
process.exit(fail || degraded || throttled ? 1 : 0);
