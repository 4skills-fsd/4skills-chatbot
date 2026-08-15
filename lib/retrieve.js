// Keyword retrieval over knowledge.json.
//
// The naive version — count how many query terms appear in each entry — fails on
// this corpus because generic terms (course, class, ielts, fee) appear in most
// entries, so a vague query surfaces whichever entry happens to be longest.
// IDF weighting fixes that: a term in 20 of 33 entries contributes almost
// nothing, while `spouse`, `oet`, `refund` or `kitni` dominate.
//
// Everything here is precomputed once at module load. Per-request work is a
// single pass over 33 entries, which is nothing.

import knowledge from './knowledge.json' with { type: 'json' };

// Highest-intent categories. A fees or logistics entry should win a tie against
// an equally-scoring teaching or about entry, because that is what the visitor
// is usually actually asking.
const BOOSTED_CATEGORIES = new Set(['fees', 'logistics']);
const CATEGORY_BOOST = 1.15;

const KEYWORD_WEIGHT = 2;
const QUESTION_WEIGHT = 1;

// Below this, reference material is more likely to mislead than help. The
// system prompt handles the empty case on its own.
const SCORE_FLOOR = 0.15;
const MAX_ENTRIES = 4;

// An exact multi-word keyword hit ("kitne baje", "office management") is at
// least as strong a signal as its words matching individually, and phrases are
// the only way those words match at all — so the bonus carries keyword weight.
const PHRASE_BONUS = KEYWORD_WEIGHT;

// Function words, English and Roman Urdu, stripped from both the index and the
// query so document frequency stays consistent.
//
// This is not a nice-to-have. Without it, "what is the weather today" matches
// `what`, `is` and `the` — the only terms it shares with the corpus — and then
// normalises against a denominator built from those same three terms, scoring
// ~0.6 on an entry about course fees. The floor cannot catch that, because the
// score is high relative to what the query asked for. Removing function words
// leaves the query with nothing scorable at all, which is the right answer.
//
// Interrogatives are deliberately NOT here. `how`, `when`, `where`, `who`,
// `kitna`, `kitne`, `kitni`, `kab`, `kahan`, `kaise` carry real signal in this
// corpus — they are what distinguishes "kitni fees" from "fees" — and several
// appear verbatim in the keyword lists.
const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'there', 'here',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
  'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must',
  'of', 'for', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'about',
  'and', 'or', 'but', 'if', 'so', 'as', 'then', 'than',
  'not', 'no', 'yes', 'please', 'thanks', 'thank',
  'what', 'whats', 'which',
  'tell', 'say', 'give', 'want', 'need', 'learn', 'here', 'get', 'got',
  'just', 'very', 'really', 'also', 'too', 'some', 'any', 'all',
  'hi', 'hello', 'hey', 'ok', 'okay', 'sir', 'madam',
  // Roman Urdu
  'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'par', 'pe', 'ne',
  'hai', 'hain', 'ho', 'hoti', 'hota', 'hote', 'hon', 'hun',
  'aur', 'ya', 'bhi', 'hi', 'kya',
  'ap', 'aap', 'tum', 'mera', 'meri', 'mere', 'apna', 'apni',
  'raha', 'rahi', 'rahe', 'sakta', 'sakti', 'sakte',
  'liye', 'lie', 'kar', 'karna', 'karne',
  'mujhe', 'mujhy', 'ye', 'yeh', 'wo', 'woh', 'kuch', 'koi',
  'acha', 'achha',
]);

