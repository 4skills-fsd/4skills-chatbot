// npm run validation-check
//
// Guards the 500-character limit against the bug that made it unusable:
// it was applied to EVERY message in the history, assistant replies included.
//
// The widget posts the whole conversation each turn, and max_tokens:420 lets an
// assistant reply reach ~1,600 characters. So one long bot answer made every
// later request fail with "shorten to under 500 characters" — no matter how
// short the visitor's actual message was. A single short message in isolation
// always passed, which is why the bug survived earlier testing.
//
// The limit exists to stop a visitor pasting an essay. It has nothing to say
// about the assistant's own output, which is bounded by max_tokens.

import { sanitiseMessages } from '../api/chat.js';
import { validateOrigins } from '../lib/guard.js';

let fail = 0;
function check(label, ok, detail = '') {
  if (!ok) fail++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
}

// Realistic long assistant replies, the shape the bot actually produces.
const ENROL_REPLY =
  'To enrol, please follow these three steps:\n\n' +
  '- Fill in the admission form for your course, available on our website or at the office\n' +
  '- Pay the fee for your package and subscribe to your portal package\n' +
  '- Take the evaluation test, which usually takes two to three hours, after which you ' +
  'will be invited to join your class\n\n' +
  'Free practice tests at https://4skills.app';

const COURSES_REPLY =
  'We offer the following courses:\n\n' +
  '- **IELTS Academic** — Rs 35,000\n- **IELTS General Training** — Rs 35,000\n' +
  '- **UKVI IELTS** — fee confirmed by the office\n- **IELTS Life Skills A1** — Rs 26,000\n' +
  '- **PTE Academic** — Rs 28,000\n- **PTE Core** — fee confirmed by the office\n' +
  '- **OET** — fee confirmed by the office\n- **Spoken English** — Rs 26,000\n' +
  '- **Oxford ELLT** — fee confirmed by the office\n' +
  '- **LanguageCert** — fee confirmed by the office\n' +
  '- **IT short courses** (Web Development, Office Management, Freelancer, Digital ' +
  'Marketing) — fee confirmed by the office\n\n' +
  'All our courses run 8 weeks with bi-weekly mock tests, 15 to 20 students per batch. ' +
  'Free practice tests at https://4skills.app\n\nWhich one are you interested in?';

console.log('\nassistant reply lengths (the limit is 500):');
console.log('  turn 1 reply: ' + ENROL_REPLY.length + ' chars');
console.log('  turn 2 reply: ' + COURSES_REPLY.length + ' chars');

// ---- the exact reported sequence -------------------------------------------
console.log('\nreported three-turn sequence:');

const turn1 = [{ role: 'user', content: 'How do I enrol?' }];
check('turn 1  "How do I enrol?"', !sanitiseMessages(turn1).error,
  sanitiseMessages(turn1).error || 'accepted');

const turn2 = [
  ...turn1,
  { role: 'assistant', content: ENROL_REPLY },
  { role: 'user', content: 'courses' },
];
check('turn 2  "courses"', !sanitiseMessages(turn2).error,
  sanitiseMessages(turn2).error || 'accepted');

const turn3 = [
  ...turn2,
  { role: 'assistant', content: COURSES_REPLY },
  { role: 'user', content: 'ilets acedemic' },
];
const r3 = sanitiseMessages(turn3);
check('turn 3  "ilets acedemic" (14 chars) after two long replies',
  !r3.error, r3.error || 'accepted');

// ---- the limit must still do its job ---------------------------------------
console.log('\nthe limit still applies to what the VISITOR types:');

const longUser = sanitiseMessages([{ role: 'user', content: 'a'.repeat(501) }]);
check('501-char user message is rejected', longUser.error === 'message_too_long',
  longUser.error || 'accepted');

const okUser = sanitiseMessages([{ role: 'user', content: 'a'.repeat(500) }]);
check('500-char user message is accepted', !okUser.error, okUser.error || 'accepted');

const longUserInHistory = sanitiseMessages([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: ENROL_REPLY },
  { role: 'user', content: 'b'.repeat(600) },
]);
check('oversized user message rejected even mid-conversation',
  longUserInHistory.error === 'message_too_long', longUserInHistory.error || 'accepted');

