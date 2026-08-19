// npm run render-check
//
// Exercises the assistant-reply renderer in public/widget.js against a minimal
// DOM shim, so the security-relevant behaviour is provable without a browser:
// model output must never become markup, and only the five allowlisted URLs may
// become links. Run it after any change to renderRich/appendInline/appendWithLinks.
//
// It reads the functions straight out of widget.js rather than importing them —
// widget.js is an IIFE with no exports by design, and duplicating the code here
// would let the test pass while the shipped widget drifts.

// Extract the three renderer functions and exercise them against a minimal
// DOM shim — no browser needed to prove the security-relevant behaviour.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

// Minimal DOM
class Node2 {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.attrs = {}; this._text = null; this.className=''; }
  appendChild(n) { this.childNodes.push(n); return n; }
  set textContent(v) { this._text = v; this.childNodes = []; }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map(c => c.textContent).join('');
  }
  set href(v){ this.attrs.href = v; } get href(){ return this.attrs.href; }
  set target(v){ this.attrs.target = v; } get target(){ return this.attrs.target; }
  set rel(v){ this.attrs.rel = v; } get rel(){ return this.attrs.rel; }
  html() {
    if (this.tag === '#text') return this._text.replace(/</g,'&lt;');
    const a = this.tag === 'a' ? ` href="${this.attrs.href}" target="${this.attrs.target}" rel="${this.attrs.rel}"` : '';
    return `<${this.tag}${a}>` + (this._text !== null ? this._text.replace(/</g,'&lt;') : this.childNodes.map(c=>c.html()).join('')) + `</${this.tag}>`;
  }
}
const document = {
  createElement: t => new Node2(t),
  createTextNode: t => { const n = new Node2('#text'); n._text = t; return n; },
};

const code = [
  grab('stripTypedForm'),
  grab('appendWithLinks'),
  grab('appendInline'),
  grab('appendBulletBody'),
  grab('renderRich'),
].join('\n');
const LINK_ALLOWLIST = [
  'https://4skills.app',
  'https://www.youtube.com/@4SKILLS256',
  'https://4skills.co/faq',
  'https://4skills.co/success-stories-ielts',
  'https://maps.app.goo.gl/iGJmsU1VvnyZCYcH6'
];
const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"']+/g;
// Constants the extracted functions close over in widget.js. Read out of the
// source rather than redeclared, so a change there cannot silently diverge here.
const BULLET = new RegExp(src.match(/var BULLET = \/(.+?)\/;/)[1]);
const LABEL = new RegExp(src.match(/var LABEL = \/(.+?)\/;/)[1]);
const TYPED_FORM = new RegExp(src.match(/var TYPED_FORM = \/(.+?)\/;/)[1]);
const EMPTY_FIELD = new RegExp(src.match(/var EMPTY_FIELD = \/(.+?)\/i;/)[1], 'i');
const window = { console: { warn() {} } };
const fn = new Function(
  'document', 'LINK_ALLOWLIST', 'URL_PATTERN', 'BULLET', 'LABEL',
  'TYPED_FORM', 'EMPTY_FIELD', 'window',
  code + '; return {renderRich};',
);
const { renderRich } = fn(document, LINK_ALLOWLIST, URL_PATTERN, BULLET, LABEL,
  TYPED_FORM, EMPTY_FIELD, window);

function render(t) { const el = new Node2('div'); renderRich(el, t); return el; }

let fail = 0;
function t(name, input, expect) {
  const got = render(input).childNodes.map(c=>c.html()).join('');
  const ok = got === expect;
  if (!ok) fail++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+name);
  if (!ok) { console.log('        got:    ' + got); console.log('        expect: ' + expect); }
}

t('plain prose', 'PTE Academic is Rs 28,000.', '<p>PTE Academic is Rs 28,000.</p>');
t('bold', 'It is **Rs 35,000** total.', '<p>It is <strong>Rs 35,000</strong> total.</p>');
t('bullets', '- **IELTS** Rs 35,000\n- **PTE** Rs 28,000',
  '<ul><li><span><strong>IELTS</strong> Rs 35,000</span></li><li><span><strong>PTE</strong> Rs 28,000</span></li></ul>');
t('prose then bullets', 'Fees:\n- One\n- Two',
  '<p>Fees:</p><ul><li><span>One</span></li><li><span>Two</span></li></ul>');
t('allowlisted link', 'Practice at https://4skills.app now.',
  '<p>Practice at <a href="https://4skills.app" target="_blank" rel="noopener noreferrer">https://4skills.app</a> now.</p>');
t('allowlisted link with trailing period', 'See https://4skills.co/faq.',
  '<p>See <a href="https://4skills.co/faq" target="_blank" rel="noopener noreferrer">https://4skills.co/faq</a>.</p>');
