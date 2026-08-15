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

export function readOrigin(req) {
  return req.headers.origin || '';
}

/**
 * Exact match against the allowlist. localhost on any port is additionally
 * allowed off production, so `vercel dev` and the local dev server work.
 */
export function isAllowedOrigin(origin) {
  if (!origin) return false;
  const clean = origin.replace(/\/$/, '');
  if (allowlist().includes(clean)) return true;
  if (!isProduction() && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) {
    return true;
  }
  return false;
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'x-fs-model, x-fs-retrieved, x-fs-tokens, x-fs-cached, x-fs-lang, x-fs-build, x-fs-lead',
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
export function gate(req, res) {
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
