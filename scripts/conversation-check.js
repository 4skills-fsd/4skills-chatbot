// npm run conversation-check
//
// MULTI-TURN tests. This suite exists because a 209-case single-turn suite
// passed green while every real conversation broke on turn 4.
//
// The transcript that prompted it, five model calls in about ninety seconds:
//
//   "class timings"  -> correct answer
//   "courses"        -> correct answer
//   "ielts academic" -> correct answer, ending with the call offer
//   "yes"            -> "I cannot reach the assistant at the moment..."
//   "hi"             -> "I will arrange a call for you to discuss batch details."
//   "yes"            -> "I will have someone call you..."   (form never opened)
//
// Two separate defects, neither visible one turn at a time. The failed "yes"
// was written to history anyway, so "hi" was answered as if it were that "yes";
// and the form never opened because it depended on the model reproducing a
// marker it had paraphrased away.
//
// The widget is an IIFE with no exports, so the functions under test are
// extracted from source the same way render-check does it — duplicating them
// here would let the test pass while the shipped widget drifted.

import { readFileSync } from 'node:fs';
import { classify } from '../lib/groq.js';

const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

let fail = 0;
function check(label, ok, detail = '') {
  if (!ok) fail++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
}

// --- constants read out of widget.js, never redeclared ----------------------

