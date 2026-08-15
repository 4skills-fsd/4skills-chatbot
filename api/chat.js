// POST /api/chat — one assistant turn.
//
// Always returns JSON, including on every failure path. The widget must never
// receive an HTML error page.

import { complete } from '../lib/groq.js';
import { currentBuild } from '../lib/build.js';
import { buildMessages, detectLanguage, isGreetingOnly } from '../lib/prompt.js';
import { retrieve } from '../lib/retrieve.js';
import {
  corsHeaders,
  gate,
  getClientIp,
  readJsonBody,
  sendJson,
  throttle,
} from '../lib/guard.js';

const MAX_MESSAGE_CHARS = 500;
const MAX_MESSAGES = 20;
/*
 * Throttling is keyed on the SESSION, with a loose per-IP backstop.
 *
 * Keying the real limit on IP was wrong for this audience. Pakistani mobile
 * carriers run CGNAT: hundreds of Jazz or Zong subscribers share one public
 * address. A 20-per-IP cap does not stop one abusive visitor, it locks out
 * everyone behind a busy carrier gateway — and they get the "you have sent a
 * lot of messages" notice having sent nothing at all.
 *
 * So: 20 per session per 10 minutes is the per-person limit, and 200 per IP per
 * 10 minutes is a backstop that only a script can reach.
 *
 * sessionId is client-supplied and trivially spoofable — a determined abuser
 * just rotates it. That is exactly why the IP backstop stays. The session key
 * is there to be fair to real people; the IP key is there to stop scripts.
 * Neither is sufficient alone.
 */
const THROTTLE_LIMIT = Number(process.env.CHAT_THROTTLE_LIMIT) || 20;
const THROTTLE_WINDOW_MS = 10 * 60_000;

// Deliberately high. Reaching this from one address takes automation.
const IP_BACKSTOP_LIMIT = Number(process.env.CHAT_IP_LIMIT) || 200;

const WHATSAPP = () => process.env.WHATSAPP_NUMBER || '923322410155';

// Shown when all three models are down or the key is missing. Never an error
// string — the visitor gets a way forward instead.
const DEGRADED_REPLY =
  'I cannot reach the assistant at the moment. Please WhatsApp 0332 241 0155 and the team will help you directly. Office hours are Monday to Friday 9:00 AM to 8:00 PM.';

// The model is told to emit this when it asks for a name and number. An 8B
// model will sometimes put it in the wrong place, so strip it wherever it lands
// rather than only at the end.
const LEAD_MARKER = /\[\[\s*LEAD\s*\]\]/gi;

// Backstop for when the model forgets the marker entirely.
const ENROL_INTENT =
  /\b(enrol|enroll|enrolment|enrollment|admission|admissions|daakhla|dakhla|join|register|registration|sign\s?up|apply|start|starting|shuru|call me|callback|call back|contact|visit|seat|book)\b|kab shuru|admission kaise|kaise/i;

function stripMarker(text) {
  return text
    .replace(LEAD_MARKER, '')
    .replace(/[ \t]{2,}/g, ' ') // marker removed mid-sentence leaves a gap
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep only the fields we send on, and only well-formed turns. */
function sanitiseMessages(input) {
  if (!Array.isArray(input)) return { error: 'messages_must_be_array' };
  if (input.length === 0) return { error: 'messages_empty' };
  if (input.length > MAX_MESSAGES) return { error: 'too_many_messages' };

  const out = [];
  for (const m of input) {
    if (!m || typeof m.content !== 'string') return { error: 'bad_message' };
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content.trim();
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) return { error: 'message_too_long' };
    out.push({ role, content });
  }

  if (!out.length) return { error: 'messages_empty' };
  return { messages: out };
}

