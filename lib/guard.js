// Origin allowlist, per-IP throttle, and the small HTTP helpers both endpoints
// share.
//
// Handlers use plain Node req/res rather than Vercel's sugar (res.status().json()),
// so the same files run unchanged under `node scripts/dev-server.js` locally and
// on Vercel in production. One less thing that behaves differently in the two
// places.

const DEFAULT_ORIGINS = [
  'https://4skills.co',
  'https://www.4skills.co',
  'https://4skills.app',
];

const isProduction = () => process.env.NODE_ENV === 'production';

function allowlist() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/*
 * Validate ALLOWED_ORIGINS and say so loudly at boot.
 *
 * A real one, found in a working .env.local:
 *
 *   https://4skills.co,https://www.4skills.co,https://4skills.apphttps://<tunnel>
 *                                                              ^ missing comma
 *
 * That parses to three entries, the third being the nonsense string
 * "https://4skills.apphttps://<tunnel>". Nothing throws. ALLOWED_ORIGINS
 * REPLACES DEFAULT_ORIGINS entirely, so https://4skills.app silently stopped
 * being allowed — and a blocked origin gets a bare 403 with no CORS headers, so
 * the browser reports a generic CORS failure and the page shows nothing at all.
 * A typo in an env var becomes an invisible outage on one domain.
 *
 * Hence: parse it, print what it resolved to, and complain about anything that
 * cannot be a real origin. This only reports — it never rewrites the value,
 * because silently "fixing" an allowlist is how a wrong origin gets trusted.
 */
export function validateOrigins(raw = process.env.ALLOWED_ORIGINS) {
  const problems = [];

  if (!raw) {
    return { origins: DEFAULT_ORIGINS, problems, usingDefaults: true };
  }

  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const origins = entries.map((s) => s.replace(/\/$/, ''));

  for (const entry of origins) {
    // Two schemes in one entry is the missing-comma signature.
    const schemes = (entry.match(/:\/\//g) || []).length;
    if (schemes > 1) {
      problems.push(`"${entry}" contains ${schemes} "://" — a comma is probably missing`);
      continue;
    }
    if (schemes === 0) {
      problems.push(`"${entry}" has no scheme — an origin must start with http:// or https://`);
      continue;
    }

    let url;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`"${entry}" is not a parseable URL`);
      continue;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`"${entry}" uses ${url.protocol}, expected http: or https:`);
    }
    // An Origin header is scheme + host + port. Anything else never matches.
    if (url.pathname !== '/' || url.search || url.hash) {
      problems.push(`"${entry}" has a path, query or fragment — an Origin is scheme://host[:port] only`);
    }
    if (url.origin !== entry.replace(/\/$/, '')) {
      problems.push(`"${entry}" does not equal its own origin (${url.origin})`);
    }
  }

  return { origins, problems, usingDefaults: false };
}

/**
 * Print the resolved allowlist once, at boot. Called by the dev server and by
 * the first request in a serverless cold start.
 */
export function reportOrigins(log = console) {
  const { origins, problems, usingDefaults } = validateOrigins();

  log.log(
    `[guard] origin allowlist (${origins.length})` +
      (usingDefaults ? ' — ALLOWED_ORIGINS unset, using defaults' : ''),
  );
  for (const o of origins) log.log(`[guard]   ${o}`);

  for (const p of problems) {
    log.error(`[guard] *** BAD ALLOWED_ORIGINS ENTRY *** ${p}`);
  }
  if (problems.length) {
    log.error(
      '[guard] *** Requests from the affected origin will get a bare 403 with no CORS ' +
        'headers, which looks like a generic CORS error in the browser and shows nothing ' +
        'on the page. Fix ALLOWED_ORIGINS in the environment. ***',
    );
  }
  return problems;
}

export function readOrigin(req) {
  return req.headers.origin || '';
}