const SEND_WINDOW = Number(src.match(/var SEND_WINDOW = (\d+);/)[1]);
const AFFIRMATIVE_MAX_CHARS = Number(src.match(/var AFFIRMATIVE_MAX_CHARS = (\d+);/)[1]);
const AFFIRMATIVE = JSON.parse(
  '[' + src.match(/var AFFIRMATIVE = \[([\s\S]*?)\];/)[1].replace(/'/g, '"') + ']',
);

// --- a harness that drives the real send path -------------------------------
//
// outbound() and acceptsOffer() are lifted from widget.js and given the same
// closure variables the widget gives them. Everything else is a stub thin
// enough that a failure here means the logic is wrong, not the stub.

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

function makeWidget() {
  const state = {
    history: [],
    pendingUser: null,
    flags: {},
    MAX_HISTORY: 20,
    calls: [],          // every /api/chat payload that would have been sent
    formOpens: 0,
    rendered: [],       // what the visitor sees
  };

  const fn = new Function(
    'state', 'SEND_WINDOW', 'AFFIRMATIVE', 'AFFIRMATIVE_MAX_CHARS',
    `
    var history = state.history;
    var pendingUser = state.pendingUser;
    var flags = state.flags;
    var MAX_HISTORY = state.MAX_HISTORY;
    function sync() { state.history = history; state.pendingUser = pendingUser; }
    ${grab('outbound')}
    ${grab('lastAssistant')}
    ${grab('acceptsOffer')}
    return {
      outbound: function () { return outbound(); },
      acceptsOffer: function (t) { return acceptsOffer(t); },
      setPending: function (p) { pendingUser = p; sync(); },
      getPending: function () { return pendingUser; },
      push: function (m) { history.push(m); sync(); },
    };
    `,
  );
  const w = fn(state, SEND_WINDOW, AFFIRMATIVE, AFFIRMATIVE_MAX_CHARS);

  // The send path, mirroring submit() -> ask() -> receive().
  function send(text, response) {
    state.rendered.push({ who: 'user', text });

    // submit(): the interception counts only if the form actually rendered.
    // showLeadForm() returns false when a card is already open or the lead was
    // already captured — and then the turn MUST fall through to the model.
    const formWouldShow = !state.leadCardOpen && !state.flags.leadCaptured;
    if (w.acceptsOffer(text) && formWouldShow) {
      w.push({ role: 'user', content: text });
      state.formOpens++;
      state.leadCardOpen = true;
      state.flags.leadAsked = true;
      return { calledApi: false };
    }

    w.setPending({ role: 'user', content: text });
    state.calls.push(w.outbound());

    const r = response || { status: 200, body: { reply: 'ok', offer: false } };
    const body = r.body;

    if (!body || typeof body.reply !== 'string' || body.degraded || r.status !== 200) {
      w.setPending(null);                       // dropPending()
      state.rendered.push({ who: 'bot', text: body && body.reply, error: true });

      // receive(): the outage lead form, rate_limit only.
      if (body && body.degraded && body.errorKind === 'rate_limit' && !state.flags.leadDeclined) {
        state.formOpens++;
        state.formTitle = 'Leave your name and number and the team will call you back.';
        state.flags.leadAsked = true;
      }
      return { calledApi: true, committed: false };
    }

    const p = w.getPending();
    if (p) { w.push(p); w.setPending(null); }
    state.rendered.push({ who: 'bot', text: body.reply });
    w.push({ role: 'assistant', content: body.reply, offer: !!body.offer });
    return { calledApi: true, committed: true };
  }

  return { state, send, w };
}

const ok200 = (reply, offer = false) => ({ status: 200, body: { reply, offer } });
const degraded = (kind) => ({
  status: 200,
  body: {
    reply: 'I cannot reach the assistant at the moment. Please WhatsApp 0332 241 0155...',
    degraded: true,
    errorKind: kind,
  },
});

// --- 1. mid-conversation 429 on the first model -----------------------------
//
// Per-model limits mean the chain advancing IS the fix. The visitor should
// never learn that the first model refused.

console.log('\nchain advances on 429, visitor sees a normal reply');
{
  check(
    'three 429s classify as rate_limit',
    classify([
      { model: 'openai/gpt-oss-20b', status: 429 },
      { model: 'openai/gpt-oss-120b', status: 429 },
      { model: 'qwen/qwen3.6-27b', status: 429 },
    ]) === 'rate_limit',
  );
  check(
    'a 429 then a success is not a failure at all',
    classify([{ model: 'a', status: 429 }, { model: 'b', status: 200 }]) === 'rate_limit',
    'classify only ever sees the failed set',
  );
  const { state, send } = makeWidget();
  send('class timings', ok200('Classes run 9am to 8pm.'));
  const r = send('courses', ok200('We offer IELTS, PTE and Spoken English.'));
  check('turn served after a chain advance is committed', r.committed === true);
  check('history holds both exchanges', state.history.length === 4);
}

// --- 2. all three models 429 ------------------------------------------------
//
// The defect that produced the transcript. The failed turn must not survive
// into the next payload.

console.log('\nall three models fail — failed turn never reaches the next payload');
{
  const { state, send } = makeWidget();
  send('ielts academic', ok200('IELTS Academic is Rs 35,000. Shall I have someone call you?', true));
  const bad = send('yes I want to know about the UKVI fee too', degraded('rate_limit'));
  check('failed turn is not committed', bad.committed === false);

  send('hi', ok200('Hello! How can I help?'));
  const payload = state.calls[state.calls.length - 1];
  const carried = payload.some((m) => /UKVI fee too/.test(m.content));
  check('orphaned user turn is absent from the next payload', !carried,
    carried ? JSON.stringify(payload) : '');
  check('the next payload ends with the real message',
    payload[payload.length - 1].content === 'hi');
  check('degraded reply was never stored as an assistant turn',
    !state.history.some((m) => /cannot reach the assistant/.test(m.content)));
  check('the visitor still SEES their own failed message',
    state.rendered.some((m) => m.who === 'user' && /UKVI fee too/.test(m.text)));
}

// --- 3. offer -> short affirmative opens the form with no model call --------

console.log('\noffer + short affirmative opens the form locally');
for (const word of ['yes', 'Yes!', 'sure', 'Sure.', 'haan', 'ji haan', 'ok', 'theek hai', 'yes please', 'CALL ME']) {
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  const before = state.calls.length;
  const r = send(word, null);
  check(
    `"${word}" opens the form with zero /api/chat calls`,
    r.calledApi === false && state.formOpens === 1 && state.calls.length === before,
  );
}

console.log('\ngates on the local path');
{
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  state.flags.leadDeclined = true;
  const r = send('yes', ok200('No problem.'));
  check('a declined visitor is not re-prompted locally',
    r.calledApi === true && state.formOpens === 0);
}
{
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000 for IELTS Academic.', false));
  const r = send('yes', ok200('Sure — what would you like to know?'));
  check('"yes" with NO preceding offer goes to the model',
    r.calledApi === true && state.formOpens === 0);
}

// --- 4. offer -> long qualified reply still goes to the model ---------------

console.log('\noffer + a qualified reply still goes to the model');
for (const text of [
  'yes but what about the UKVI fee',
  'yes, and can I pay in instalments?',
  'ok but only after 6pm please',
]) {
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  const r = send(text, ok200('The UKVI fee is confirmed by the office.'));
  check(`"${text.slice(0, 34)}..." goes to the model`,
    r.calledApi === true && state.formOpens === 0,
    text.length > AFFIRMATIVE_MAX_CHARS ? 'over the length guard' : 'not a bare affirmative');
}

// --- 5. history window ------------------------------------------------------

console.log('\npayload never exceeds the send window');
{
  const { state, send } = makeWidget();
  let worst = 0;
  for (let i = 1; i <= 10; i++) {
    send('question number ' + i, ok200('answer number ' + i));
    worst = Math.max(worst, state.calls[state.calls.length - 1].length);
  }
  check(`payload capped at ${SEND_WINDOW} across ten turns`, worst === SEND_WINDOW, 'max ' + worst);
  check('stored history still holds the visible thread', state.history.length === 20);

  const last = state.calls[state.calls.length - 1];
  check('window keeps the MOST RECENT turns',
    last[last.length - 1].content === 'question number 10');
  check('payload carries only role and content',
    last.every((m) => Object.keys(m).sort().join(',') === 'content,role'),
    JSON.stringify(last[0]),
  );
  // The bug this suite exists to prevent coming back.
  check('no message content was truncated',
    state.calls.every((c) => c.every((m) => !/\.\.\.$|…$/.test(m.content))));
}

// --- 6. capturing leads while the model is unavailable ----------------------
//
// The daily token ceiling is ~155 requests across the chain against a ~60/day
// estimate, so an outage lands on the client's busiest days. /api/lead never
// touches Groq, so the form still works when the model does not.

console.log('\nrate_limit outage still captures a lead');
{
  const { state, send } = makeWidget();
  send('class timings', ok200('Classes run 9am to 8pm.'));
  const before = state.calls.length;
  const r = send('ielts academic', degraded('rate_limit'));

  check('lead form renders on rate_limit', state.formOpens === 1);
  check('copy is about a call back, not a broken assistant',
    /call you back/i.test(state.formTitle) && !/cannot reach|broken|unavailable/i.test(state.formTitle),
    state.formTitle);
  check('no extra /api/chat call for the form', state.calls.length === before + 1);
  check('the failed turn is still not committed', r.committed === false);
  check('outage message was never stored as an assistant turn',
    !state.history.some((m) => /getting a lot of questions/i.test(m.content)));
}

console.log('\nthe other three errorKinds get the message and no form');
for (const kind of ['upstream', 'network', 'model_gone']) {
  const { state, send } = makeWidget();
  send('class timings', ok200('Classes run 9am to 8pm.'));
  send('ielts academic', degraded(kind));
  check(`${kind} renders no lead form`, state.formOpens === 0);
}

console.log('\na visitor who already declined is not re-asked during an outage');
{
  const { state, send } = makeWidget();
  send('class timings', ok200('Classes run 9am to 8pm.'));
  state.flags.leadDeclined = true;
  send('ielts academic', degraded('rate_limit'));
  check('declined visitor sees no form', state.formOpens === 0);
}

// --- 7. the outage lead payload matches the normal one ----------------------
//
// Same builder, so a shape difference here would mean the outage path had
// drifted into a second, less-tested submit. It reads `history`, which on the
// outage path is missing the failed turn — that is correct, not a defect.

console.log('\noutage lead payload has the same shape as the normal one');
{
  const leadPayload = (state) => ({
    name: 'Ayesha',
    phone: '0332 241 0155',
    course: 'IELTS Academic',
    sessionId: 'sid',
    transcript: state.history.slice(-6),
    pageUrl: 'https://4skills.co/',
    referrer: '',
  });

  const normal = makeWidget();
  normal.send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  normal.send('yes', null);
  const a = leadPayload(normal.state);

  const outage = makeWidget();
  outage.send('ielts academic', ok200('Rs 35,000 for IELTS Academic.'));
  outage.send('what about PTE', degraded('rate_limit'));
  const b = leadPayload(outage.state);

  check('identical key sets',
    Object.keys(a).sort().join(',') === Object.keys(b).sort().join(','),
    Object.keys(b).sort().join(','));
  check('both carry a transcript array',
    Array.isArray(a.transcript) && Array.isArray(b.transcript));
  check('outage transcript excludes the failed turn',
    !b.transcript.some((m) => /what about PTE/.test(m.content)));
  check('outage transcript still carries the real conversation',
    b.transcript.some((m) => /ielts academic/i.test(m.content)));
  check('no /api/chat call is needed to submit either',
    typeof a.transcript.length === 'number' && typeof b.transcript.length === 'number');
}

// --- 8. what counts as an offer -------------------------------------------
//
// The reported bug. CALL_OFFER only matched explicit call phrasings, but live
// the model rarely offers a call — it ends on an enrolment or batch invitation.
// A visitor saying "yes" to "would you like to know about start dates or how to
// enrol?" has expressed exactly the intent the form exists to capture, and
// `offer` came back false, so the widget did not intercept and the turn went to
// the model. Reproduced against dev before the fix.

console.log('\nserver offer detection covers what the model actually writes');
{
  const src = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  const reOf = (name) => {
    const m = src.match(new RegExp('const ' + name + ' =\\s*new RegExp\\(\\s*\\[([\\s\\S]*?)\\]\\.join'));
    if (m) return new RegExp([...m[1].matchAll(/\/(.+?)\/\.source/g)].map((x) => x[1]).join('|'), 'i');
    const lit = src.match(new RegExp('const ' + name + ' =\\s*\\n\\s{2}(\\/[\\s\\S]*?\\/)i;'));
    if (!lit) throw new Error('could not extract ' + name + ' from api/chat.js');
    return new RegExp(lit[1].slice(1, -1), 'i');
  };
  const CALL_OFFER = reOf('CALL_OFFER');
  const OFFER_FRAME = reOf('OFFER_FRAME');
  const OFFER_TOPIC = reOf('OFFER_TOPIC');
  // Composed exactly as api/chat.js composes OFFER_INVITE: an explicit call
  // offer, OR a personal offer frame with a lead-shaped topic in the same
  // sentence. Built from the same two sources so it cannot drift.
  const OFFER_INVITE = new RegExp(
    OFFER_FRAME.source + '[^.?!\\n]{0,40}' + OFFER_TOPIC.source, 'i',
  );
  const isOffer = (s) => CALL_OFFER.test(s) || OFFER_INVITE.test(s);

  /*
   * The greeting armed the flag and a visitor's "ok" opened a form on turn one.
   * "I can help with course fees, class timings, and how to enrol" carries the
   * topic words but offers the visitor nothing — it describes capability.
   */
  for (const s of [
    'Hello, welcome to 4Skills. I can help with course fees, class timings, and how to enrol. What would you like to know?',
    'I can help with fees, timings and enrolment.',
    'Enrolment takes three steps: the form, the fee, and the evaluation test.',
  ]) check('capability text is NOT an offer: ' + s.slice(0, 40), !isOffer(s), 'expected false');

  for (const s of [
    'Would you like someone to call you?',
    'Shall I check the next batch for you?',
    'Would you like me to arrange a callback?',
  ]) check('personal offer IS an offer: ' + s.slice(0, 44), isOffer(s), 'expected true');

  // Observed live, and the exact line that broke it.
  for (const s of [
    'Would you like to know about available start dates or how to enrol?',
    'Shall I check the next batch for you?',
    'I can arrange for someone from our team to call you.',
    'Would you like me to arrange a callback?',
    'Share your name and number and the team will call you.',
  ]) check('offer: ' + s.slice(0, 52), isOffer(s), 'expected true');

  // "yes" to these is NOT lead intent — they must stay false or every reply
  // becomes an offer and the form opens on the first affirmative.
  for (const s of [
    'Which one do you need?',
    'Would you like information on any of our courses?',
    'IELTS Academic is Rs 35,000 for the full 8-week course.',
    'Classes run Monday to Friday, 9:00 AM to 8:00 PM.',
    'Our office is at Kohinoor One Plaza, Jaranwala Road.',
  ]) check('not an offer: ' + s.slice(0, 46), !isOffer(s), 'expected false');
}

// --- 9. English bullets and bold survive the pipeline intact ----------------
//
// The other reported regression: English answers came back as flat prose. The
// prompt is what produces the shape, but nothing between the model and the
// screen may damage it — a reply that arrives bulleted must stay bulleted in
// history and in the next payload, uncut.

console.log('\nan English bulleted, bolded reply survives intact');
{
  const SHAPED =
    'We offer two IELTS courses:\n\n' +
    '- **IELTS Academic** — Rs 35,000\n' +
    '- **IELTS General Training** — Rs 35,000\n\n' +
    'Both run 8 weeks with bi-weekly mock tests. Free practice tests at https://4skills.app\n\n' +
    'Which one do you need?';

  const { state, send } = makeWidget();
  send('i need info about ielts', ok200(SHAPED));

  const stored = state.history.find((m) => m.role === 'assistant');
  const bullets = (stored.content.match(/^- /gm) || []).length;
  const bolds = (stored.content.match(/\*\*[^*]+\*\*/g) || []).length;

  check('two bullet lines are stored', bullets === 2, bullets + ' found');
  check('bold markers are stored', bolds >= 2, bolds + ' found');
  check('stored reply is byte-identical to the model output', stored.content === SHAPED);

  send('and PTE?', ok200('**PTE Academic** is **Rs 28,000**.'));
  const payload = state.calls[state.calls.length - 1];
  const replayed = payload.find((m) => m.role === 'assistant' && /IELTS Academic/.test(m.content));
  check('bullets survive into the next payload',
    replayed && (replayed.content.match(/^- /gm) || []).length === 2);
  check('nothing truncated the reply on the way out',
    replayed && replayed.content === SHAPED);
}

// --- 10. an affirmative must never produce silence -------------------------
//
// Live bug: the affirmative was intercepted, the form was suppressed because a
// card was already open, and the early return fired anyway — no form, no
// request, nothing rendered. The visitor typed "ok", then "yes", and the bot
// answered neither.

console.log('\nan affirmative never produces silence');
{
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));

  const first = send('ok', null);
  check('first affirmative opens the form', first.calledApi === false && state.formOpens === 1);

  // Card still open. The next affirmative cannot open a second one.
  const second = send('yes', ok200('The team will call you shortly.'));
  check('second affirmative is NOT swallowed', second.calledApi === true,
    'must reach /api/chat when the form cannot be shown');
  check('and it produced a visible reply',
    state.rendered.some((m) => m.who === 'bot' && /call you shortly/.test(m.text)));
  check('no second form was opened', state.formOpens === 1);
}

{
  // Same, via the leadCaptured gate rather than an open card.
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  state.flags.leadCaptured = true;
  const r = send('yes', ok200('Someone will be in touch shortly.'));
  check('affirmative after leadCaptured reaches the model', r.calledApi === true);
  check('and renders a reply',
    state.rendered.some((m) => m.who === 'bot' && /in touch/.test(m.text)));
  check('no form for a captured lead', state.formOpens === 0);
}

// --- 11. the happy path still works on the first ask -----------------------

console.log('\nthe first ask still opens the form with zero API calls');
for (const word of ['yes', 'ok', 'sure', 'haan']) {
  const { state, send } = makeWidget();
  send('ielts academic', ok200('Rs 35,000. Shall I have someone call you today?', true));
  const before = state.calls.length;
  const r = send(word, null);
  check(`"${word}" opens the form on the first ask`,
    r.calledApi === false && state.formOpens === 1 && state.calls.length === before);
}

console.log('');
console.log(fail ? fail + ' FAILED' : 'all conversation tests passed');
process.exit(fail ? 1 : 0);