/** Lowercase, strip punctuation, split. Keeps digits — "task 1", "a1". */
function tokenizeRaw(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** As above, minus function words. Used for single-term matching only. */
function tokenize(text) {
  return tokenizeRaw(text).filter((t) => !STOPWORDS.has(t));
}

// --- index, built once ------------------------------------------------------

const index = knowledge.map((entry) => {
  const keywordTerms = new Set();
  const phrases = [];

  // A multi-word keyword indexes as a PHRASE ONLY — its individual words are
  // not added as terms. If you want the individual words to match too, list
  // them separately.
  //
  // This matters more than it looks. "office management" is a course name that
  // has to stay in unconfirmed-course-fees, but splitting it put bare `office`
  // in that entry's keyword set at 2x weight, so "where is your office" scored
  // it 0.46 — a fees disclaimer surfacing on a directions question. Same route
  // put bare `pte` there via "pte core" and bare `course` via "computer course".
  // Keywords route queries; they do not describe the entry.
  //
  // Phrases are built from the RAW keyword, before stopwords. Stopwording first
  // destroys any phrase whose components include a function word: "it course"
  // collapsed to ["course"], stopped being a phrase, and re-added bare `course`
  // as a term — the opposite of what the keyword was for. "how long", "how many
  // students" and "fees kya hai" were losing their heads the same way.
  //
  // Single-word keywords still go through the stopworded tokenizer, so a
  // keyword that is nothing but a function word contributes nothing and bare
  // `it` still matches no entry.
  for (const kw of entry.keywords) {
    const raw = tokenizeRaw(kw);
    if (raw.length > 1) {
      phrases.push(raw.join(' '));
      continue;
    }
    const single = tokenize(kw);
    if (single.length === 1) keywordTerms.add(single[0]);
  }

  const questionTerms = new Set(tokenize(entry.question));

  return { entry, keywordTerms, questionTerms, phrases };
});

// Document frequency across the whole corpus, counting a term once per entry
// wherever it showed up.
//
// Words inside multi-word keywords count here even though they are not
// individually matchable. They have to: idf() drives the phrase bonus, and a
// term with df 0 gets idf 0, which would silently zero out the bonus for the
// most distinctive phrases in the corpus ("office management", "digital
// marketing") — the exact ones phrases exist to serve.
const df = new Map();
for (const { keywordTerms, questionTerms, phrases } of index) {
  const seen = new Set([...keywordTerms, ...questionTerms]);
  for (const phrase of phrases) for (const t of phrase.split(' ')) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
}

/** Rare terms approach 0.5, terms in every entry approach 0. */
function idf(term) {
  const n = df.get(term) || 0;
  return n === 0 ? 0 : 1 / (1 + n);
}

// --- scoring ----------------------------------------------------------------

/**
 * @param {string} query the latest user message
 * @returns {Array<object>} up to MAX_ENTRIES knowledge entries, best first
 */
export function retrieve(query) {
  return score(query).slice(0, MAX_ENTRIES).map((r) => r.entry);
}

/**
 * Same as retrieve() but keeps the scores. Used by the retrieval-check script.
 */
export function score(query) {
  const queryTerms = [...new Set(tokenize(query || ''))];

  // Terms nothing in the corpus contains can never be matched, so they must not
  // count toward the denominator — otherwise every reply in a long sentence
  // gets normalised into the floor.
  const scorable = queryTerms.filter((t) => df.has(t));
  if (!scorable.length) return [];

  // Ceiling for this query: every scorable term matched at keyword weight.
  // Normalising against this rather than against the best entry's score is what
  // makes the floor meaningful — with per-query max-normalisation the top hit
  // would always be 1.0 and the floor would never reject anything.
  const denom = KEYWORD_WEIGHT * scorable.reduce((sum, t) => sum + idf(t), 0);
  if (denom <= 0) return [];

  // Phrase matching runs against the raw query for the same reason phrases are
  // built raw — "how much is the IT course" must still contain "it course".
  const rawTerms = tokenizeRaw(query);
  // Padded so phrase matching lands on word boundaries. A bare substring test
  // matches "it course" inside "wait courses", which is exactly the kind of
  // silent mis-route the whole scoring design exists to prevent.
  const rawQuery = ` ${rawTerms.join(' ')} `;

  // Coverage is measured over the query terms the corpus could possibly match,
  // which is not the same as the content terms. `it` is a stopword, so it never
  // reaches `scorable` — but it does appear inside the phrase "it course", so it
  // is a term we can match and must therefore be a term we can be scored on.
  // Measuring against content terms alone punished the entry that matched the
  // one discriminating token in the sentence.
  const coverageTerms = new Set(rawTerms.filter((t) => df.has(t)));
  const coverageSize = coverageTerms.size || 1;
  const results = [];

  for (const { entry, keywordTerms, questionTerms, phrases } of index) {
    let raw = 0;
    const matched = new Set();

    for (const term of scorable) {
      // A term in both fields counts once, at the higher weight.
      const weight = keywordTerms.has(term)
        ? KEYWORD_WEIGHT
        : questionTerms.has(term)
          ? QUESTION_WEIGHT
          : 0;
      if (weight) {
        raw += idf(term) * weight;
        matched.add(term);
      }
    }

    for (const phrase of phrases) {
      if (rawQuery.includes(` ${phrase} `)) {
        const terms = phrase.split(' ');
        raw += PHRASE_BONUS * terms.reduce((s, t) => s + idf(t), 0);
        // Every word the phrase consumed counts as covered, stopwords included —
        // they are in the raw query and in the corpus, so they are in
        // coverageTerms.
        for (const t of terms) matched.add(t);
      }
    }

    if (raw <= 0) continue;

    // Coverage: how much of what the visitor actually asked did this entry
    // answer? Without it, a query that overlaps the corpus on one rare word and
    // misses on everything else scores high on that one word. "do you teach
    // French conversation classes" hits `conversation` in the Spoken English
    // entry, and the absent language noun is excluded from the denominator, so
    // it cleared the floor at 0.61 — the bot would have implied it teaches
    // French. Scaling by matched/asked drops it under.
    // How much of what the visitor asked did this entry actually answer?
    // A word we have never seen ("German", "Sheffield") is usually the most
    // important word in the sentence — it is what makes the question one we
    // cannot answer — so it stays out of the numerator and drags coverage down.
    const coverage = matched.size / coverageSize;

    let value = Math.min(1, raw / denom) * coverage;
    if (BOOSTED_CATEGORIES.has(entry.category)) {
      value = Math.min(1, value * CATEGORY_BOOST);
    }

    if (value >= SCORE_FLOOR) results.push({ entry, score: value });
  }

  return results.sort((a, b) => b.score - a.score);
}

export const corpusSize = knowledge.length;
