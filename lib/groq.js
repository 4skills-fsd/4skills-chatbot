// Groq client. Plain fetch against the OpenAI-compatible endpoint — no SDK, so
// there is nothing to keep updated.
//
// The fallback chain exists for two reasons. The obvious one is 429s when the
// free-tier TPM ceiling is hit. The less obvious one is that Groq retires model
// IDs on a rolling basis, and a retired ID returns 400/404, not 429 — so a
// decommissioned primary must also fall through rather than taking the widget
// down until someone notices.

/*
 * UPDATED 2026-08 — the whole Llama family was decommissioned on Groq.
 *
 * `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` both started returning
 * 404 model_not_found, which took out the primary AND the last fallback in one
 * go. The only reason the widget did not go dark is that the middle entry
 * survived — and on the day it broke, that one happened to be rate-limited too,
 * so every visitor got the WhatsApp fallback message.
 *
 * This is exactly the failure the chain exists for, and exactly why it lives in
 * GROQ_MODELS: verify against `GET /openai/v1/models` before assuming an ID is
 * still real. A 404 here is not a bug in this code.
 *
 * Note this promotes a former fallback to primary. CLAUDE.md says not to do
 * that to fix model BEHAVIOUR — this is different: the old primary no longer
 * exists, so there is nothing to promote it over.
 */
const DEFAULT_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
];

/*
 * Reasoning budget, per model. This is not a tuning knob — without it the
 * primary returns EMPTY REPLIES.
 *
 * `openai/gpt-oss-*` are reasoning models. Left at their default they spend the
 * whole max_tokens allowance thinking: measured 405 of 420 tokens on reasoning,
 * finish_reason "length", and 29 characters of actual answer. groq.js then
 * treats the empty completion as a failure and burns the rest of the chain.
 *
 * At effort "low" the same request used 19 reasoning tokens, finished cleanly,
 * and produced a full answer in 124 completion tokens — fewer tokens AND a
 * better result, so this costs nothing.
 *
 * Models are only sent the parameter if they are listed here; an unknown model
 * gets a plain request rather than a 400 on an unsupported field.
 */
const REASONING_EFFORT = {
  'openai/gpt-oss-20b': 'low',
  'openai/gpt-oss-120b': 'low',
  'qwen/qwen3.6-27b': 'none',
};

const baseUrl = () =>
  (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');

export function models() {
  const raw = process.env.GROQ_MODELS;
  if (!raw) return DEFAULT_MODELS;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

// Vercel function maxDuration is 15s. Leave room to still return JSON after the
// last attempt gives up.
const TOTAL_BUDGET_MS = 12_000;
const PER_ATTEMPT_MS = 8_000;

/** 401/403 is a key problem, not a model problem — trying the rest is pointless. */
function isFatal(status) {
  return status === 401 || status === 403;
}

/*
 * Rate-limit headers, captured on failure.
 *
 * Groq reports TPM and RPD here, but NOT TPD — the daily token cap that is
 * actually the binding constraint on this project appears only in the 429 BODY:
 *
 *   Rate limit reached for model `openai/gpt-oss-20b` ... service tier
 *   `on_demand` on tokens per day (TPD): Limit 200000, Used 196978
 *
 * So both are recorded. Reading only the headers is what left TPD "unverified"
 * in CLAUDE.md for the whole build.
 */
const RATE_HEADERS = [
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'retry-after',
];

function readRateHeaders(res) {
  const out = {};
  for (const h of RATE_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null && v !== undefined) out[h] = v;
  }
  return out;
}

/** Pull Groq's own error code and message out of the body, which is JSON. */
function parseUpstreamError(text) {
  try {
    const j = JSON.parse(text);
    return {
      code: j?.error?.code || j?.error?.type || null,
      message: j?.error?.message || null,
    };
  } catch {
    return { code: null, message: text ? text.slice(0, 300) : null };
  }
}

/**
 * Coarse bucket for the widget and the logs. Derived from the LAST attempt that
 * actually reached Groq, because that is the one that decided the outcome.
 *
 * Deliberately coarse: the visitor-facing copy does not change, this exists so
 * the next failure is diagnosable from a response body instead of guessed at.
 */
export function classify(attempts) {
  if (!attempts || !attempts.length) return 'upstream';
  const reached = attempts.filter((a) => a.status > 0);
  if (!reached.length) return 'network';

  const statuses = reached.map((a) => a.status);
  if (statuses.every((s) => s === 429)) return 'rate_limit';
  if (statuses.some((s) => s === 404 || s === 400)) {
    const gone = reached.some(
      (a) =>
        a.status === 404 ||
        /model_not_found|does not exist|decommission|deprecat/i.test(
          (a.code || '') + ' ' + (a.message || ''),
        ),
    );
    if (gone) return 'model_gone';
  }
  if (statuses.includes(429)) return 'rate_limit';
  return 'upstream';
}

/**
 * @param {{messages: Array, temperature?: number, maxTokens?: number}} opts
 * @returns {Promise<{ok: boolean, reply?: string, model?: string, usage?: object, attempts: Array}>}
 */
export async function complete({ messages, temperature = 0.3, maxTokens = 420 }) {
  const key = process.env.GROQ_API_KEY;
  const attempts = [];

  if (!key) {
    attempts.push({ model: null, status: 0, error: 'GROQ_API_KEY not set' });
    return { ok: false, attempts };
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const model of models()) {
    const remaining = deadline - Date.now();
    if (remaining < 1_500) {
      attempts.push({ model, status: 0, error: 'out of time budget' });
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(PER_ATTEMPT_MS, remaining),
    );

    try {
      const res = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          Object.assign(
            {
              model,
              messages,
              temperature,
              max_tokens: maxTokens,
            },
            REASONING_EFFORT[model]
              ? { reasoning_effort: REASONING_EFFORT[model] }
              : {},
          ),
        ),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (reply) {
          attempts.push({ model, status: res.status });
          return { ok: true, reply, model, usage: data.usage || null, attempts };
        }
        // 200 with an empty choice — treat as a failure and move on.
        attempts.push({ model, status: res.status, error: 'empty completion' });
      } else {
        /*
         * Any non-ok status advances to the next model, with no retry and no
         * sleeping on retry-after. That is deliberate and predates this change:
         * Groq's limits are PER MODEL, so the next model in the chain has its
         * own budget and trying it costs one round trip, while honouring
         * retry-after would park a visitor for the length of a rate-limit
         * window behind a model that is already known to be refusing.
         *
         * Confirmed live on 19 Aug 2026: one request produced 429 on
         * gpt-oss-20b, 429 on gpt-oss-120b and 429 on qwen, in chain order,
         * inside a single call. The chain was never the defect.
         */
        const detail = await res.text().catch(() => '');
        const { code, message } = parseUpstreamError(detail);
        attempts.push({
          model,
          status: res.status,
          code,
          message: message ? message.slice(0, 300) : null,
          rateHeaders: readRateHeaders(res),
          error: detail.slice(0, 200),
        });
        if (isFatal(res.status)) break;
      }
    } catch (err) {
      attempts.push({
        model,
        status: 0,
        error: err.name === 'AbortError' ? 'timeout' : String(err.message || err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, attempts };
}