export default async function handler(req, res) {
  const origin = gate(req, res);
  if (origin === null) return;
  const cors = corsHeaders(origin);

  try {
    const ip = getClientIp(req);

    const rateLimited = (limit) =>
      sendJson(
        res,
        429,
        {
          error: 'rate_limited',
          reply: `You have sent a lot of messages in a short time. Please try again in a few minutes, or WhatsApp 0332 241 0155 and someone will help you straight away.`,
          retryAfter: limit.retryAfter,
        },
        { ...cors, 'Retry-After': String(limit.retryAfter) },
      );

    // IP backstop first: it needs no body, so a script gets turned away before
    // we parse anything.
    const byIp = await throttle({
      key: `chat-ip:${ip}`,
      limit: IP_BACKSTOP_LIMIT,
      windowMs: THROTTLE_WINDOW_MS,
    });
    if (!byIp.ok) return rateLimited(byIp);

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const tooLarge = err.code === 'BODY_TOO_LARGE';
      return sendJson(
        res,
        tooLarge ? 413 : 400,
        { error: tooLarge ? 'body_too_large' : 'invalid_json' },
        cors,
      );
    }

    // The real per-person limit. Falls back to the IP when no session is sent —
    // otherwise every client without one would share a single bucket.
    const sessionKey =
      typeof body.sessionId === 'string' && body.sessionId
        ? body.sessionId.slice(0, 64)
        : `ip:${ip}`;

    const bySession = await throttle({
      key: `chat:${sessionKey}`,
      limit: THROTTLE_LIMIT,
      windowMs: THROTTLE_WINDOW_MS,
    });
    if (!bySession.ok) return rateLimited(bySession);

    const { messages, error } = sanitiseMessages(body.messages);
    if (error) {
      const friendly =
        error === 'message_too_long'
          ? `That message is a bit long. Could you shorten it to under ${MAX_MESSAGE_CHARS} characters?`
          : null;
      return sendJson(res, 400, { error, ...(friendly && { reply: friendly }) }, cors);
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const query = lastUser ? lastUser.content : '';

    // A greeting is not a question, so there is nothing to look up. Scoring it
    // anyway returned the location entry — retrieval always hands back its best
    // match, and the best match for a word carrying no information is still
    // something. Every "hi" was answered with the office address.
    const greeting = isGreetingOnly(query);
    const entries = greeting ? [] : retrieve(query);
    const retrievedIds = entries.map((e) => e.id);

    const result = await complete({
      messages: buildMessages(messages, entries),
      temperature: 0.3,
      // 110 words of prose plus bullet formatting. The cap is a runaway guard,
      // not a length target.
      maxTokens: 420,
    });

    // Which language the turn was steered to. Cheap, and it makes "why did it
    // answer in Urdu?" answerable from the network tab instead of by guessing —
    // that question has already cost one debugging session to a stale server.
    const headers = {
      ...cors,
      'x-fs-retrieved': retrievedIds.join(',') || (greeting ? 'skipped-greeting' : 'none'),
      'x-fs-lang': detectLanguage(query),
      // Compare against the build the widget logs in the browser console. If
      // they differ, the browser is running a cached widget.
      'x-fs-build': currentBuild(),
    };

    if (!result.ok) {
      console.error('[chat] all models failed', JSON.stringify(result.attempts));
      return sendJson(
        res,
        200,
        {
          reply: DEGRADED_REPLY,
          model: null,
          leadPrompt: false,
          degraded: true,
          whatsapp: `https://wa.me/${WHATSAPP()}`,
        },
        { ...headers, 'x-fs-model': 'none' },
      );
    }

    const markerSeen = LEAD_MARKER.test(result.reply);
    LEAD_MARKER.lastIndex = 0; // regex is /g — reset or the next .test() lies
    const reply = stripMarker(result.reply);

    // Backstop: the 8B model drops the marker often enough that intent alone
    // has to be able to trigger the form, but not on the opening message.
    const heuristic = ENROL_INTENT.test(query) && messages.length >= 3;

    // Session flags are client-owned and sent up with the request. There is no
    // server session and there should not be one. leadDeclined in particular is
    // what keeps a proactive bot from becoming a nagging one.
    const session = body.session || {};
    const leadPrompt =
      (markerSeen || heuristic) &&
      !session.leadCaptured &&
      !session.leadDeclined &&
      !session.leadAsked;

    // Token counters are debug-only and carry nothing sensitive. x-fs-cached is
    // how you confirm the static prefix is actually being cached in production —
    // if it sits at 0 across identical requests, prompt caching has broken and
    // the TPM headroom assumption in CLAUDE.md no longer holds.
    const usage = result.usage || {};
    return sendJson(
      res,
      200,
      { reply, model: result.model, leadPrompt },
      {
        ...headers,
        'x-fs-model': result.model,
        // The whole lead gate in one header, so "why did no form appear?" is
        // answerable from the network tab.
        'x-fs-lead': [
          `prompt=${leadPrompt}`,
          `src=${markerSeen ? 'marker' : heuristic ? 'heuristic' : 'none'}`,
          `asked=${!!session.leadAsked}`,
          `declined=${!!session.leadDeclined}`,
          `captured=${!!session.leadCaptured}`,
        ].join(' '),
        'x-fs-tokens': String(usage.prompt_tokens ?? 0),
        'x-fs-cached': String(usage.prompt_tokens_details?.cached_tokens ?? 0),
      },
    );
  } catch (err) {
    console.error('[chat] unhandled', err);
    return sendJson(
      res,
      200,
      {
        reply: DEGRADED_REPLY,
        model: null,
        leadPrompt: false,
        degraded: true,
        whatsapp: `https://wa.me/${WHATSAPP()}`,
      },
      { ...cors, 'x-fs-model': 'none' },
    );
  }
}