t('OFF-allowlist url is plain text', 'Go to https://evil.example/pay now.',
  '<p>Go to https://evil.example/pay now.</p>');
t('lookalike domain is plain text', 'Try https://4skills.app.evil.com today.',
  '<p>Try https://4skills.app.evil.com today.</p>');
t('hallucinated 4skills path is plain text', 'See https://4skills.co/pricing here.',
  '<p>See https://4skills.co/pricing here.</p>');
t('html in reply is escaped, never markup', 'Hi <img src=x onerror=alert(1)> there',
  '<p>Hi &lt;img src=x onerror=alert(1)> there</p>');
t('script tag is inert text', '<script>alert(1)</script>',
  '<p>&lt;script>alert(1)&lt;/script></p>');
t('javascript: url not linkified', 'javascript:alert(1)', '<p>javascript:alert(1)</p>');
t('link inside bold still allowlisted', '**https://4skills.app**',
  '<p><strong><a href="https://4skills.app" target="_blank" rel="noopener noreferrer">https://4skills.app</a></strong></p>');
t('blank lines collapse', 'One\n\nTwo', '<p>One</p><p>Two</p>');
t('maps link is allowlisted', 'View on Google Maps: https://maps.app.goo.gl/iGJmsU1VvnyZCYcH6',
  '<p>View on Google Maps: <a href="https://maps.app.goo.gl/iGJmsU1VvnyZCYcH6" target="_blank" rel="noopener noreferrer">https://maps.app.goo.gl/iGJmsU1VvnyZCYcH6</a></p>');
// Only THIS maps URL. A different short link is someone else's pin.
t('a different maps short link stays plain text', 'See https://maps.app.goo.gl/somethingElse here',
  '<p>See https://maps.app.goo.gl/somethingElse here</p>');

// The prompt asks for "- ", but the model drifts to "* " on longer lists. Both
// must render as a list, or the panel shows literal asterisks to the visitor.
t('asterisk bullets also render as a list', '* One\n* Two', '<ul><li><span>One</span></li><li><span>Two</span></li></ul>');
t('mixed markers in one list', '- One\n* Two', '<ul><li><span>One</span></li><li><span>Two</span></li></ul>');
t('bold at line start is NOT a bullet', '**IELTS** costs Rs 35,000',
  '<p><strong>IELTS</strong> costs Rs 35,000</p>');
// "Label: value" inside a bullet — label at 500, value normal, same line.
// Outer span is the flex body wrapper, inner span is the label.
t('label:value in a bullet', '- Phone / WhatsApp: 0332 241 0155',
  '<ul><li><span><span>Phone / WhatsApp:</span> 0332 241 0155</span></li></ul>');
t('label:value keeps bold in the value', '- Phone: **0332 241 0155**',
  '<ul><li><span><span>Phone:</span> <strong>0332 241 0155</strong></span></li></ul>');
// A URL contains a colon. It must not be mistaken for a label.
t('url in a bullet is not a label', '- Practice at https://4skills.app',
  '<ul><li><span>Practice at <a href="https://4skills.app" target="_blank" rel="noopener noreferrer">https://4skills.app</a></span></li></ul>');
t('address line without a colon is plain', '- Jaranwala Road, Faisalabad',
  '<ul><li><span>Jaranwala Road, Faisalabad</span></li></ul>');
t('full reply shape', 'We offer two IELTS courses:\n\n- **IELTS Academic** — Rs 35,000\n- **IELTS General Training** — Rs 35,000\n\nBoth run 8 weeks.\n\nWhich one do you need?',
  '<p>We offer two IELTS courses:</p><ul><li><span><strong>IELTS Academic</strong> — Rs 35,000</span></li><li><span><strong>IELTS General Training</strong> — Rs 35,000</span></li></ul><p>Both run 8 weeks.</p><p>Which one do you need?</p>');

// A typed form must never reach the visitor, whatever the model writes.
t('underscore field lines are dropped',
  'Please fill this in:\nName: ______\nPhone Number: ______\nThanks.',
  '<p>Please fill this in:</p><p>Thanks.</p>');
t('bare empty field label is dropped', 'Name:\nOK', '<p>OK</p>');
t('dash rule is dropped', 'Above\n-----\nBelow', '<p>Above</p><p>Below</p>');
t('a real label:value bullet SURVIVES', '- Phone / WhatsApp: 0332 241 0155',
  '<ul><li><span><span>Phone / WhatsApp:</span> 0332 241 0155</span></li></ul>');
t('em dash in a fee bullet survives', '- **IELTS Academic** — Rs 35,000',
  '<ul><li><span><strong>IELTS Academic</strong> — Rs 35,000</span></li></ul>');

console.log('');
console.log(fail ? fail + ' FAILED' : 'all renderer tests passed');
process.exit(fail?1:0);
