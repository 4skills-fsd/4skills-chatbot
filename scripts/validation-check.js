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

console.log('');
console.log(fail ? fail + ' FAILED' : 'all validation tests passed');
process.exit(fail ? 1 : 0);
