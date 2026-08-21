// Build stamp for public/widget.js.
//
// The problem this solves: browsers cache widget.js, and a stale copy looks
// exactly like a working one. Every "the fix didn't apply" moment in this
// project has been either a stale cached widget or a stale dev server. The
// stamp makes the answer visible in three places that must agree:
//
//   server start   ->  printed on boot
//   /api/chat      ->  x-fs-build response header
//   browser        ->  console.log from the widget itself
//
// If the browser's line disagrees with the other two, the browser has an old
// file. Hard-refresh.
//
// The hash is of the widget SOURCE, so it changes exactly when the file does.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WIDGET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'widget.js',
);

/** Raw widget source, or null if it cannot be read. */
export function readWidget() {
  try {
    return readFileSync(WIDGET_PATH, 'utf8');
  } catch {
    return null;
  }
}

export function hashOf(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 8);
}

export function gzippedBytes(source) {
  return gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).length;
}

/*
 * Size ceiling, gzipped. 20 KB -> 30 KB -> 35 KB (Aug 2026).
 *
 * Gzipped is the honest number — it is what crosses the wire, and Vercel
 * compresses by default. The original 25 KB *raw* budget was a proxy for "keep
 * it small"; the thing it protected, fast load on a slow connection, is still
 * comfortably satisfied here.
 *
 * The two cheap ways to claw back bytes are both forbidden, deliberately:
 * splitting the file adds a second request and therefore a second failure mode
 * on exactly the connections this budget exists for, and trimming the comments
 * fights the constraint that one person must be able to read this file in a
 * year. Raising the number is the honest move.
 *
 * The 35 KB step paid for the outage lead form: at 30 KB the widget was already
 * at 27.5 KB, which left no room to add the one feature that keeps a
 * quota-exhausted day from capturing zero leads. A self-imposed number should
 * not be the reason a real failure goes unhandled.
 */
export const SIZE_LIMIT_GZIP = 35 * 1024;

// Memoised for the API: computed once per cold start, not per request.
let cached = null;

/**
 * The build the server believes is current.
 *
 * Falls back to 'unknown' rather than throwing — on Vercel the widget file may
 * not be inside the function bundle, and a missing debug stamp must never take
 * a chat request down.
 */
export function currentBuild() {
  if (cached) return cached;
  const src = readWidget();
  cached = src ? hashOf(src) : 'unknown';
  return cached;
}
