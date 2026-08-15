// npm run teaser-check
//
// Drives the REAL teaser scheduler out of public/widget.js against a virtual
// clock and prints the observed timings. No browser, no waiting 100 seconds.
//
// Why extract rather than reimplement: a reimplementation would have passed
// happily while the shipped widget was broken. Twice now the teaser has been
// wrong in a way that looked fine on inspection — once because reaching the
// cap hid the third bubble in the same tick it appeared, once because opening
// the panel silently retired it for the whole session. Both were schedule bugs,
// invisible without watching the clock.
//
// The DOM bits the scheduler touches are stubbed; everything else is the
// widget's own code.

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) break;
    }
  }
  return src.slice(start, i + 1);
}

// Read the real constants so the harness cannot drift from the widget.
const TEASERS = JSON.parse(
  '[' + /var TEASERS = \[([\s\S]*?)\]/.exec(src)[1].replace(/'/g, '"') + ']',
);
const VISIBLE_MS = Number(/var TEASER_VISIBLE_MS = (\d+)/.exec(src)[1]);

/* ------------------------------------------------------------ virtual clock */
let now = 0;
let timers = [];
let seq = 0;

const win = {
  setTimeout(fn, ms) {
    const t = { id: ++seq, fn, at: now + ms, live: true };
    timers.push(t);
    return t;
  },
  clearTimeout(t) {
    if (t) t.live = false;
  },
};

function advanceTo(target) {
  for (;;) {
    const next = timers
      .filter((t) => t.live && t.at <= target)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at;
    next.live = false;
    next.fn();
  }
  now = target;
}

/* ------------------------------------------------------------------- stubs */
const events = [];
let lastText = '';

const teaser = {
  hidden: true,
  style: {},
  offsetWidth: 0,
  contains: () => false,
};
const teaserText = {
  set textContent(v) {
    lastText = v;
  },
  get textContent() {
    return lastText;
  },
};
const fab = { classList: { add() {}, remove() {} }, offsetWidth: 0 };
const root = { activeElement: null };
const store = {};

const cfg = { teaserDelay: 8000, teaserInterval: 45000, teaserMax: 3 };

/* --------------------------------------------------- assemble the real code */
const body = `
  var teaserDone = false, teaserShown = 0, teaserHover = false;
  var teaserTimer = null, teaserHideTimer = null;
  var open = false, resuming = false;
  var KEY_TEASER = 'done', KEY_TEASER_N = 'n';
  var RESUME_TEASER = 'Continue your chat';
  function reduceMotion() { return true; }   // no CSS here; skip the pulse
  ${grab('finishTeaser')}
  ${grab('stopTeaser')}
  ${grab('hideTeaser')}
  ${grab('pulseFab')}
  ${grab('showTeaser')}
  ${grab('disarmTeaserHide')}
  ${grab('armTeaserHide')}
  ${grab('scheduleTeaser')}
  return { scheduleTeaser: scheduleTeaser, peek: function () {
    return { done: teaserDone, shown: teaserShown };
  } };
`;

const factory = new Function(
  'window', 'cfg', 'TEASERS', 'TEASER_VISIBLE_MS', 'teaser', 'teaserText',
  'fab', 'root', 'writeStore', 'readStore',
  body,
);

const api = factory(
  win, cfg, TEASERS, VISIBLE_MS, teaser, teaserText, fab, root,
  (k, v) => { store[k] = v; },
  (k, d) => (k in store ? store[k] : d),
);

/* ----------------------------------------------------------- watch and run */
let wasHidden = true;
function sample() {
  if (teaser.hidden !== wasHidden) {
    events.push({ t: now, shown: !teaser.hidden, text: lastText });
    wasHidden = teaser.hidden;
  }
}

const originalSetTimeout = win.setTimeout;
win.setTimeout = function (fn, ms) {
  return originalSetTimeout(function () {
    fn();
    sample();
  }, ms);
};

api.scheduleTeaser();
sample();
for (let t = 0; t <= 200000; t += 100) advanceTo(t);

/* --------------------------------------------------------------- reporting */
console.log('\nteaser schedule, observed against a virtual clock');
console.log(`config: delay ${cfg.teaserDelay}ms, interval ${cfg.teaserInterval}ms, max ${cfg.teaserMax}, visible ${VISIBLE_MS}ms\n`);

let fails = 0;
function expect(label, actual, want) {
  const ok = actual === want;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  expected ${want}`}`);
}

const shows = events.filter((e) => e.shown);
const hides = events.filter((e) => !e.shown);

for (const e of events) {
  console.log(`   ${String(e.t / 1000).padStart(6)}s  ${e.shown ? 'SHOW  "' + e.text + '"' : 'hide'}`);
}
console.log('');

expect('bubbles shown in total', shows.length, 3);
expect('first appears at', shows[0] && shows[0].t, 8000);
expect('second appears at', shows[1] && shows[1].t, 8000 + 45000);
expect('third appears at', shows[2] && shows[2].t, 8000 + 45000 + 45000);
expect('message 1', shows[0] && shows[0].text, TEASERS[0]);
expect('message 2', shows[1] && shows[1].text, TEASERS[1]);
expect('message 3', shows[2] && shows[2].text, TEASERS[2]);
expect('each auto-hides after', hides.length && hides[0].t - shows[0].t, VISIBLE_MS);
expect('third bubble also auto-hides', hides.length, 3);
expect('third stays visible its full time', hides[2] && hides[2].t - shows[2].t, VISIBLE_MS);
expect('retired after the cap', api.peek().done, true);

console.log('');
console.log(fails ? `${fails} FAILED` : 'teaser schedule verified');
process.exit(fails ? 1 : 0);
