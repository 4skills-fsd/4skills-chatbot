// POST /api/lead — capture a name and phone number.
//
// Two things happen, and they are deliberately independent: the lead is written
// to a Google Sheet as the durable record, and the visitor is handed a
// prefilled wa.me link. If the sheet write fails, the visitor still gets the
// link. Their path forward must never depend on our logging succeeding.

import {
  corsHeaders,
  gate,
  getClientIp,
  readJsonBody,
  sendJson,
  throttle,
} from '../lib/guard.js';

/*
 * Two keys, same as /api/chat: 3 per IP per hour, 5 per session per hour.
 *
 * Stricter than chat because nobody legitimately submits their number five
 * times in an hour. See the CGNAT note in chat.js for why the session key
 * exists at all — and note the IP number here is DELIBERATELY LOW and is
 * therefore still exposed to the CGNAT problem. That is a considered trade:
 * lead spam is worth blocking hard. If real leads start being refused from one
 * carrier, raise LEAD_IP_LIMIT rather than removing the session key.
 */
const THROTTLE_IP_LIMIT = Number(process.env.LEAD_IP_LIMIT) || 3;
const THROTTLE_SESSION_LIMIT = 5;
const THROTTLE_WINDOW_MS = 60 * 60_000;

const NAME_MIN = 2;
const NAME_MAX = 60;
const TRANSCRIPT_LINES = 6;

const WHATSAPP = () => process.env.WHATSAPP_NUMBER || '923322410155';

// Courses we will echo into the sheet and the WhatsApp message. Anything else
// is dropped rather than passed through — this string ends up in a URL and a
// spreadsheet, and there is no reason to accept free text for it.
const COURSES = [
  'IELTS Academic',
  'IELTS General Training',
  'PTE Academic',
  'Spoken English',
  'IELTS Life Skills A1',
  'Other',
];

/**
 * Pakistani mobile formats, normalised to +92XXXXXXXXXX.
 *
 *   03XXXXXXXXX     local
 *   +923XXXXXXXXX   international
 *   00923XXXXXXXXX  international with the 00 trunk prefix
 *
 * Separators are stripped first — people type 0332-241-0155 and 0332 241 0155
 * far more often than they type it clean.
 */
export function normalisePhone(input) {
  if (typeof input !== 'string') return null;

  const digits = input.replace(/[\s()\-.]/g, '');
  let rest;

  if (/^\+92\d{10}$/.test(digits)) rest = digits.slice(3);
  else if (/^0092\d{10}$/.test(digits)) rest = digits.slice(4);
  else if (/^92\d{10}$/.test(digits)) rest = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) rest = digits.slice(1);
  else return null;

  // Every Pakistani mobile is 3XXXXXXXXX once the country code is off.
  if (!/^3\d{9}$/.test(rest)) return null;
  return '+92' + rest;
}

function validName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) return null;
  // Letters, spaces, apostrophes, hyphens, dots. No digits, no control chars.
  if (!/^[\p{L}][\p{L}\s'.-]*$/u.test(clean)) return null;
  return clean;
}

function pickCourse(course) {
  return COURSES.includes(course) ? course : '';
}

/** Last few turns, flattened, so the team can see what the person asked about. */
function summariseTranscript(transcript) {
  if (!Array.isArray(transcript)) return '';
  return transcript
    .slice(-TRANSCRIPT_LINES)
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => `${m.role === 'assistant' ? 'Bot' : 'Visitor'}: ${m.content.slice(0, 300)}`)
    .join('\n');
}

function whatsappUrl(name, course) {
  const bits = [`Hello, my name is ${name}.`];
  bits.push(
    course && course !== 'Other'
      ? `I would like to know more about the ${course} course at 4Skills.`
      : 'I would like to know more about the courses at 4Skills.',
  );
  return `https://wa.me/${WHATSAPP()}?text=${encodeURIComponent(bits.join(' '))}`;
}

/**
 * Fire the lead at the Apps Script webhook. Never throws — the caller does not
 * care whether this worked.
 */
async function recordLead(row) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) {
    console.error('[lead] LEAD_WEBHOOK_URL not set, lead not recorded', row.sessionId);
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: controller.signal,
      redirect: 'follow', // Apps Script /exec bounces through script.googleusercontent.com
    });
    if (!res.ok) {
      console.error('[lead] webhook returned', res.status, row.sessionId);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[lead] webhook failed', String(err && err.message), row.sessionId);
    return false;
  } finally {
    clearTimeout(timer);
  }
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
          ok: false,
          error: 'rate_limited',
          message:
            'We already have your details. Please WhatsApp 0332 241 0155 if you need to reach the team sooner.',
        },
        { ...cors, 'Retry-After': String(limit.retryAfter) },
      );

    // IP first — no body needed, so a script is turned away before we parse.
    const byIp = await throttle({
      key: `lead-ip:${ip}`,
      limit: THROTTLE_IP_LIMIT,
      windowMs: THROTTLE_WINDOW_MS,
    });
    if (!byIp.ok) return rateLimited(byIp);

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(
        res,
        err.code === 'BODY_TOO_LARGE' ? 413 : 400,
        { ok: false, error: 'invalid_request' },
        cors,
      );
    }

    const sessionKey =
      typeof body.sessionId === 'string' && body.sessionId
        ? body.sessionId.slice(0, 64)
        : `ip:${ip}`;

    const bySession = await throttle({
      key: `lead:${sessionKey}`,
      limit: THROTTLE_SESSION_LIMIT,
      windowMs: THROTTLE_WINDOW_MS,
    });
    if (!bySession.ok) return rateLimited(bySession);

    const name = validName(body.name);
    const phone = normalisePhone(body.phone);

    // Field-level errors so the widget can mark the right input.
    if (!name || !phone) {
      return sendJson(
        res,
        400,
        {
          ok: false,
          error: 'validation_failed',
          fields: {
            ...(name ? {} : { name: 'Please enter your name.' }),
            ...(phone
              ? {}
              : { phone: 'Please enter a valid mobile number, for example 0332 241 0155.' }),
          },
        },
        cors,
      );
    }

    const course = pickCourse(body.course);
    const url = whatsappUrl(name, course);

    const row = {
      timestamp: new Date().toISOString(),
      name,
      phone,
      course,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : '',
      transcript: summariseTranscript(body.transcript),
      pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : '',
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : '',
    };

    const recorded = await recordLead(row);

    // ok:true either way. `recorded` is for our logs, not for the visitor's
    // path forward — a broken spreadsheet must not cost us the lead.
    return sendJson(res, 200, { ok: true, whatsappUrl: url, recorded }, cors);
  } catch (err) {
    console.error('[lead] unhandled', err);
    // Even here: hand back a usable WhatsApp link rather than an error.
    return sendJson(
      res,
      200,
      {
        ok: true,
        whatsappUrl: `https://wa.me/${WHATSAPP()}`,
        recorded: false,
      },
      cors,
    );
  }
}