// ---- other guards unaffected ------------------------------------------------
console.log('\nunrelated validation still works:');
check('non-array rejected', sanitiseMessages('nope').error === 'messages_must_be_array');
check('empty array rejected', sanitiseMessages([]).error === 'messages_empty');
check('over 20 messages rejected',
  sanitiseMessages(Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })))
    .error === 'too_many_messages');
check('malformed message rejected',
  sanitiseMessages([{ role: 'user' }]).error === 'bad_message');

/*
 * ALLOWED_ORIGINS parsing.
 *
 * The failure this guards is not a crash. A missing comma produces a
 * syntactically fine list whose third entry is nonsense, ALLOWED_ORIGINS
 * REPLACES the defaults, and the affected domain starts getting a bare 403
 * with no CORS headers — which the browser reports as a generic CORS error and
 * the page renders as nothing at all. Found in a real .env.local.
 */
console.log('\nALLOWED_ORIGINS validation:');

const MALFORMED =
  'https://4skills.co,https://www.4skills.co,https://4skills.apphttps://unlaudable-jaelynn-unanatomized.ngrok-free.dev';

{
  const r = validateOrigins(MALFORMED);
  check('the real malformed value is flagged', r.problems.length === 1, r.problems[0]);
  check('it is flagged as a missing comma', /missing/i.test(r.problems[0] || ''));
  // The actual damage: the app origin is gone, replaced by a fused string.
  check('https://4skills.app is NOT in the resulting allowlist',
    !r.origins.includes('https://4skills.app'), r.origins.join(' | '));
  check('the fused entry is what took its place',
    r.origins.some((o) => o.startsWith('https://4skills.apphttps://')));
  check('the two well-formed origins still survive',
    r.origins.includes('https://4skills.co') && r.origins.includes('https://www.4skills.co'));
}

{
  const good = 'https://4skills.co,https://www.4skills.co,https://4skills.app';
  const r = validateOrigins(good);
  check('a valid multi-origin string has no problems', r.problems.length === 0,
    r.problems.join('; '));
  check('all three parse', r.origins.length === 3);
  check('4skills.app is allowed', r.origins.includes('https://4skills.app'));
}

{
  const r = validateOrigins('  https://4skills.co , https://4skills.app/ ');
  check('whitespace and a trailing slash are tolerated',
    r.problems.length === 0 && r.origins.includes('https://4skills.app'),
    r.problems.join('; '));
}

for (const [label, value, expect] of [
  ['a path is rejected', 'https://4skills.co/widget', /path, query or fragment/],
  ['a query is rejected', 'https://4skills.co/?x=1', /path, query or fragment/],
  ['a missing scheme is rejected', '4skills.co', /no scheme/],
  ['a non-http scheme is rejected', 'ftp://4skills.co', /expected http/],
]) {
  const r = validateOrigins(value);
  check(label, r.problems.length > 0 && expect.test(r.problems[0]), r.problems[0] || '(none)');
}

{
  const r = validateOrigins('');
  check('empty value falls back to DEFAULT_ORIGINS', r.usingDefaults === true);
  check('defaults include all three production origins',
    r.origins.includes('https://4skills.co') &&
      r.origins.includes('https://www.4skills.co') &&
      r.origins.includes('https://4skills.app'),
    r.origins.join(' | '));
  check('defaults are clean', r.problems.length === 0);
  // `undefined` falls through to the default parameter, which reads the real
  // env var — so clear it first, or this passes or fails depending on whether
  // the runner happened to load .env.local.
  const saved = process.env.ALLOWED_ORIGINS;
  delete process.env.ALLOWED_ORIGINS;
  const u = validateOrigins(undefined);
  if (saved !== undefined) process.env.ALLOWED_ORIGINS = saved;
  check('undefined behaves the same as empty', u.usingDefaults === true);
}

console.log('');
console.log(fail ? fail + ' FAILED' : 'all validation tests passed');
process.exit(fail ? 1 : 0);
