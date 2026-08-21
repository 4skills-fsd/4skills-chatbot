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

    if (w.acceptsOffer(text)) {
      w.push({ role: 'user', content: text });
      state.formOpens++;
      return { calledApi: false };
    }

    w.setPending({ role: 'user', content: text });
    state.calls.push(w.outbound());

    const r = response || { status: 200, body: { reply: 'ok', offer: false } };
    const body = r.body;

    if (!body || typeof body.reply !== 'string' || body.degraded || r.status !== 200) {
      w.setPending(null);                       // dropPending()
      state.rendered.push({ who: 'bot', text: body && body.reply, error: true });
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
for (const word of ['yes', 'Yes!', 'haan', 'ji haan', 'ok', 'theek hai', 'yes please', 'CALL ME']) {
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

console.log('');
console.log(fail ? fail + ' FAILED' : 'all conversation tests passed');
process.exit(fail ? 1 : 0);
