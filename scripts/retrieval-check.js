// npm run retrieval-check
//
// Fixed query set, half English, half Roman Urdu, with the entry id each query
// is supposed to surface. Prints the top 4 with scores and flags any query whose
// expected id is missing.
//
// This is the check on the IDF weighting: without it, generic terms (course,
// class, ielts, fee) let a methodology entry outrank a fees entry on a vague
// query. Run it after any edit to knowledge.json or retrieve.js.

import { corpusSize, score } from '../lib/retrieve.js';
import knowledge from '../lib/knowledge.json' with { type: 'json' };

const CASES = [
  // --- English ---
  ['how much is the IELTS course', 'ielts-fee'],
  ['pte fees', 'pte-fee'],
  ['how much is the web development course', 'unconfirmed-course-fees'],
  ['what time is the evening batch', 'class-timings'],
  ['are you open on sunday', 'opening-hours'],
  ['where is your office', 'location'],
  ['how do I enrol', 'enrolment-process'],
  ['my test is in 5 weeks can I finish sooner', 'fast-track'],
  ['I need A1 for my wife visa', 'life-skills-a1-fee'],
  ['how many students in one class', 'batch-size'],
  ['can I pay in installments', 'payment-terms'],
  ['is there any refund policy', 'hidden-charges'],
  ['do you teach letter writing', 'gt-letter-writing'],
  ['how is my writing checked', 'writing-speaking-feedback'],
  ['should I take ielts or pte', 'ielts-vs-pte'],
  ['how do I register for my ielts test', 'test-registration'],
  ['are you an official partner of idp', 'partnerships-certifications'],
  // Who FOUNDED it and who TEACHES it are different questions with different
  // entries, and founder-director carries `teacher`/`ustad` in its keywords, so
  // the split is one keyword edit away from collapsing. There is no stemmer:
  // `teaches` matches only because it is listed on `trainers` verbatim.
  ['who is the founder', 'founder-director'],
  ['who is the director', 'founder-director'],
  ['who teaches the IELTS class', 'trainers'],
  // "IT" only survives as part of a phrase — it is a stopword on its own. These
  // guard the pre-stopword phrase matching in retrieve.js.
  ['how much is the IT course', 'unconfirmed-course-fees'],
  ['how much is the it course', 'unconfirmed-course-fees'],
  ['do you offer IT classes', 'unconfirmed-course-fees'],

  // --- Roman Urdu ---
  ['ielts ki fees kitni hai', 'ielts-fee'],
  ['pte ka course kitne ka hai', 'pte-fee'],
  ['class kitne baje hoti hai', 'class-timings'],
  ['admission kaise leni hai', 'enrolment-process'],
  ['aap kahan par ho', 'location'],
  ['next batch kab shuru hoga', 'next-batch'],
  ['spoken english ki fees kya hai', 'spoken-english-fee'],
  ['kitne students hote hain aik class mein', 'batch-size'],
  ['online class ho sakti hai', 'online-classes'],
  ['mujhe jaldi test dena hai', 'fast-track'],
  ['4skills ka malik kaun hai', 'founder-director'],
];

// Queries that SHOULD return nothing. Passing four irrelevant entries is worse
// than passing none, so the floor has to actually reject.
const SHOULD_BE_EMPTY = [
  'what is the weather today',
  'tell me a joke about cricket',
  'asdfgh qwerty',
  'can I learn Chinese here',
  // Bare "it" is a pronoun. It must never route anywhere on its own, however
  // many phrases contain it. ("how much is it" is deliberately NOT here — that
  // is a real fee question with an anaphoric "it", and the fee entries are the
  // right answer.)
  'it',
];

// Languages 4Skills does not teach. These are the dangerous near-misses: after
// stopwords they keep `teach` / `classes` / `conversation`, all of which are on
// the corpus, while the language noun itself is absent — so a fees entry can
// clear the floor and the bot implies it teaches French.
//
// The property that matters is not emptiness. `courses-offered` is the correct
// entry here: it enumerates what IS offered, which is exactly what the model
// needs to say "we don't teach German, we teach these". What must never happen
// is a fees or teaching entry ranking first and anchoring the answer on a
// course the visitor did not ask about.
const NOT_TAUGHT = [
  'do you teach French conversation classes',
  'do you offer German classes',
];
const UNSAFE_FIRST = new Set(['fees', 'teaching']);

let failures = 0;
const width = Math.max(...CASES.map(([q]) => q.length));

// A matched phrase credits coverage for every word it consumed, so a long
// phrase can swallow most of a query and hand its entry near-full coverage on
// that alone. Three words is the ceiling.
const longPhrases = [];
for (const entry of knowledge) {
  for (const kw of entry.keywords) {
    const n = kw.trim().split(/\s+/).length;
    if (n > 3) longPhrases.push(`${entry.id}: "${kw}" (${n} words)`);
  }
}
if (longPhrases.length) {
  failures += longPhrases.length;
  console.log('\nkeyword phrases over 3 words — shorten these:');
  longPhrases.forEach((p) => console.log(`X ${p}`));
}

console.log(`\ncorpus: ${corpusSize} entries\n`);
console.log('query'.padEnd(width) + '  top 4 (score)');
console.log('-'.repeat(width + 50));

for (const [query, expected] of CASES) {
  const results = score(query).slice(0, 4);
  const ids = results.map((r) => r.entry.id);
  const hit = ids.includes(expected);
  const rank = ids.indexOf(expected) + 1;

  if (!hit) failures++;

  const shown = results
    .map((r) => `${r.entry.id}(${r.score.toFixed(2)})`)
    .join(' ') || '(none)';

  const mark = hit ? (rank === 1 ? ' ' : '~') : 'X';
  console.log(`${mark} ${query.padEnd(width)}  ${shown}`);
  if (!hit) console.log(`${' '.repeat(width + 2)}  expected: ${expected}`);
}

console.log('\nfloor check — these must return nothing:');
for (const query of SHOULD_BE_EMPTY) {
  const results = score(query).slice(0, 4);
  const ok = results.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? ' ' : 'X'} ${query.padEnd(width)}  ${
      results.map((r) => `${r.entry.id}(${r.score.toFixed(2)})`).join(' ') || '(none)'
    }`,
  );
}

console.log('\nlanguages we do not teach — no fees/teaching entry may rank first:');
for (const query of NOT_TAUGHT) {
  const results = score(query).slice(0, 4);
  const first = results[0];
  const ok = !first || !UNSAFE_FIRST.has(first.entry.category);
  if (!ok) failures++;
  console.log(
    `${ok ? ' ' : 'X'} ${query.padEnd(width)}  ${
      results.map((r) => `${r.entry.id}(${r.score.toFixed(2)})`).join(' ') || '(none)'
    }`,
  );
}

const topOne = CASES.filter(([q, e]) => score(q).slice(0, 4).map((r) => r.entry.id)[0] === e).length;

console.log(
  `\n${CASES.length - failures >= 0 ? '' : ''}expected id in top 4: ${
    CASES.length - CASES.filter(([q, e]) => !score(q).slice(0, 4).map((r) => r.entry.id).includes(e)).length
  }/${CASES.length}   ranked first: ${topOne}/${CASES.length}`,
);
console.log(`legend:  (blank) ranked first   ~ in top 4   X missing\n`);

process.exit(failures ? 1 : 0);
