// Groq client. Plain fetch against the OpenAI-compatible endpoint — no SDK, so
// there is nothing to keep updated.
//
// The fallback chain exists for two reasons. The obvious one is 429s when the
// free-tier TPM ceiling is hit. The less obvious one is that Groq retires model
// IDs on a rolling basis, and a retired ID returns 400/404, not 429 — so a
// decommissioned primary must also fall through rather than taking the widget
// down until someone notices.

const DEFAULT_MODELS = [
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
];

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
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
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
        const detail = await res.text().catch(() => '');
        attempts.push({ model, status: res.status, error: detail.slice(0, 200) });
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
