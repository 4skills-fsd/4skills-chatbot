// GET /api/health — is the assistant actually answering?
//
// Hit by a Vercel cron once a day. On failure it emails NOTIFY_EMAIL through the
// SAME Apps Script webhook that already receives leads, so this adds no new
// service, no new account and no new secret beyond CRON_SECRET.
//
// WHY: the widget is built to fail politely. When every model in the chain is
// down, visitors get the WhatsApp fallback and the site looks like it is having
// a quiet day. In Aug 2026 two of three models were decommissioned and nothing
// told anyone. This endpoint is what turns that silence into an email.
//
// LIMIT, STATED PLAINLY: Vercel's Hobby plan runs cron jobs ONCE PER DAY. An
// outage can therefore go unnoticed for up to 24 hours. That is the honest
// ceiling of this alert on the free plan — see the README.

import { complete } from '../lib/groq.js';
import { currentBuild } from '../lib/build.js';
import { sendJson } from '../lib/guard.js';

/**
 * Tell the team the assistant is down. Never throws — a failed alert must not
 * turn into a 500 that makes the cron look broken instead of the bot.
 */
async function alert(detail) {
  const url = process.env.LEAD_WEBHOOK_URL;
  const to = process.env.NOTIFY_EMAIL;

  if (!url) {
    console.error('[health] LEAD_WEBHOOK_URL not set — cannot send the alert');
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'health-alert',
        to: to || '',
        timestamp: new Date().toISOString(),
        build: currentBuild(),
        detail,
      }),
      signal: controller.signal,
      redirect: 'follow',
    });
    return res.ok;
  } catch (err) {
    console.error('[health] alert failed', String(err && err.message));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // Vercel cron sends no Origin, so the usual gate() does not apply. Guard with
  // a shared secret instead, or anyone could burn Groq quota by refreshing.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
  }

  const started = Date.now();
  let result;
  try {
    result = await complete({
      // Trivial on purpose: no retrieval, no history. This measures the model
      // round trip and nothing else.
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      temperature: 0,
      maxTokens: 32,
    });
  } catch (err) {
    result = { ok: false, attempts: [{ model: null, status: 0, error: String(err && err.message) }] };
  }

  const ms = Date.now() - started;
  const healthy = !!(result.ok && result.reply && result.reply.trim());

  if (healthy) {
    return sendJson(res, 200, {
      ok: true,
      model: result.model,
      ms,
      build: currentBuild(),
    });
  }

  const detail = (result.attempts || [])
    .map((a) => `${a.model || '(none)'}: ${a.status || 'no response'} ${a.error || ''}`.trim())
    .join('\n');

  console.error('[health] UNHEALTHY', detail);
  const alerted = await alert(detail);

  // 503 so an uptime pinger sees it too, not just the email.
  return sendJson(res, 503, {
    ok: false,
    ms,
    alerted,
    attempts: result.attempts,
  });
}
