// npm run health-check
//
// "Is the assistant actually answering?" — one trivial request, one clear answer.
//
// WHY THIS EXISTS. In August 2026 Groq decommissioned two of the three models in
// the chain. Visitors got the WhatsApp fallback message instead of answers, and
// NOBODY WAS TOLD. The widget is built to fail politely, which means a total
// outage looks exactly like a quiet day. This script is the only thing that
// turns that silence into a signal.
//
//   npm run health-check                     # against production
//   HEALTH_URL=http://localhost:3000 npm run health-check
//
// Exits 0 when a model answered, 1 when nothing did — so it works as a cron
// check or a CI gate, not just something to read.
//
// NB: sets process.exitCode and returns rather than calling process.exit().
// Calling exit() while fetch's sockets are still closing trips a libuv
// assertion on Windows and yields exit code 127 — which would make a healthy
// run look like a failure to whatever is watching.

const TARGET = (process.env.HEALTH_URL || 'https://4skills-widget.vercel.app').replace(/\/$/, '');

// Must be an allowed origin or the request is rejected before it reaches Groq.
const ORIGIN = process.env.HEALTH_ORIGIN || 'https://4skills.co';

const TIMEOUT_MS = 25000;

async function main() {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  let body;
  try {
    res = await fetch(`${TARGET}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      // Deliberately trivial: a greeting skips retrieval, so this measures the
      // model round trip and nothing else.
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        sessionId: `health-${Date.now()}`,
        session: {},
      }),
      signal: controller.signal,
    });
    body = await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.error(`FAIL  could not reach ${TARGET}`);
    console.error(`      ${err.name === 'AbortError' ? `no response in ${TIMEOUT_MS / 1000}s` : err.message}`);
    process.exitCode = 1;
    return;
  }
  clearTimeout(timer);

  const ms = Date.now() - started;
  const model = res.headers.get('x-fs-model') || '(none)';
  const reply = (body && body.reply) || '';
  const degraded = !!(body && body.degraded);
  const empty = reply.trim().length === 0;

  console.log(`target   ${TARGET}`);
  console.log(`status   HTTP ${res.status} in ${ms}ms`);
  console.log(`model    ${model}`);
  console.log(`reply    ${empty ? '(EMPTY)' : `${reply.length} chars — "${reply.slice(0, 60).replace(/\n/g, ' ')}…"`}`);

  if (degraded || model === 'none' || empty) {
    console.error('');
    console.error('FAIL  no model served this request.');
    console.error('');
    console.error('      Visitors are currently being shown the WhatsApp fallback');
    console.error('      instead of answers, and nothing else will tell you.');
    console.error('');
    console.error('      Most likely cause: a model in GROQ_MODELS was retired by');
    console.error('      Groq. Check which ones still exist:');
    console.error('        curl -H "Authorization: Bearer $GROQ_API_KEY" \\');
    console.error('             https://api.groq.com/openai/v1/models');
    console.error('      then fix GROQ_MODELS in the Vercel dashboard and redeploy.');
    process.exitCode = 1;
    return;
  }

  if (res.status === 429) {
    console.error('');
    console.error('FAIL  rate limited. Not an outage, but re-run before drawing conclusions.');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('OK    the assistant is answering.');
  process.exitCode = 0;
}

main();