/*
 * Dev-only tunnel hosts.
 *
 * Testing the widget on a real phone means exposing the local server through a
 * tunnel, and the browser then sends the TUNNEL's origin — which is not in the
 * allowlist, so every /api/chat call came back 403 origin_not_allowed while the
 * widget itself loaded fine. Confusing symptom: the panel opens and every
 * message fails.
 *
 * Gated on NODE_ENV exactly like localhost, so this is unreachable in
 * production: Vercel sets NODE_ENV=production, and these patterns are never
 * consulted there. Set ALLOWED_ORIGINS if you need a tunnel host in a deployed
 * environment — do not loosen this.
 */
const DEV_TUNNEL_HOST =
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(ngrok-free\.(app|dev)|ngrok\.(io|app)|trycloudflare\.com|loca\.lt)$/i;

/**
 * Exact match against the allowlist. Off production, localhost on any port and
 * the tunnel hosts above are additionally allowed.
 */
export function isAllowedOrigin(origin) {
  if (!origin) return false;
  const clean = origin.replace(/\/$/, '');
  if (allowlist().includes(clean)) return true;
  if (isProduction()) return false;

  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) return true;
  if (DEV_TUNNEL_HOST.test(clean)) return true;

  return false;
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers':
      'x-fs-model, x-fs-retrieved, x-fs-tokens, x-fs-cached, x-fs-lang, x-fs-build, x-fs-lead, x-fs-error, x-fs-offer',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Vercel puts the real client IP first in x-forwarded-for. Falls back through
 * the usual suspects so the throttle still keys on something in local dev.
 */
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// --- throttle ---------------------------------------------------------------
//
// In-memory sliding window. This is NOT a real rate limiter: the Map lives in
// one serverless instance, resets on every cold start, and is not shared across
// concurrent instances. It stops one browser hammering the endpoint and nothing
// more. See CLAUDE.md.
//
// The interface is async and keyed by string so an Upstash Redis free tier can
// replace the body of throttle() without any caller changing.

const buckets = new Map();
const SWEEP_INTERVAL_MS = 60_000;
const MAX_RETAIN_MS = 60 * 60_000; // longest window any caller uses
let lastSweep = Date.now();

function sweep(now) {
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => now - t < MAX_RETAIN_MS);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
  lastSweep = now;
}

/**
 * @param {{key: string, limit: number, windowMs: number}} opts
 * @returns {Promise<{ok: boolean, remaining: number, retryAfter: number}>}
 */
export async function throttle({ key, limit, windowMs }) {
  const now = Date.now();
  if (now - lastSweep > SWEEP_INTERVAL_MS) sweep(now);

  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    buckets.set(key, hits);
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000),
    };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, remaining: limit - hits.length, retryAfter: 0 };
}

/** Test seam — the throttle tests need a clean slate between cases. */
export function resetThrottle() {
  buckets.clear();
}

// --- http helpers -----------------------------------------------------------

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Reads and parses the JSON body. Vercel may have parsed it already; if so we
 * use that. Rejects oversized bodies before buffering them.
 */
export async function readJsonBody(req, maxBytes = 64 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('Body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON');
    err.code = 'BAD_JSON';
    throw err;
  }
}

/**
 * Shared front door: preflight, method check, origin check.
 * Returns the origin string to echo on success, or null if it already replied.
 */
/*
 * Vercel has no boot, so the allowlist is reported on the first request of each
 * cold start instead. Once per instance, not once per request — otherwise a
 * busy day fills the log with the same three lines.
 */
let originsReported = false;

export function gate(req, res) {
  if (!originsReported) {
    originsReported = true;
    reportOrigins();
  }

  const origin = readOrigin(req);
  const allowed = isAllowedOrigin(origin);

  if (req.method === 'OPTIONS') {
    if (!allowed) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return null;
    }
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return null;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' }, allowed ? corsHeaders(origin) : {});
    return null;
  }

  if (!allowed) {
    // Deliberately no CORS headers here — a disallowed origin gets nothing back
    // it could read anyway.
    sendJson(res, 403, { error: 'origin_not_allowed' });
    return null;
  }

  return origin;
}
