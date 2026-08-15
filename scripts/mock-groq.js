// Fake Groq endpoint, for testing the fallback chain without a real key or a
// deliberately exhausted quota.
//
// MOCK_FAIL is a comma-separated list of `model:status` pairs. Anything not
// listed answers 200.
//
//   MOCK_FAIL=llama-3.1-8b-instant:429,openai/gpt-oss-20b:503 \
//     node scripts/mock-groq.js
//
// Then point the backend at it:
//   GROQ_BASE_URL=http://localhost:4010/openai/v1 GROQ_API_KEY=test ...

import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT) || 4010;

const failures = new Map(
  (process.env.MOCK_FAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.lastIndexOf(':');
      return [pair.slice(0, idx), Number(pair.slice(idx + 1))];
    }),
);

createServer(async (req, res) => {
  if (!req.url.endsWith('/chat/completions') || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const model = body.model;

  const status = failures.get(model);
  if (status) {
    console.log(`  mock: ${model} -> ${status}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock failure for ${model}`, type: 'mock' } }));
    return;
  }

  const messages = body.messages || [];
  const systemChars = messages
    .filter((m) => m.role === 'system')
    .reduce((n, m) => n + m.content.length, 0);

  // The first system message is the cacheable prefix. Logging its length and a
  // cheap checksum makes prefix drift visible without a real Groq key — if these
  // two numbers ever differ between requests, prompt caching is broken and the
  // TPM headroom calculation in CLAUDE.md no longer holds.
  const prefix = messages[0]?.content || '';
  let sum = 0;
  for (let i = 0; i < prefix.length; i++) sum = (sum * 31 + prefix.charCodeAt(i)) >>> 0;
  console.log(
    `  mock: ${model} -> 200  prefix=${prefix.length}ch/${sum.toString(16)} total_system=${systemChars}ch`,
  );

  // MOCK_REPLY lets a test drive the exact reply text — used to prove the
  // [[LEAD]] marker never survives into a response body.
  if (process.env.MOCK_REPLY) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model,
        choices: [{ message: { role: 'assistant', content: process.env.MOCK_REPLY } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: `Mock reply from ${model}. System prompt was ${systemChars} chars.`,
          },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}).listen(port, () => {
  console.log(`mock groq   http://localhost:${port}/openai/v1`);
  console.log(`  failing   ${[...failures].map(([m, s]) => `${m}=${s}`).join(', ') || '(none)'}`);
});
