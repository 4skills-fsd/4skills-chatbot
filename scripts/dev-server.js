// Local dev server. Zero dependencies, dev-only, never deployed.
//
// Vercel gives each api/*.js a plain Node (req, res), which is exactly what this
// hands them, so the handlers run here unchanged. Lets the whole backend be
// tested with curl before any UI exists, and without `vercel dev` or a login.
//
//   npm run dev
//   npm run dev:kill     (when port 3000 is already held)
//
// THE PORT IS FIXED AT 3000 AND IS NOT CONFIGURABLE. That is deliberate. When
// this fell back to another port on collision, an orphaned server kept serving
// the OLD code on 3000 while the new one ran elsewhere — and two separate
// debugging sessions were spent chasing "fixes that didn't apply" that had in
// fact applied perfectly to a server nobody was talking to. Failing loudly on a
// busy port costs five seconds. Drifting silently costs an afternoon.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { readWidget, hashOf, gzippedBytes, SIZE_LIMIT_GZIP } from '../lib/build.js';
import { reportOrigins } from '../lib/guard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3000;

const routes = {
  '/api/chat': () => import('../api/chat.js'),
  '/api/lead': () => import('../api/lead.js'),
  '/api/health': () => import('../api/health.js'),
};

const contentTypes = {
  '.js': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes[url.pathname];

  if (route) {
    try {
      const mod = await route();
      await mod.default(req, res);
    } catch (err) {
      console.error(`[dev] ${url.pathname} threw`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'handler_threw', detail: String(err.message || err) }));
      }
    }
    return;
  }

  // Static: serve public/ the way Vercel does.
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, 'public', rel));
  if (!file.startsWith(join(root, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const ext = rel.slice(rel.lastIndexOf('.'));

    // widget.js gets its build stamp injected and is never cached.
    //
    // Production serves the file byte-for-byte from public/ with a 5-minute
    // cache. Here we prepend one line so the browser can report which build it
    // is actually running — that is the whole point of the stamp, and it cannot
    // be self-referential any other way without a build step. Dev only.
    if (rel === '/widget.js') {
      const source = readWidget();
      if (source) {
        const stamp = `/* dev */window.__FS_BUILD__=${JSON.stringify(hashOf(source))};\n`;
        const body = Buffer.from(stamp + source, 'utf8');
        res.writeHead(200, {
          'Content-Type': contentTypes['.js'],
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          'x-fs-build': hashOf(source),
        });
        res.end(body);
        return;
      }
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

// Loud, specific, and non-zero. No fallback port, ever.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  PORT 3000 IN USE - kill the existing process');
    console.error('');
    console.error('    npm run dev:kill');
    console.error('');
    console.error('  Something is already serving on 3000. It is almost certainly an');
    console.error('  older copy of this server still holding the port, which means the');
    console.error('  browser is talking to stale code. This will not fall back to another');
    console.error('  port, because that is how you end up debugging a server nobody is');
    console.error('  connected to.');
    console.error('');
    process.exit(1);
  }
  console.error('[dev] server error', err);
  process.exit(1);
});

server.listen(PORT, () => {
  const source = readWidget();
  const build = source ? hashOf(source) : 'unknown';
  const gz = source ? gzippedBytes(source) : 0;

  const pct = Math.round((gz / SIZE_LIMIT_GZIP) * 100);
  const over = gz > SIZE_LIMIT_GZIP;

  console.log(`dev server  http://localhost:${PORT}`);
  console.log(
    `  build     ${build}   widget.js ${(gz / 1024).toFixed(1)} KB gzipped ` +
      `(${pct}% of ${SIZE_LIMIT_GZIP / 1024} KB)${over ? '  *** OVER LIMIT ***' : ''}`,
  );
  console.log(`  POST      /api/chat`);
  console.log(`  POST      /api/lead`);
  console.log(`  static    public/   (widget.js is no-store)`);
  console.log(`  models    ${process.env.GROQ_MODELS || '(default chain)'}`);
  console.log(`  groq      ${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}`);
  console.log(`  key       ${process.env.GROQ_API_KEY ? 'set (developer key — the client key lives only in Vercel)' : 'MISSING'}`);
  console.log('');
  // Prints the resolved allowlist and shouts about malformed entries. A missing
  // comma here is an invisible 403 on one domain — see validateOrigins().
  reportOrigins();
  console.log('');
  console.log(`  The browser console should print build ${build}. If it prints`);
  console.log('  anything else, it is running a cached widget — hard-refresh.');
});
