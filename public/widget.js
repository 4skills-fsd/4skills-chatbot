/*
 * 4Skills assistant widget
 * ------------------------
 * Hand-written, zero dependencies, no build step. Served as-is from Vercel and
 * loaded by the PHP site with one <script defer> tag.
 *
 * If you are reading this in a year: it is meant to be read. Keep it that way.
 * Do not add a bundler.
 *
 * The host page loads Bootstrap 5, jQuery and a heavily hand-edited
 * bootstrap.min.css. Everything here lives inside a shadow root so none of that
 * can reach in and nothing here leaks out. The only global this file touches is
 * one guard flag on window.
 *
 * Replies come from POST {data-api}/api/chat. Conversation state lives in
 * browser memory and sessionStorage — no cookies, no accounts, no server
 * session. The lead form (phase 6) is not built yet; the server already returns
 * the leadPrompt flag and receive() parks it.
 */
(function () {
  'use strict';

  // Idempotent: footer.php getting included twice must not produce two widgets.
  if (window.__fourskillsWidget) return;
  window.__fourskillsWidget = true;

  var script =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]');

  function attr(name, fallback) {
    var v = script && script.getAttribute('data-' + name);
    return v === null || v === undefined || v === '' ? fallback : v;
  }

  var apiOrigin = '';
  try {
    apiOrigin = script ? new URL(script.src).origin : '';
  } catch (e) {
    apiOrigin = '';
  }

  var cfg = {
    api: attr('api', apiOrigin),
    practiceUrl: attr('practice-url', 'https://4skills.app'),
    // Read now, used in phase 5. Kept here so all config lives in one place.
    teaserDelay: parseInt(attr('teaser-delay', '8000'), 10),
    teaserInterval: parseInt(attr('teaser-interval', '45000'), 10),
    teaserMax: parseInt(attr('teaser-max', '3'), 10)
  };

  var WHATSAPP = 'https://wa.me/923322410155';
  var PHONE = '0332 241 0155';
  var MAX_CHARS = 500;
  var COUNTER_FROM = 400;
  // The server rejects arrays over 20, and only forwards the last 6 to the
  // model anyway. Keeping the client cap equal to the server cap means what we
  // store is exactly what we send.
  var MAX_HISTORY = 20;
  var REQUEST_TIMEOUT = 20000;

  var GREETING =
    'Hello. I can help with courses, fees, class timings and admissions at 4Skills. ' +
    'What would you like to know?';

  // Shown in order, one per appearance. Questions, not slogans.
  var TEASERS = [
    'Ask about IELTS or PTE fees',
    'Confused about IELTS vs PTE? Ask us',
    'Next batch timings? Ask here'
  ];
  var RESUME_TEASER = 'Continue your chat';
  var TEASER_VISIBLE_MS = 7000;

  var STARTERS = [
    'IELTS fees',
    'PTE fees',
    'Class timings',
    'How do I enrol?'
  ];

  /* ---------------------------------------------------------------- styles */
  /*
   * `all: initial` on :host wipes every inherited property coming from the host
   * page — its font stack, line-height, colour, text-transform, the lot — so the
   * widget renders identically regardless of what style.css does. Custom
   * properties are NOT reset by `all`, which is what lets the site's design
   * tokens still inherit through the shadow boundary below.
   *
   * Tokens are consumed with literal fallbacks so the widget also looks right on
   * 404.php, which has a standalone <head> and never loads tokens.css.
   */
  var CSS = [
    ':host{all:initial;position:fixed;right:0;bottom:0;z-index:2147483000;display:block;',
    // Deliberately fixed neutrals, NOT var(--color-navy) etc. The widget no
    // longer inherits the site's brand tokens: it is meant to read as a plain
    // neutral chat surface regardless of what the page around it is doing, so
    // borrowing navy and gold from tokens.css would defeat the point.
    '--fs-ink:#1A1A1A;',
    '--fs-ink-soft:#6B6B6B;',
    '--fs-surface:#FFFFFF;',

    // Glass, on the PANEL ONLY.
    //
    // 0.94, not 0.72. At 0.72 the page behind read through as a grey wash and
    // the whole thing looked dirty rather than frosted. At 0.94 you get the
    // depth cue — colour and movement behind the panel, softened — without the
    // surface losing its own whiteness.
    //
    // Nothing inside the panel gets a background or a blur of its own. The
    // header and composer are transparent and sit directly on this one surface,
    // which is what makes it read as a single sheet instead of stacked slabs.
    // Do not add a veil to either: the header is a flex sibling, so content
    // cannot scroll under it, and that was the only reason a veil ever existed.
    // TINTED, and that is the whole point. When the panel was white and the
    // message cards were white, the cards were invisible — there was nothing
    // for them to sit on. The grey tint is what gives the white cards an edge
    // to read against, so the hierarchy comes from the surface, not from
    // borders doing all the work.
    '--fs-glass:rgba(240,240,242,0.92);',
    '--fs-glass-edge:rgba(0,0,0,0.08);',
    '--fs-shadow:0 20px 60px rgba(0,0,0,0.16);',
    '--fs-blur:blur(32px) saturate(180%);',
    // The floating launcher pieces sit on the PAGE, not on the panel, and have
    // no cards inside them to separate. They keep a white frost — a grey bubble
    // on a white page just looks dingy.
    '--fs-glass-light:rgba(255,255,255,0.92);',
    '--fs-glass-light-edge:rgba(0,0,0,0.06);',

    '--fs-user-bg:#E3E3E6;',
    '--fs-hover:#F5F5F5;',
    '--fs-line:#E5E5E5;',
    '--fs-line-strong:#D4D4D4;',

    // Every animation in the widget uses this one curve. Shared so the panel,
    // the messages and the FAB feel like the same object moving.
    '--fs-ease:cubic-bezier(0.16,1,0.3,1);',
    '--fs-radius:20px;',
    '--fs-radius-bubble:16px;',
    '--fs-round:999px;',
    '--fs-gap:20px;',
    '--fs-rail:18px;',
    '--fs-cluster:106px;}',

    // Heebo is already loaded by the host page. A second font request inside a
    // chat widget is not worth the bytes.
    // Every inheritable property that matters is redeclared HERE, inside the
    // shadow root, and not left to `all:initial` on :host.
    //
    // `all:initial` on :host does not hold. The host element is a <div> in the
    // outer document, and outer-document rules beat :host rules regardless of
    // specificity — so the site's `div{letter-spacing:2px}` landed on the host
    // and inherited straight down into the shadow tree. font-family and
    // line-height were already redeclared here and survived; letter-spacing was
    // not, and every word in the widget came out tracked out.
    //
    // If you add a property to the host page that inherits, add it here too.
    '.fs-root{font-family:Heebo,system-ui,-apple-system,"Segoe UI",sans-serif;',
    'font-size:15px;line-height:1.5;color:var(--fs-ink);',
    'letter-spacing:normal;word-spacing:normal;text-transform:none;',
    'text-align:left;text-indent:0;font-style:normal;font-weight:400;',
    'font-variant:normal;white-space:normal;direction:ltr;',
    '-webkit-font-smoothing:antialiased;pointer-events:none;}',

    '.fs-root *,.fs-root *::before,.fs-root *::after{box-sizing:border-box;}',

    // Focus rings must be defined in here — the host stylesheet cannot reach
    // into the shadow root to provide them.
    '.fs-root :focus-visible{outline:2px solid var(--fs-ink);outline-offset:2px;}',

    /* launcher cluster */
    '.fs-cluster{position:fixed;right:var(--fs-gap);bottom:var(--fs-gap);',
    'display:flex;flex-direction:column;align-items:flex-end;gap:10px;}',

    '.fs-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;',
    'height:40px;padding:0 16px;border-radius:var(--fs-round);background:var(--fs-glass);',
    '-webkit-backdrop-filter:var(--fs-blur);backdrop-filter:var(--fs-blur);',
    'color:var(--fs-ink);border:1px solid var(--fs-glass-light-edge);text-decoration:none;',
    'font-weight:500;font-size:13px;line-height:1;white-space:nowrap;',
    'box-shadow:0 2px 8px rgba(0,0,0,0.08);cursor:pointer;',
    'transition:background-color 140ms ease;}',
    '.fs-pill:hover{background:#FFFFFF;}',

    '.fs-fab{pointer-events:auto;position:relative;width:56px;height:56px;border-radius:50%;',
    'border:0;padding:0;background:var(--fs-ink);color:#FFFFFF;cursor:pointer;',
    'display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,0.18);',
    'transition:transform 180ms var(--fs-ease),background-color 180ms ease;}',
    '.fs-fab:hover{background:#000000;transform:scale(1.04);}',
    '.fs-fab:active{transform:scale(0.96);}',
    // One pulse, not a loop: the FAB acknowledges the bubble and stops.
    '.fs-fab.fs-pulse{animation:fs-fab-pulse 900ms ease-out 1;}',
    '@keyframes fs-fab-pulse{0%{box-shadow:0 6px 20px rgba(0,0,0,0.18);}',
    '45%{box-shadow:0 8px 30px rgba(0,0,0,0.30);}',
    '100%{box-shadow:0 6px 20px rgba(0,0,0,0.18);}}',

    // Unread dot: only ever shown when a stored conversation is waiting. White
    // on the dark FAB — a coloured dot would be the only accent on the page.
    '.fs-unread{position:absolute;top:3px;right:3px;width:10px;height:10px;border-radius:50%;',
    'background:#FFFFFF;border:2px solid var(--fs-ink);}',
    '.fs-unread[hidden]{display:none;}',

    /* teaser bubble */
    '.fs-teaser{pointer-events:auto;position:relative;display:flex;align-items:center;gap:8px;',
    'max-width:240px;padding:12px 14px;background:var(--fs-glass-light);color:var(--fs-ink);',
    '-webkit-backdrop-filter:var(--fs-blur);backdrop-filter:var(--fs-blur);',
    'border:1px solid var(--fs-glass-light-edge);',
    'border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,0.14);',
    'font-size:13px;line-height:1.4;cursor:pointer;text-align:left;',
    'transform-origin:100% 130%;animation:fs-teaser-in 260ms var(--fs-ease);}',
    '.fs-teaser[hidden]{display:none;}',
    // Tail, pointing down-right toward the FAB.
    '.fs-teaser::after{content:"";position:absolute;right:18px;bottom:-6px;width:10px;height:10px;',
    'background:rgba(255,255,255,0.92);border-right:1px solid var(--fs-glass-light-edge);',
    'border-bottom:1px solid var(--fs-glass-light-edge);transform:rotate(45deg);}',
    // A button that must not look like one — UA button styles apply inside the
    // shadow root, `all:initial` on :host only resets the host itself.
    '.fs-teaser-text{flex:1 1 auto;border:0;padding:0;margin:0;background:transparent;',
    'font-family:inherit;font-size:inherit;line-height:inherit;color:inherit;',
    'text-align:left;cursor:pointer;}',
    '.fs-teaser-x{flex:0 0 auto;width:20px;height:20px;border:0;padding:0;border-radius:4px;',
    'background:transparent;color:var(--fs-ink-soft);cursor:pointer;display:grid;place-items:center;}',
    '.fs-teaser-x:hover{background:var(--fs-hover);color:var(--fs-ink);}',
    '@keyframes fs-teaser-in{from{opacity:0;transform:scale(.92) translateY(6px);}}',

    /* panel */
    // 16px clear of every viewport edge it touches, so the radius and shadow
    // are always visible and the panel reads as floating above the page rather
    // than welded to the corner.
    // Wider than it is tall, and 20px clear of every viewport edge, so the
    // radius and the shadow are always visible on all four corners.
    '.fs-panel{pointer-events:auto;position:fixed;right:var(--fs-gap);',
    'bottom:calc(var(--fs-gap) + var(--fs-cluster) + 12px);',
    'width:420px;height:520px;',
    'max-height:calc(100vh - var(--fs-cluster) - var(--fs-gap) * 2 - 12px);',
    'background:var(--fs-glass);',
    '-webkit-backdrop-filter:var(--fs-blur);backdrop-filter:var(--fs-blur);',
    'border:1px solid var(--fs-glass-edge);',
    'border-radius:var(--fs-radius);',
    // No inset white highlight — it fights the tint and reads as a seam.
    'box-shadow:var(--fs-shadow);',
    'display:flex;flex-direction:column;overflow:hidden;',
    'transform-origin:100% 100%;animation:fs-in 220ms var(--fs-ease);}',
    '.fs-panel[hidden]{display:none;}',
    '@keyframes fs-in{from{opacity:0;transform:scale(.96);}}',
    // Closing is faster and flatter than opening. The panel stays in the DOM
    // for the duration — closePanel() hides it when this finishes.
    '.fs-panel.fs-closing{animation:fs-out 160ms ease-in forwards;}',
    '@keyframes fs-out{to{opacity:0;transform:scale(.96);}}',

    // Back in normal flow, with no background and no border. It does not need a
    // layer of its own now the panel is opaque — content physically cannot
    // scroll under a flex sibling, which is what the overlay + veil was for.
    // Header, messages and composer are one continuous white surface.
    // 10px vertical, not 12: 10 + 22 (the mark) + 10 = 42, which keeps the
    // header under 44. The mark is the tallest thing in the row, so the padding
    // is the variable that gives.
    '.fs-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;',
    'padding:10px var(--fs-rail);color:var(--fs-ink);}',
    '.fs-mark{flex:0 0 auto;width:22px;height:22px;display:block;border-radius:6px;}',
    '.fs-title{font-weight:500;font-size:15px;line-height:1.2;}',
    // 20px, not 32px: at 14px vertical padding anything larger pushes the
    // header past 48px. The mobile block below restores a proper touch target,
    // where the sheet is full-screen and the height is not precious.
    '.fs-new,.fs-close{width:18px;height:18px;border:0;border-radius:var(--fs-round);',
    'background:transparent;color:var(--fs-ink-soft);cursor:pointer;display:grid;place-items:center;',
    'flex:0 0 auto;padding:0;transition:color 140ms ease;}',
    '.fs-title{margin-right:auto;}',
    '.fs-new:hover,.fs-close:hover{color:var(--fs-ink);}',

    // Same 20px rail as the header and composer, so all three align.
    '.fs-log{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;',
    'padding:4px var(--fs-rail) 12px;',
    'display:flex;flex-direction:column;gap:10px;',
    'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,0.15) transparent;}',
    '.fs-log::-webkit-scrollbar{width:6px;}',
    '.fs-log::-webkit-scrollbar-track{background:transparent;}',
    '.fs-log::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:3px;}',
    '.fs-log::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.25);}',

    '.fs-msg{overflow-wrap:anywhere;}',
    // Applied only to messages arriving live. Restoring a thread from
    // sessionStorage must not replay six animations at once.
    '.fs-msg.fs-enter,.fs-chips.fs-enter,.fs-lead.fs-enter{',
    'animation:fs-msg-in 240ms var(--fs-ease);}',
    '@keyframes fs-msg-in{from{opacity:0;transform:translateY(8px);}}',
    // User turns keep a bubble so the thread is still readable at a glance.
    // pre-wrap only here — assistant text is rendered into real elements.
    '.fs-msg.fs-user{align-self:flex-end;max-width:82%;padding:9px 13px;font-size:14px;',
    'line-height:1.5;white-space:pre-wrap;border:0;',
    'background:var(--fs-user-bg);color:var(--fs-ink);border-radius:14px;}',
    // A raised sheet ON the glass, not a second frosted layer — hence a light
    // translucent fill and a hairline shadow, but deliberately no blur of its
    // own. Two stacked backdrop-filters read as a smudge, not as depth.
    // Opaque white, never translucent, and never blurred. The panel is tinted
    // so a solid card has something to sit on; a translucent one would pick up
    // the tint and disappear again.
    '.fs-msg.fs-bot{align-self:stretch;max-width:100%;font-size:14px;line-height:1.45;',
    'color:var(--fs-ink);background:#FFFFFF;',
    'border:1px solid rgba(0,0,0,0.07);border-radius:14px;padding:10px 12px;',
    'box-shadow:0 1px 2px rgba(0,0,0,0.04);}',
    '.fs-msg.fs-error{color:var(--fs-ink);}',
    '.fs-msg strong{font-weight:500;}',
    // No colour. The underline carries the affordance and darkens on hover.
    '.fs-msg a{color:inherit;font-weight:inherit;text-decoration:underline;',
    'text-decoration-thickness:1px;text-underline-offset:2px;',
    'text-decoration-color:rgba(0,0,0,0.25);',
    'transition:text-decoration-color 140ms ease;}',
    '.fs-msg a:hover{text-decoration-color:#000000;}',

    /* structured assistant replies */
    '.fs-p{margin:0 0 6px;}',
    '.fs-msg > .fs-p:last-child,.fs-msg > .fs-list:last-child{margin-bottom:0;}',
    // Hang indent: the marker sits in the 14px gutter and wrapped lines align
    // under the text, not under the dot.
    '.fs-list{margin:0 0 6px;padding:0;list-style:none;}',
    // Flex row: the bullet is one item, the whole body is the other, so a
    // wrapped line aligns under the text rather than under the marker.
    '.fs-list li{display:flex;gap:9px;margin:0 0 3px;}',
    '.fs-list li:last-child{margin-bottom:0;}',
    '.fs-list li::before{content:"•";color:#B0B0B0;flex:0 0 auto;line-height:1.45;}',
    '.fs-li-body{flex:1 1 auto;min-width:0;}',
    '.fs-label{font-weight:500;}',

    '.fs-chips{display:flex;flex-wrap:wrap;gap:7px;align-self:flex-start;max-width:100%;}',
    '.fs-chip{border:1px solid rgba(0,0,0,0.1);background:#FFFFFF;',
    'border-radius:var(--fs-round);',
    'padding:6px 13px;font-family:inherit;font-size:13px;font-weight:500;line-height:1.2;',
    'color:var(--fs-ink);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.03);',
    'transition:background-color 140ms ease,border-color 140ms ease,',
    'transform 140ms ease,box-shadow 140ms ease;}',
    '.fs-chip:hover{background:#FFFFFF;border-color:rgba(0,0,0,0.16);',
    'transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,0.08);}',
    // Desktop keeps the floating pill, so the in-panel chip is mobile-only.
    '.fs-chip-practice{display:none;text-decoration:none;}',

    '.fs-typing{align-self:flex-start;display:inline-flex;gap:10px;align-items:center;',
    'padding:4px 0;}',
    // Static by design — only the dots move, so reduced-motion needs no rule here.
    '.fs-typing-mark{flex:0 0 auto;width:20px;height:20px;display:block;',
    'border-radius:6px;opacity:0.55;}',
    '.fs-dots{display:inline-flex;gap:5px;align-items:center;}',
    '.fs-dot{width:5px;height:5px;border-radius:50%;background:rgba(0,0,0,0.25);',
    'animation:fs-bounce 1.2s infinite ease-in-out;}',
    '.fs-dot:nth-child(2){animation-delay:.16s;}.fs-dot:nth-child(3){animation-delay:.32s;}',
    '@keyframes fs-bounce{0%,60%,100%{opacity:.3;}30%{opacity:1;}}',

    /* lead form — an inline card in the thread, never an overlay */
    '.fs-lead{align-self:stretch;border:1px solid var(--fs-line);',
    'border-radius:16px;padding:14px;background:#FAFAFA;}',
    '.fs-lead-head{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;}',
    '.fs-lead-title{flex:1 1 auto;font-size:13px;font-weight:600;color:var(--fs-ink);}',
    '.fs-lead-x{flex:0 0 auto;width:22px;height:22px;border:0;padding:0;border-radius:4px;',
    'background:transparent;color:var(--fs-ink-soft);cursor:pointer;display:grid;place-items:center;}',
    '.fs-lead-x:hover{background:var(--fs-hover);color:var(--fs-ink);}',
    '.fs-field{margin-bottom:8px;}',
    '.fs-field label{display:block;font-size:12px;font-weight:500;margin-bottom:3px;color:var(--fs-ink-soft);}',
    '.fs-field input,.fs-field select{width:100%;border:1px solid var(--fs-line-strong);border-radius:8px;',
    'padding:8px 9px;font-family:inherit;font-size:14px;color:inherit;background:#FFFFFF;}',
    '.fs-field input:focus,.fs-field select:focus{border-color:var(--fs-ink);}',
    // The one place a colour is still allowed: a validation error has to be
    // unmistakable, and grey-on-grey is not.
    '.fs-field.fs-bad input{border-color:#C0392B;}',
    '.fs-err{display:block;font-size:11px;color:#C0392B;margin-top:3px;}',
    '.fs-err[hidden]{display:none;}',
    '.fs-lead-submit{width:100%;border:0;border-radius:8px;padding:10px;background:var(--fs-ink);',
    'color:#FFFFFF;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-top:2px;}',
    '.fs-lead-submit:hover{background:#000000;}',
    '.fs-lead-submit:disabled{opacity:.5;cursor:default;}',
    '.fs-lead-note{font-size:11px;color:var(--fs-ink-soft);margin-top:8px;line-height:1.4;}',

    '.fs-wa{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;',
    'margin-top:4px;padding:11px;border-radius:8px;background:var(--fs-ink);color:#FFFFFF;',
    'font-size:14px;font-weight:600;text-decoration:none;}',
    '.fs-wa:hover{background:#000000;}',

    // ONE border, and it belongs to the pill.
    //
    // Before: .fs-composer had a border-top, .fs-input had its own border, and
    // the global :focus-visible rule added an outline on top of that — three
    // lines stacked around one control. Now the row draws the only border, the
    // textarea has none, and focus darkens that same border rather than adding
    // anything. The composer sits directly on the panel: no band, no divider.
    // Hairline only while the list is scrolled away from the bottom, so it
    // reports scroll position instead of sitting there as permanent chrome.
    // box-shadow rather than border-top: toggling a border would shift layout.
    '.fs-composer{flex:0 0 auto;padding:4px var(--fs-rail) 16px;',
    'transition:box-shadow 140ms ease;}',
    '.fs-composer.fs-detached{box-shadow:0 -1px 0 rgba(0,0,0,0.06);}',
    // 5 + 32 + 5 = 42px tall, exactly.
    '.fs-inputrow{display:flex;align-items:center;gap:8px;background:#FFFFFF;',
    'border:1px solid rgba(0,0,0,0.1);border-radius:var(--fs-round);',
    'padding:5px 5px 5px 16px;}',
    '.fs-inputrow:focus-within{border-color:var(--fs-ink);}',
    '.fs-input{flex:1 1 auto;resize:none;border:0;padding:0;margin:0;',
    'font-family:inherit;font-size:14px;line-height:1.5;color:inherit;background:transparent;',
    'min-height:21px;max-height:96px;overflow-y:auto;}',
    '.fs-input::placeholder{color:#A0A0A0;font-size:14px;}',
    // The pill border is the focus indicator. An outline here would rebuild the
    // doubled border this section exists to remove.
    '.fs-input:focus,.fs-input:focus-visible{outline:none;}',
    // 34px circle sitting inside the pill at its right edge.
    '.fs-send{flex:0 0 auto;width:32px;height:32px;border:0;border-radius:50%;',
    'background:var(--fs-ink);color:#FFFFFF;cursor:pointer;display:grid;place-items:center;',
    'transition:background-color 140ms ease,transform 140ms ease;}',
    '.fs-send:hover{background:#000000;}',
    '.fs-send:active:not(:disabled){transform:scale(0.94);}',
    '.fs-send:disabled{opacity:.3;cursor:default;}',
    '.fs-count{padding:0 var(--fs-rail) 6px;font-size:12px;color:var(--fs-ink-soft);text-align:right;}',
    '.fs-count[hidden]{display:none;}',
    '.fs-count.fs-over{color:#C0392B;font-weight:600;}',

    // Without backdrop-filter a 0.94 panel is just a slightly washed white box.
    // Go fully solid rather than nearly-transparent-for-no-reason. Border,
    // shadow and geometry are unchanged, so nothing moves.
    '@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){',
    '.fs-panel{background:#F0F0F2;}',
    '.fs-teaser,.fs-pill{background:#FFFFFF;}',
    '}',

    /* mobile: full-screen sheet, pill collapses to icon so it stops crowding the FAB */
    '@media (max-width:479px){',
    /*
     * A sheet over the page, not a takeover. 56px of the site stays visible at
     * the top so the visitor can still see where they are, and the rounded top
     * corners are what make it read as a sheet rather than a new screen.
     *
     * `bottom` tracks --fs-kb, which the visualViewport listener sets to the
     * height the on-screen keyboard is covering. Without it the composer sits
     * underneath the keyboard: position:fixed resolves against the LAYOUT
     * viewport, which does not shrink when the keyboard opens.
     */
    '.fs-panel{top:56px;left:0;right:0;bottom:var(--fs-kb,0px);',
    'width:auto;height:auto;max-height:none;border:0;',
    'border-radius:20px 20px 0 0;',
    'box-shadow:0 -8px 32px rgba(0,0,0,0.12);background:#FFFFFF;',
    '-webkit-backdrop-filter:none;backdrop-filter:none;}',
    // Short conversations sit just above the composer instead of stranding the
    // visitor at the top of a tall empty column. The auto-margin pseudo-element
    // rather than justify-content:flex-end, which clips overflow when scrolled.
    '.fs-log{justify-content:flex-start;}',
    '.fs-log::before{content:"";margin-top:auto;}',
    // Clear the gesture bar and the notch.
    '.fs-composer{padding-bottom:max(16px,env(safe-area-inset-bottom));}',
    '.fs-head{padding-top:calc(10px + env(safe-area-inset-top));}',
    // The launchers float ABOVE the panel. With the panel open they sat over the
    // composer and over empty space; the header X is the only close control the
    // sheet needs.
    '.fs-root.fs-open .fs-cluster{display:none;}',
    '.fs-chip-practice{display:inline-block;}',
    // A 20px close button is a poor touch target. Off the desktop panel there is
    // no 48px header budget to protect, so give it a real one.
    '.fs-new,.fs-close{width:40px;height:40px;}',
    '.fs-close{margin-right:-10px;}',
    '.fs-pill-label{display:none;}',
    '.fs-pill{width:44px;height:44px;padding:0;justify-content:center;}',
    '}',

    // Reduced motion removes the movement, not the feature. Everything still
    // appears, dismisses and pulses on the same schedule — it just does not
    // slide, scale or fade to get there. closePanel() skips its exit delay too.
    '@media (prefers-reduced-motion:reduce){',
    '.fs-panel,.fs-panel.fs-closing,.fs-teaser,',
    '.fs-msg.fs-enter,.fs-chips.fs-enter,.fs-lead.fs-enter{animation:none;}',
    '.fs-dot{animation:none;opacity:.5;}',
    '.fs-fab.fs-pulse{animation:none;}',
    '.fs-chip,.fs-send,.fs-fab,.fs-composer,.fs-msg a{transition:none;}',
    '.fs-chip:hover,.fs-fab:hover,.fs-fab:active,.fs-send:active{transform:none;}',
    '}'
  ].join('');


  /* ------------------------------------------------------------------ logo */
  /*
   * The real mark is a FILE: public/logo.svg, fetched from the same origin the
   * widget already talks to. Replace that file and you are done — nothing here
   * changes.
   *
   * The tradeoff, stated plainly: this is the widget's only asset request. If
   * it is slow the header shows an empty 22px box for a moment, and if it fails
   * the browser would normally draw a broken-image icon. LOGO_FALLBACK is an
   * inlined copy of the same placeholder, swapped in on the error event, so a
   * 404 or a dead connection degrades to a working mark rather than a broken
   * one. Everything else in this widget is still request-free.
   */
  var LOGO_URL = (cfg.api ? cfg.api.replace(/\/$/, '') : '') + '/logo.svg';

  // Deliberately the small "4S" placeholder, NOT a copy of the real mark. This
  // constant ships in every byte of widget.js on every page load; inlining the
  // real 7.8KB logo here would cost more than the request it is insuring
  // against. It only ever appears if logo.svg fails outright.
  var LOGO_FALLBACK =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NCA0NCIgd2lkdGg9IjQ0IiBoZWlnaHQ9IjQ0Ij48cmVjdCB3aWR0aD0iNDQiIGhlaWdodD0iNDQiIHJ4PSIxMSIgZmlsbD0iIzFBMUExQSIvPjx0ZXh0IHg9IjIyIiB5PSIyMyIgZm9udC1mYW1pbHk9InN5c3RlbS11aSwtYXBwbGUtc3lzdGVtLFNlZ29lIFVJLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTciIGZvbnQtd2VpZ2h0PSI2MDAiIGZpbGw9IiNGRkZGRkYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJjZW50cmFsIj40UzwvdGV4dD48L3N2Zz4=";

  /** Point an <img> at the logo, with the inlined copy as its safety net. */
  function wireLogo(img) {
    if (!img) return;
    img.addEventListener('error', function onFail() {
      img.removeEventListener('error', onFail); // never loop on a bad fallback
      img.src = LOGO_FALLBACK;
      if (window.console && window.console.warn) {
        window.console.warn('[4Skills] logo.svg failed to load, using inline fallback');
      }
    });
    img.src = LOGO_URL;
  }

  /* ------------------------------------------------------------------ icons */
  function svg(paths, size) {
    return (
      '<svg width="' + (size || 24) + '" height="' + (size || 24) + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>'
    );
  }
  var ICON_CHAT = svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.4A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>');
  var ICON_CLOSE = svg('<path d="M18 6 6 18M6 6l12 12"/>');
  var ICON_EXT = svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 14);
  var ICON_SEND = svg('<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>', 18);
  var ICON_X_SMALL = svg('<path d="M18 6 6 18M6 6l12 12"/>', 13);
  // Circular arrow — start again.
  var ICON_NEW = svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>', 17);

  /* -------------------------------------------------------------- DOM build */
  var host = document.createElement('div');
  host.id = 'fourskills-widget';
  var root = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'fs-root';
  wrap.innerHTML = [
    // No aria-modal. Some screen readers take it as permission to drop the rest
    // of the page from virtual cursor navigation, and the host background is not
    // inert — that would strand a screen-reader user inside the widget with no
    // way back to the site. Focus is still trapped for Tab, and Escape closes.
    '<div class="fs-panel" role="dialog" aria-label="4Skills assistant" hidden>',
    '<div class="fs-head">',
    '<img class="fs-mark" alt="" width="22" height="22">',
    '<div class="fs-title">4Skills</div>',
    '<button class="fs-new" type="button" aria-label="Start a new chat">' + ICON_NEW + '</button>',
    '<button class="fs-close" type="button" aria-label="Close chat">' + ICON_CLOSE + '</button>',
    '</div>',
    '<div class="fs-log" role="log" aria-live="polite" aria-relevant="additions"></div>',
    '<div class="fs-count" hidden aria-live="polite"></div>',
    '<div class="fs-composer">',
    '<div class="fs-inputrow">',
    '<textarea class="fs-input" rows="1" maxlength="' + MAX_CHARS + '" ',
    'placeholder="Ask about fees, timings or admissions" aria-label="Your message"></textarea>',
    '<button class="fs-send" type="button" aria-label="Send message">' + ICON_SEND + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="fs-cluster">',
    // Not aria-live: the teaser is an unsolicited nudge, and announcing it
    // mid-sentence to a screen-reader user is exactly the interruption the
    // restraint elsewhere is trying to avoid. It is a button, reachable by Tab.
    '<div class="fs-teaser" hidden>',
    '<button class="fs-teaser-text" type="button"></button>',
    '<button class="fs-teaser-x" type="button" aria-label="Dismiss">' + ICON_X_SMALL + '</button>',
    '</div>',
    '<a class="fs-pill" href="#" target="_blank" rel="noopener noreferrer" ',
    'aria-label="Practice tests, opens in a new tab">',
    '<span class="fs-pill-label">Practice tests</span>' + ICON_EXT,
    '</a>',
    '<button class="fs-fab" type="button" aria-label="Open chat" aria-expanded="false">',
    // Icon lives in its own span so swapping it cannot wipe the unread dot.
    '<span class="fs-fab-icon">' + ICON_CHAT + '</span>',
    '<span class="fs-unread" hidden></span>',
    '</button>',
    '</div>'
  ].join('');
  root.appendChild(wrap);

  // Set as a property, not interpolated into the innerHTML above, and only if
  // it is a real http(s) URL — so a malformed data-practice-url can never
  // become markup or a javascript: link.
  var pill = root.querySelector('.fs-pill');
  pill.href = /^https?:\/\//i.test(cfg.practiceUrl) ? cfg.practiceUrl : 'https://4skills.app';

  var panel = root.querySelector('.fs-panel');
  var fab = root.querySelector('.fs-fab');
  var fabIcon = root.querySelector('.fs-fab-icon');
  var unread = root.querySelector('.fs-unread');
  var teaser = root.querySelector('.fs-teaser');
  var teaserText = root.querySelector('.fs-teaser-text');
  var teaserClose = root.querySelector('.fs-teaser-x');
  var closeBtn = root.querySelector('.fs-close');
  var newBtn = root.querySelector('.fs-new');
  wireLogo(root.querySelector('.fs-mark'));
  var log = root.querySelector('.fs-log');
  var input = root.querySelector('.fs-input');
  var sendBtn = root.querySelector('.fs-send');
  var counter = root.querySelector('.fs-count');
  var composer = root.querySelector('.fs-composer');

  /* ---------------------------------------------------------------- storage */
  /*
   * Every link on the PHP site is a full page load, so without this the chat
   * resets the moment anyone clicks anything. sessionStorage rather than
   * localStorage — a conversation should not outlive the browsing session.
   *
   * All access is wrapped: Safari in private mode throws on sessionStorage.
   * If storage is unavailable the widget still works, it just forgets on
   * navigation. That is a degraded experience, not a broken one.
   */
  var KEY_CHAT = 'fourskills.chat';
  var KEY_FLAGS = 'fourskills.session';
  var KEY_SID = 'fourskills.sid';

  function readStore(key, fallback) {
    try {
      var raw = window.sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* private mode, or quota — carry on without persistence */
    }
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ------------------------------------------------------------------ state */
  var open = false;
  var busy = false;
  var hydrated = false;

  var sessionId = readStore(KEY_SID, null);
  if (!sessionId) {
    sessionId = uuid();
    writeStore(KEY_SID, sessionId);
  }

  /*
   * A RELOAD starts a fresh conversation. NAVIGATION continues the old one.
   *
   * Those are different intentions and were being treated the same. Every link
   * on the PHP site is a full page load, so the thread has to survive moving
   * from /courses to /faq — that is the whole reason for sessionStorage. But
   * pressing refresh on the page you are already on means "start again", and
   * restoring six old turns there makes it look like the assistant repeated
   * itself. It also made testing nearly impossible: a restored reply is
   * indistinguishable from a newly generated one.
   *
   * The Navigation Timing type is the precise signal. Where it is unavailable,
   * fall back to comparing the URL we stored last time.
   */
  var KEY_URL = 'fourskills.url';

  function isReload() {
    try {
      var nav =
        window.performance &&
        window.performance.getEntriesByType &&
        window.performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) return nav.type === 'reload';
      if (window.performance && window.performance.navigation) {
        return window.performance.navigation.type === 1;
      }
    } catch (e) {
      /* fall through */
    }
    return readStore(KEY_URL, null) === location.href;
  }

  // Real conversation turns only. Error notices and rate-limit messages are
  // rendered but never stored — they are not model output and must not be
  // replayed back to the model as if the assistant had said them.
  var history = readStore(KEY_CHAT, []);
  if (!Array.isArray(history)) history = [];


  // Client-owned lead flags, sent up with each request. There is no server
  // session and there should not be one. leadDeclined is the flag that stops a
  // proactive bot turning into a nagging one; phase 6 sets it.
  var flags = readStore(KEY_FLAGS, {}) || {};

  function persist() {
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    writeStore(KEY_CHAT, history);
  }

  /**
   * Wipe the thread.
   *
   * `hard` also clears the lead flags — that is the explicit "New chat" action.
   * A reload is softer: it drops the conversation but KEEPS leadCaptured and
   * leadDeclined, because those are facts about the person, not about the
   * thread. Someone who already gave their number, or already said no, should
   * not be asked again just because they hit refresh.
   */
  function resetConversation(hard) {
    history = [];
    writeStore(KEY_CHAT, history);

    if (hard) {
      flags = {};
    } else {
      flags = {
        leadCaptured: !!flags.leadCaptured,
        leadDeclined: !!flags.leadDeclined
      };
    }
    writeStore(KEY_FLAGS, flags);
  }

  if (isReload()) resetConversation(false);
  writeStore(KEY_URL, location.href);

  /* --------------------------------------------------------------- messages */
  /* ------------------------------------------------- structured rendering */
  /*
   * A deliberately tiny renderer for assistant replies. It supports exactly
   * three things — **bold**, "- " bullet lines, and links — and it builds every
   * node with createElement and textContent.
   *
   * There is no innerHTML and no markdown library anywhere in this path. Model
   * output is untrusted text: the moment it is parsed as HTML, a reply that
   * happens to contain a tag becomes markup, and a widget on a school's website
   * becomes an injection vector. Parsing to DOM nodes means the worst a strange
   * reply can do is look odd.
   *
   * Links are allowlisted, not validated. The model is told which four URLs it
   * may share; anything else it emits — a hallucinated page, a competitor, a
   * shortener — renders as plain text. An 8B model inventing a plausible URL is
   * a question of when, not whether, and a visitor cannot click text.
   */
  var LINK_ALLOWLIST = [
    'https://4skills.app',
    'https://www.youtube.com/@4SKILLS256',
    'https://4skills.co/faq',
    'https://4skills.co/success-stories-ielts'
  ];

  var URL_PATTERN = /https?:\/\/[^\s<>()\[\]"']+/g;

  /** Append `text`, turning only allowlisted URLs into anchors. */
  function appendWithLinks(target, text) {
    var last = 0;
    var match;
    URL_PATTERN.lastIndex = 0;

    while ((match = URL_PATTERN.exec(text)) !== null) {
      if (match.index > last) {
        target.appendChild(document.createTextNode(text.slice(last, match.index)));
      }

      // Trailing punctuation is sentence, not URL: "...at 4skills.app." must
      // not miss the allowlist because of the full stop.
      var url = match[0].replace(/[.,;:!?]+$/, '');
      var trailing = match[0].slice(url.length);

      if (LINK_ALLOWLIST.indexOf(url) !== -1) {
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = url;
        target.appendChild(a);
      } else {
        // Off-allowlist: shown, never clickable.
        target.appendChild(document.createTextNode(url));
      }

      if (trailing) target.appendChild(document.createTextNode(trailing));
      last = match.index + match[0].length;
    }

    if (last < text.length) {
      target.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  /** **bold** and links within one line. */
  function appendInline(target, text) {
    var parts = text.split(/(\*\*[^*]+\*\*)/g);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      if (part.length > 4 && part.slice(0, 2) === '**' && part.slice(-2) === '**') {
        var strong = document.createElement('strong');
        appendWithLinks(strong, part.slice(2, -2));
        target.appendChild(strong);
      } else {
        appendWithLinks(target, part);
      }
    }
  }

  /*
   * "Label: value" inside a bullet — "Phone / WhatsApp: 0332 241 0155" — sets
   * the label at 600 and leaves the value normal, so timings and fees line up
   * down the left without needing a table.
   *
   * The negative lookaheads keep URLs out of it. "Free practice tests at
   * https://4skills.app" contains a colon, and without the `//` guard the label
   * would become "Free practice tests at https".
   */
  var LABEL = /^(?!https?:)([^:]{1,30}):(?!\/\/)\s+(.+)$/;

  /*
   * The <li> is a flex row — marker, then body — so wrapped lines align under
   * the text rather than under the bullet. That means the body has to be ONE
   * element: appended straight to the li, every text node and <strong> would
   * become its own flex item and the line would stop wrapping.
   */
  function appendBulletBody(li, text) {
    var body = document.createElement('span');
    body.className = 'fs-li-body';
    li.appendChild(body);

    var m = LABEL.exec(text);
    if (!m) {
      appendInline(body, text);
      return;
    }
    var label = document.createElement('span');
    label.className = 'fs-label';
    label.textContent = m[1] + ':';
    body.appendChild(label);
    body.appendChild(document.createTextNode(' '));
    appendInline(body, m[2]);
  }

  // "- " is what the prompt asks for, but the model drifts to "* " on longer
  // lists. Both mean the same thing and both must render as a list — an
  // unrecognised marker shows up as a literal asterisk in the panel, which is
  // a visible defect caused by a formatting preference. Requires whitespace
  // after the marker, so "**bold**" at the start of a line is never a bullet.
  var BULLET = /^\s*[-*]\s+/;

  /*
   * A typed form is not a form.
   *
   * The model has written "Name: ______" and "Phone Number: ______" as literal
   * text instead of emitting [[LEAD]], which produces something that looks like
   * a form, cannot be filled in, and collects nothing. The prompt now forbids it
   * in the strongest terms it has — but the prompt is a request and this is a
   * guarantee. Anything shaped like a fill-in field is dropped before render.
   *
   * Matches a run of underscores or dashes, and a bare "Name:"/"Phone:" style
   * label with nothing useful after it. A label WITH a real value is left alone,
   * because that is the legitimate "Phone / WhatsApp: 0332 241 0155" bullet.
   */
  var TYPED_FORM = /_{3,}|-{3,}/;
  var EMPTY_FIELD = /^\s*[-*]?\s*(name|phone|phone number|number|email|contact)\s*:\s*[_\-.\s]*$/i;

  function stripTypedForm(lines) {
    var kept = [];
    var dropped = 0;

    for (var i = 0; i < lines.length; i++) {
      if (TYPED_FORM.test(lines[i]) || EMPTY_FIELD.test(lines[i])) {
        dropped++;
        continue;
      }
      kept.push(lines[i]);
    }

    if (dropped && window.console && window.console.warn) {
      window.console.warn(
        '[4Skills] dropped ' + dropped + ' typed-form line(s) from a reply. ' +
          'The model wrote a fake form instead of emitting [[LEAD]].',
      );
    }
    return kept;
  }

  /** Blocks: consecutive bullet lines become one list, everything else a paragraph. */
  function renderRich(el, text) {
    var lines = stripTypedForm(String(text).split('\n'));
    var i = 0;

    while (i < lines.length) {
      if (BULLET.test(lines[i])) {
        var ul = document.createElement('ul');
        ul.className = 'fs-list';
        while (i < lines.length && BULLET.test(lines[i])) {
          var li = document.createElement('li');
          appendBulletBody(li, lines[i].replace(BULLET, ''));
          ul.appendChild(li);
          i++;
        }
        el.appendChild(ul);
        continue;
      }

      if (lines[i].trim() === '') {
        i++;
        continue;
      }

      var p = document.createElement('p');
      p.className = 'fs-p';
      appendInline(p, lines[i]);
      el.appendChild(p);
      i++;
    }

    // A reply that was only whitespace would otherwise render as nothing.
    if (!el.childNodes.length) el.textContent = text;
  }

  /** True when the OS asks for less movement. Checked live, not cached. */
  function reduceMotion() {
    return (
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * Mark an element to animate in. Live messages only — replaying a restored
   * thread would fire six of these at once, which reads as a glitch rather
   * than as polish. hydrate() therefore never passes animate.
   */
  function entering(el, animate) {
    if (animate && !reduceMotion()) el.className += ' fs-enter';
    return el;
  }

  function addMessage(text, who, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'fs-msg ' + (who === 'user' ? 'fs-user' : 'fs-bot');
    if (opts.error) el.className += ' fs-error';
    // Default true: everything except hydrate() is a live arrival.
    entering(el, opts.animate !== false);

    if (who === 'user') {
      // The visitor's own words, verbatim, no formatting applied.
      el.textContent = text;
    } else {
      renderRich(el, text);
    }

    // Widget-authored link (the WhatsApp fallback), not model output, so the
    // allowlist does not apply — this href comes from our own constant.
    if (opts.link) {
      var wrap = document.createElement('p');
      wrap.className = 'fs-p';
      var a = document.createElement('a');
      a.href = opts.link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = opts.link.text;
      wrap.appendChild(a);
      el.appendChild(wrap);
    }

    log.appendChild(el);

    // Live assistant replies align to their top. User turns, restored history
    // and system notices keep the old behaviour.
    if (who === 'bot' && opts.animate !== false) scrollToTopOf(el);
    else scrollDown();

    return el;
  }

  function addChips() {
    var box = document.createElement('div');
    box.className = 'fs-chips';

    /*
     * On mobile the floating practice-tests pill is hidden while the panel is
     * open, so it needs a way back in. Same chip styling, sits with the
     * starters, hidden on desktop where the pill is still visible.
     */
    var practice = document.createElement('a');
    practice.className = 'fs-chip fs-chip-practice';
    practice.href = /^https?:\/\//i.test(cfg.practiceUrl) ? cfg.practiceUrl : 'https://4skills.app';
    practice.target = '_blank';
    practice.rel = 'noopener noreferrer';
    practice.textContent = 'Practice tests';
    box.appendChild(practice);

    STARTERS.forEach(function (label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fs-chip';
      b.textContent = label;
      b.addEventListener('click', function () {
        box.remove();
        submit(label);
      });
      box.appendChild(b);
    });
    log.appendChild(box);
    scrollDown();
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'fs-typing';
    t.setAttribute('aria-hidden', 'true');
    t.innerHTML =
      '<img class="fs-typing-mark" alt="" width="20" height="20">' +
      '<span class="fs-dots">' +
      '<span class="fs-dot"></span><span class="fs-dot"></span><span class="fs-dot"></span>' +
      '</span>';
    wireLogo(t.querySelector('.fs-typing-mark'));
    log.appendChild(t);
    scrollDown();
    return t;
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
    updateScrollEdge();
  }

  /*
   * Land on the TOP of a new assistant message, not the bottom of it.
   *
   * Scrolling to the very bottom put the visitor at the END of a long reply,
   * looking at the closing question with the answer above them, and they had to
   * scroll back up to read it. Aligning the top of the message to the top of
   * the viewport means they start reading at word one.
   *
   * Clamped to the real scroll maximum, which is what makes a short message
   * still land fully visible: there is nothing to scroll past, so it settles at
   * the bottom exactly as before.
   */
  function scrollToTopOf(el) {
    var logRect = log.getBoundingClientRect();
    var elRect = el.getBoundingClientRect();
    var target = log.scrollTop + (elRect.top - logRect.top) - 8;

    var max = log.scrollHeight - log.clientHeight;
    target = Math.max(0, Math.min(target, max));

    if (log.scrollTo) {
      log.scrollTo({ top: target, behavior: reduceMotion() ? 'auto' : 'smooth' });
    } else {
      log.scrollTop = target;
    }
    updateScrollEdge();
  }

  /** Hairline above the composer only while the list is scrolled up. */
  function updateScrollEdge() {
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= 2;
    if (atBottom) composer.classList.remove('fs-detached');
    else composer.classList.add('fs-detached');
  }

  /*
   * Rebuild the panel contents. Called once, on first open.
   *
   * The greeting is chrome, not a conversation turn: it is re-rendered on every
   * restore and never enters `history`, so it is never sent to the model and
   * never eats tokens. Starter chips only appear on a genuinely fresh
   * conversation — replaying them above a restored thread would be nonsense.
   */
  function hydrate() {
    if (hydrated) return;
    hydrated = true;

    // No entry animation anywhere in here — this is a bulk restore, and the
    // panel's own open animation already covers the moment.
    addMessage(GREETING, 'bot', { animate: false });

    if (history.length) {
      for (var i = 0; i < history.length; i++) {
        addMessage(history[i].content, history[i].role === 'user' ? 'user' : 'bot', {
          animate: false
        });
      }
    } else {
      addChips();
    }

    // Restored conversation already has assistant turns, so the chip belongs.
    if (history.some(function (m) { return m.role === 'assistant'; })) addCallbackChip();

    scrollDown();
  }

  /* --------------------------------------------------------------- sending */
  function submit(text) {
    text = (text || '').trim();
    if (!text || busy) return;

    // Caught here as well as server-side so the visitor gets a nudge instead of
    // a round trip that was always going to be rejected.
    if (text.length > MAX_CHARS) {
      addMessage(
        'That message is a bit long. Could you shorten it to under ' + MAX_CHARS + ' characters?',
        'bot'
      );
      return;
    }

    addMessage(text, 'user');
    history.push({ role: 'user', content: text });
    persist();

    input.value = '';
    autoGrow();
    updateCounter();
    setBusy(true);

    ask(showTyping());
  }

  function ask(typing) {
    var controller = window.AbortController ? new window.AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT);
    var settled = false;

    function done() {
      if (settled) return true;
      settled = true;
      window.clearTimeout(timer);
      typing.remove();
      setBusy(false);
      return false;
    }

    var options = {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history.slice(-MAX_HISTORY),
        sessionId: sessionId,
        session: flags
      })
    };
    if (controller) options.signal = controller.signal;

    window
      .fetch(cfg.api + '/api/chat', options)
      .then(function (res) {
        // The API always returns JSON, including on failure — but a proxy or a
        // Vercel outage can still hand back HTML, so parsing has to be able to
        // fail without taking the widget down.
        return res.json().then(
          function (body) {
            return { status: res.status, body: body };
          },
          function () {
            return { status: res.status, body: null };
          }
        );
      })
      .then(function (r) {
        if (done()) return;
        receive(r);
        if (!isNarrow()) input.focus();
      })
      .catch(function () {
        if (done()) return;
        showError();
      });
  }

  function receive(r) {
    var body = r.body;

    // No usable body: 403, a proxy error page, a parse failure. Give direction.
    if (!body || typeof body.reply !== 'string') {
      showError();
      return;
    }

    // All three models down, or the key is missing. The server still sends a
    // reply and a WhatsApp link rather than an error.
    if (body.degraded) {
      addMessage(body.reply, 'bot', {
        error: true,
        link: { href: body.whatsapp || WHATSAPP, text: 'Open WhatsApp' }
      });
      return;
    }

    // Rate limited, or validation rejected it. The server writes the copy for
    // these. Show it, but never store it — it is not something the assistant said.
    if (r.status !== 200) {
      addMessage(body.reply, 'bot');
      return;
    }

    addMessage(body.reply, 'bot');
    history.push({ role: 'assistant', content: body.reply });
    persist();

    // The server has already applied the session gates, but re-checking here
    // costs nothing and means a stale in-flight response cannot reopen a form
    // the visitor dismissed while it was on the wire.
    if (body.leadPrompt && !flags.leadDeclined && !flags.leadCaptured) {
      /*
       * leadAsked is set ONLY when a form actually reached the visitor.
       *
       * It used to be set before showLeadForm() ran, so a turn where the form
       * did not render still burned the one allowed ask — and because the flag
       * is sent back to the server on every request, the LATER turn where the
       * model genuinely emitted [[LEAD]] was suppressed as "already asked".
       * The visitor got a bot that talked about calling them twice and never
       * showed a form.
       *
       * Never set it on a heuristic match alone, on the model merely mentioning
       * a call, or on a turn where leadPrompt resolved false.
       */
      if (showLeadForm()) {
        flags.leadAsked = true;
        writeStore(KEY_FLAGS, flags);
      }
      logLead(body, true);
      return;
    }
    logLead(body, false);

    // Otherwise offer the quiet way in, once, after the first reply.
    addCallbackChip(true);
  }

  /** Makes the lead gate observable without a debugger. */
  function logLead(body, formShown) {
    if (!window.console || !window.console.log) return;
    window.console.log(
      '[4Skills] lead  leadPrompt=' + body.leadPrompt +
        '  formShown=' + formShown +
        '  asked=' + !!flags.leadAsked +
        '  declined=' + !!flags.leadDeclined +
        '  captured=' + !!flags.leadCaptured,
    );
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
  }

  /* -------------------------------------------------------------- lead form */
  /*
   * Rendered as a card inside the message thread, not as an overlay. The
   * composer stays live underneath the whole time, so a visitor who would
   * rather keep asking questions than hand over their number simply keeps
   * typing. That is the brief's "never blocks the chat", and it is also why
   * dismissing is a small × rather than a decision they have to make.
   *
   * Dismissing sets leadDeclined, which is sent up on every subsequent request
   * and hard-gates leadPrompt server-side for the rest of the session. Asked
   * once, then dropped.
   */
  var COURSES = [
    'IELTS Academic',
    'IELTS General Training',
    'PTE Academic',
    'Spoken English',
    'IELTS Life Skills A1',
    'Other'
  ];

  // Ordered longest-first so "IELTS General Training" wins over "IELTS".
  var COURSE_HINTS = [
    ['IELTS General Training', /general training|\bgt\b/i],
    ['IELTS Life Skills A1', /life skills|\ba1\b|spouse|marriage visa/i],
    ['IELTS Academic', /ielts|academic/i],
    ['PTE Academic', /\bpte\b/i],
    ['Spoken English', /spoken|speaking|conversation/i]
  ];

  /** Best guess at what the visitor is here for, from what they have typed. */
  function inferCourse() {
    var said = history
      .filter(function (m) { return m.role === 'user'; })
      .map(function (m) { return m.content; })
      .join(' ');
    for (var i = 0; i < COURSE_HINTS.length; i++) {
      if (COURSE_HINTS[i][1].test(said)) return COURSE_HINTS[i][0];
    }
    return '';
  }

  var leadCard = null;
  var callbackChip = null;

  /*
   * The way in to the lead form when the bot has not offered one.
   *
   * It used to be a full-width bar pinned above the composer, which cut the
   * panel into three unequal blocks and read as a third region of chrome. As a
   * chip in the thread it is just another thing the visitor can tap, in the
   * place they are already looking, and the panel stays one continuous surface.
   *
   * Appears once, after the assistant's first reply. Removed when the form
   * opens or the lead is captured; restored if the visitor declines the form,
   * because reopening it is their call.
   */
  function addCallbackChip(animate) {
    if (callbackChip || leadCard || flags.leadCaptured) return;

    var box = document.createElement('div');
    box.className = 'fs-chips';
    entering(box, animate);

    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fs-chip';
    chip.textContent = 'Request a call back';
    chip.addEventListener('click', showLeadForm);

    box.appendChild(chip);
    log.appendChild(box);
    callbackChip = box;
    scrollDown();
  }

  function removeCallbackChip() {
    if (callbackChip) callbackChip.remove();
    callbackChip = null;
  }

  /** @returns {boolean} true only if a form was actually put on screen. */
  function showLeadForm() {
    if (leadCard || flags.leadCaptured) return false;

    var guess = inferCourse();
    var card = document.createElement('div');
    card.className = 'fs-lead';
    entering(card, true);

    var options = COURSES.map(function (c) {
      return '<option value="' + c + '"' + (c === guess ? ' selected' : '') + '>' + c + '</option>';
    }).join('');

    card.innerHTML = [
      '<div class="fs-lead-head">',
      '<div class="fs-lead-title">Leave your name and number and the team will call you on WhatsApp.</div>',
      '<button class="fs-lead-x" type="button" aria-label="No thanks">' + ICON_X_SMALL + '</button>',
      '</div>',
      '<div class="fs-field fs-f-name"><label for="fs-name">Name</label>',
      '<input id="fs-name" type="text" autocomplete="name" maxlength="60">',
      '<span class="fs-err" hidden></span></div>',
      '<div class="fs-field fs-f-phone"><label for="fs-phone">Phone</label>',
      '<input id="fs-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0332 241 0155" maxlength="20">',
      '<span class="fs-err" hidden></span></div>',
      '<div class="fs-field"><label for="fs-course">Course</label>',
      '<select id="fs-course"><option value="">Not sure yet</option>' + options + '</select></div>',
      '<button class="fs-lead-submit" type="button">Request a call back</button>',
      '<div class="fs-lead-note">We’ll only use this to contact you about your enquiry.</div>'
    ].join('');

    log.appendChild(card);
    leadCard = card;
    removeCallbackChip();
    scrollDown();

    var nameEl = card.querySelector('#fs-name');
    var phoneEl = card.querySelector('#fs-phone');
    var courseEl = card.querySelector('#fs-course');
    var submitEl = card.querySelector('.fs-lead-submit');

    card.querySelector('.fs-lead-x').addEventListener('click', declineLead);
    submitEl.addEventListener('click', function () {
      sendLead(card, nameEl, phoneEl, courseEl, submitEl);
    });

    // Enter in either field submits, rather than doing nothing.
    [nameEl, phoneEl].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendLead(card, nameEl, phoneEl, courseEl, submitEl);
        }
      });
    });

    if (!isNarrow()) nameEl.focus();
    return true;
  }

  function declineLead() {
    flags.leadDeclined = true;
    writeStore(KEY_FLAGS, flags);
    if (leadCard) leadCard.remove();
    leadCard = null;
    // The chip comes back after a decline. Reopening it is the visitor's call,
    // not ours — we just stop offering unprompted.
    addCallbackChip(true);
    // No "are you sure", no second ask. They said no.
    input.focus();
  }

  function fieldError(card, which, message) {
    var field = card.querySelector('.fs-f-' + which);
    var err = field.querySelector('.fs-err');
    if (message) {
      field.className = 'fs-field fs-f-' + which + ' fs-bad';
      err.textContent = message;
      err.hidden = false;
    } else {
      field.className = 'fs-field fs-f-' + which;
      err.hidden = true;
    }
  }

  // Mirrors normalisePhone() in api/lead.js. Checked here so a typo costs no
  // round trip; the server still validates, because client checks are a
  // convenience and never a control.
  function looksLikePhone(v) {
    var d = String(v).replace(/[\s()\-.]/g, '');
    return /^(\+92|0092|92|0)3\d{9}$/.test(d);
  }

  function sendLead(card, nameEl, phoneEl, courseEl, submitEl) {
    var name = nameEl.value.trim();
    var phone = phoneEl.value.trim();
    var ok = true;

    if (name.length < 2) {
      fieldError(card, 'name', 'Please enter your name.');
      ok = false;
    } else fieldError(card, 'name', null);

    if (!looksLikePhone(phone)) {
      fieldError(card, 'phone', 'Please enter a valid mobile number, for example 0332 241 0155.');
      ok = false;
    } else fieldError(card, 'phone', null);

    if (!ok) return;

    submitEl.disabled = true;
    submitEl.textContent = 'Sending…';

    window
      .fetch(cfg.api + '/api/lead', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          phone: phone,
          course: courseEl.value,
          sessionId: sessionId,
          transcript: history.slice(-6),
          pageUrl: location.href,
          referrer: document.referrer
        })
      })
      .then(function (res) {
        return res.json().then(
          function (b) { return { status: res.status, body: b }; },
          function () { return { status: res.status, body: null }; }
        );
      })
      .then(function (r) {
        var body = r.body;

        if (body && body.fields) {
          submitEl.disabled = false;
          submitEl.textContent = 'Request a call back';
          fieldError(card, 'name', body.fields.name || null);
          fieldError(card, 'phone', body.fields.phone || null);
          return;
        }

        if (!body || !body.ok) {
          submitEl.disabled = false;
          submitEl.textContent = 'Request a call back';
          fieldError(
            card,
            'phone',
            (body && body.message) ||
              'Could not send that just now. Please WhatsApp ' + PHONE + '.'
          );
          return;
        }

        leadCaptured(card, name, body.whatsappUrl);
      })
      .catch(function () {
        submitEl.disabled = false;
        submitEl.textContent = 'Request a call back';
        fieldError(card, 'phone', 'Could not send that just now. Please WhatsApp ' + PHONE + '.');
      });
  }

  function leadCaptured(card, name, url) {
    flags.leadCaptured = true;
    writeStore(KEY_FLAGS, flags);

    card.remove();
    leadCard = null;
    removeCallbackChip();

    addMessage(
      'Thanks ' + name + '. The team will call you on WhatsApp during office hours, ' +
        'Monday to Friday 9:00 AM to 8:00 PM.',
      'bot'
    );

    var a = document.createElement('a');
    a.className = 'fs-wa';
    a.href = url || WHATSAPP;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Continue on WhatsApp';
    log.appendChild(a);
    scrollDown();
  }


  // Errors get direction, not an apology.
  function showError() {
    addMessage(
      "Can't reach the assistant right now. WhatsApp " + PHONE + ' and the team will help.',
      'bot',
      { error: true, link: { href: WHATSAPP, text: 'Open WhatsApp' } }
    );
  }

  /* -------------------------------------------------------------- composer */
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  }

  function updateCounter() {
    var n = input.value.length;
    if (n < COUNTER_FROM) {
      counter.hidden = true;
      return;
    }
    counter.hidden = false;
    counter.textContent = n + ' / ' + MAX_CHARS;
    counter.className = 'fs-count' + (n >= MAX_CHARS ? ' fs-over' : '');
  }

  log.addEventListener('scroll', updateScrollEdge, { passive: true });

  input.addEventListener('input', function () {
    autoGrow();
    updateCounter();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(input.value);
    }
  });

  sendBtn.addEventListener('click', function () {
    submit(input.value);
  });

  /* ------------------------------------------------------- open / close */
  function focusables() {
    var list = panel.querySelectorAll(
      'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(list, function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0;
    });
  }

  function isNarrow() {
    return window.matchMedia('(max-width:479px)').matches;
  }

  // Set while the close animation is running. Reopening mid-close has to cancel
  // it, or the panel would be hidden a moment after it reappeared.
  var closeTimer = null;

  function openPanel() {
    if (open) return;
    open = true;
    window.clearTimeout(closeTimer);
    closeTimer = null;
    panel.classList.remove('fs-closing');
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    fab.setAttribute('aria-label', 'Close chat');
    fabIcon.innerHTML = ICON_CLOSE;
    wrap.className = 'fs-root fs-open';
    // Opening the chat retires the teaser for the session, same as dismissing
    // it. Someone who has opened the panel does not need to be told it exists.
    finishTeaser();
    clearUnread();
    hydrate();
    // On a phone, focusing the textarea throws the keyboard up over the panel
    // before the visitor has read anything.
    (isNarrow() ? closeBtn : input).focus();
    scrollDown();
  }

  var CLOSE_MS = 160;

  function closePanel() {
    if (!open) return;
    open = false;
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-label', 'Open chat');
    fabIcon.innerHTML = ICON_CHAT;

    // Focus moves to the FAB immediately, not when the animation ends — a
    // keyboard user must never wait on a transition to know where they are.
    fab.focus();

    if (reduceMotion()) {
      panel.hidden = true;
      return;
    }

    panel.classList.add('fs-closing');
    closeTimer = window.setTimeout(function () {
      panel.hidden = true;
      panel.classList.remove('fs-closing');
      closeTimer = null;
    }, CLOSE_MS);
  }

  fab.addEventListener('click', function () {
    if (open) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  /**
   * Start over: clears the stored thread, the lead flags and what is on screen,
   * in one click. `hard` reset, because this is the visitor explicitly asking
   * for a blank slate rather than a side effect of a refresh.
   */
  newBtn.addEventListener('click', function () {
    resetConversation(true);

    while (log.firstChild) log.removeChild(log.firstChild);
    leadCard = null;
    callbackChip = null;
    hydrated = false;

    input.value = '';
    autoGrow();
    updateCounter();

    hydrate();
    if (!isNarrow()) input.focus();
  });

  // Escape closes and focus returns to the FAB. Tab cycles inside the panel
  // only — the visitor must not tab out into the host page behind an open
  // dialog and lose track of where they are.
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      closePanel();
      return;
    }
    if (e.key !== 'Tab' || !open) return;

    var f = focusables();
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var active = root.activeElement;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ----------------------------------------------------------------- teaser */
  /*
   * A nagging bubble is worse than no bubble. The restraint is the feature:
   *
   *   - first appearance after teaser-delay (8s)
   *   - then every teaser-interval (45s), up to teaser-max (3) times per session
   *   - messages rotate in order, one per appearance
   *   - auto-hides after 7s if ignored
   *   - dismissing it, or opening the chat, sets fourskills.teaser.done and it
   *     never returns for the rest of the session
   *
   * `done` is written to sessionStorage the moment it is set, so navigating the
   * PHP site does not reset the count and hand the visitor the same three
   * bubbles again on every page.
   */
  var KEY_TEASER = 'fourskills.teaser.done';
  var KEY_TEASER_N = 'fourskills.teaser.n';

  var teaserShown = readStore(KEY_TEASER_N, 0) || 0;
  var teaserDone = readStore(KEY_TEASER, 0) === 1;
  var teaserTimer = null;
  var teaserHideTimer = null;

  // Non-empty stored history means this visitor was mid-conversation on another
  // page. Rotating sales-ish nudges at someone who is already talking to us is
  // noise, so the rotation is suppressed entirely and replaced with one bubble
  // that does the only useful thing: get them back to the thread.
  var resuming = history.length > 0;

  /**
   * Retire the teaser for the rest of the session.
   *
   * `keepVisible` matters: when the LAST scheduled bubble has just been shown,
   * we are done scheduling but the bubble on screen should still live out its
   * 7 seconds. Without it, `teaserShown` hitting `teaserMax` hid the third
   * bubble in the same tick it appeared, so "3 per session" delivered 2.
   */
  function finishTeaser(keepVisible) {
    teaserDone = true;
    writeStore(KEY_TEASER, 1);
    window.clearTimeout(teaserTimer);
    teaserTimer = null;
    if (!keepVisible) stopTeaser();
  }

  function stopTeaser() {
    window.clearTimeout(teaserTimer);
    window.clearTimeout(teaserHideTimer);
    teaserTimer = null;
    teaserHideTimer = null;
    hideTeaser();
  }

  function hideTeaser() {
    teaser.hidden = true;
  }

  function pulseFab() {
    if (reduceMotion()) return;
    fab.classList.remove('fs-pulse');
    void fab.offsetWidth;
    fab.classList.add('fs-pulse');
    window.setTimeout(function () { fab.classList.remove('fs-pulse'); }, 950);
  }

  function showTeaser(text, force) {
    // `force` is the dev "Show teaser now" button: it ignores the done flag AND
    // an open panel, because once the panel has been opened the teaser is
    // retired for the session and can otherwise never be observed at all.
    if (!force && (open || teaserDone)) return;
    teaserText.textContent = text;
    teaser.hidden = false;
    // Restart the entry animation on every appearance.
    teaser.style.animation = 'none';
    void teaser.offsetWidth;
    teaser.style.animation = '';

    armTeaserHide();
    pulseFab();
  }

  /*
   * The 7s auto-hide is for people ignoring the bubble, not for people reading
   * it. Left running, it deletes the teaser out from under a keyboard user who
   * has just tabbed onto it — focus then falls to the body and they lose their
   * place on the page entirely. Hovering has the same problem in miniature.
   *
   * So the timer is cancelled while the bubble has focus or the pointer, and
   * only re-armed once both have left.
   */
  var teaserHover = false;

  function disarmTeaserHide() {
    window.clearTimeout(teaserHideTimer);
    teaserHideTimer = null;
  }

  function armTeaserHide() {
    // Deliberately NOT guarded on teaserDone: the final bubble is done but
    // still on screen, and it still has to auto-hide after a hover.
    if (teaser.hidden || teaserHover) return;
    if (root.activeElement && teaser.contains(root.activeElement)) return;
    disarmTeaserHide();
    teaserHideTimer = window.setTimeout(hideTeaser, TEASER_VISIBLE_MS);
  }

  teaser.addEventListener('mouseenter', function () {
    teaserHover = true;
    disarmTeaserHide();
  });
  teaser.addEventListener('mouseleave', function () {
    teaserHover = false;
    armTeaserHide();
  });
  teaser.addEventListener('focusin', disarmTeaserHide);
  teaser.addEventListener('focusout', function (e) {
    // Moving between the bubble's own two buttons is not leaving it.
    if (e.relatedTarget && teaser.contains(e.relatedTarget)) return;
    armTeaserHide();
  });

  function scheduleTeaser() {
    if (teaserDone || open) return;

    if (resuming) {
      // One bubble, no rotation, no repeats.
      teaserTimer = window.setTimeout(function () {
        showTeaser(RESUME_TEASER);
      }, cfg.teaserDelay);
      return;
    }

    if (teaserShown >= cfg.teaserMax) {
      finishTeaser();
      return;
    }

    var wait = teaserShown === 0 ? cfg.teaserDelay : cfg.teaserInterval;
    teaserTimer = window.setTimeout(function () {
      if (teaserDone || open) return;
      showTeaser(TEASERS[teaserShown % TEASERS.length]);
      teaserShown += 1;
      writeStore(KEY_TEASER_N, teaserShown);
      // keepVisible — this bubble has only just appeared.
      if (teaserShown >= cfg.teaserMax) finishTeaser(true);
      else scheduleTeaser();
    }, wait);
  }

  function clearUnread() {
    unread.hidden = true;
    fab.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  }

  teaserText.addEventListener('click', function () {
    finishTeaser();
    openPanel();
  });

  teaserClose.addEventListener('click', function (e) {
    e.stopPropagation();
    finishTeaser();
  });

  /* -------------------------------------------------- on-screen keyboard */
  /*
   * Keep the composer above the keyboard.
   *
   * `position: fixed` resolves against the LAYOUT viewport, and the layout
   * viewport does not shrink when the on-screen keyboard opens — so a panel
   * pinned to `bottom: 0` has its composer underneath the keyboard, and the
   * visitor types into something they cannot see.
   *
   * visualViewport reports the part actually visible. The difference is how much
   * the keyboard is covering; we publish it as --fs-kb and the mobile rule lifts
   * the panel's bottom edge by that much. The message list is `flex: 1`, so it
   * shrinks and the composer stays put — which is the requirement: the list
   * shrinks, it does not scroll behind the keyboard.
   *
   * Desktop never reads --fs-kb, so this costs nothing there.
   */
  function trackKeyboard() {
    var vv = window.visualViewport;
    if (!vv) return;

    function sync() {
      var covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Ignore a few px of rounding so we do not fight the browser's own chrome.
      host.style.setProperty('--fs-kb', (covered > 24 ? covered : 0) + 'px');
      if (open) scrollDown();
    }

    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  /* ------------------------------------------------------------------ boot */
  function mount() {
    document.body.appendChild(host);

    if (resuming) {
      unread.hidden = false;
      fab.setAttribute('aria-label', 'Open chat, you have an unfinished conversation');
    }

    scheduleTeaser();
    trackKeyboard();

    // Which build the browser is ACTUALLY running. The dev server prepends
    // __FS_BUILD__ and prints the same hash on boot; /api/chat returns it as
    // x-fs-build. If this line disagrees with either, this tab has a cached
    // widget and nothing you change will appear until you hard-refresh.
    // In production the stamp is absent and this reads "prod".
    if (window.console && window.console.log) {
      var build = window.__FS_BUILD__ || 'prod';
      window.console.log('[4Skills] widget build ' + build + '  api ' + (cfg.api || '(same origin)'));
    }

    // Dev-only handles, gated on the stamp the dev server injects. Absent in
    // production, so this exposes nothing on the live site.
    if (window.__FS_BUILD__) {
      window.__fourskillsDebug = {
        // Fires a bubble now, ignoring every timer and the done flag.
        showTeaser: function (text) {
          showTeaser(text || TEASERS[teaserShown % TEASERS.length], true);
        },
        resetTeaser: function () {
          teaserDone = false;
          teaserShown = 0;
          writeStore(KEY_TEASER, 0);
          writeStore(KEY_TEASER_N, 0);
          stopTeaser();
          scheduleTeaser();
        },
        state: function () {
          return { teaserDone: teaserDone, teaserShown: teaserShown, stored: history.length };
        }
      };
    }
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

})();
