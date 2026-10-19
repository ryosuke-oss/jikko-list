// Which files the service worker keeps on the device, and the version stamp computed from them.
// Used by `npm run stamp` (writes public/sw.js) and by tests/sw.test.js (checks it is up to date).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Not kept on the device: the header rules, the worker itself, the connection test page
// (it needs the network anyway) and the license texts.
const NOT_CACHED = [/^\/_headers$/, /^\/sw\.js$/, /connect-test/, /\/LICENSE$/];

function walk(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    const rel = base + '/' + e.name;
    if (e.isDirectory()) walk(p, rel, out);
    else out.push(rel);
  }
  return out;
}

/** Every file under public/ as a site path ("/js/app.js"), sorted. */
export function publicFiles(publicDir) {
  return walk(publicDir, '', []).sort();
}

/** The paths the service worker should keep ("/" stands for /index.html, the way the site serves it). */
export function cachedPaths(publicDir) {
  const paths = publicFiles(publicDir).filter((p) => !NOT_CACHED.some((re) => re.test(p)));
  // Cloudflare answers /x.html with a redirect to /x, and a redirect must not be kept in the box.
  const pages = paths.filter((p) => p.endsWith('.html') && p !== '/index.html');
  if (pages.length) throw new Error('Decide how the service worker handles these pages first: ' + pages.join(', '));
  return paths.map((p) => (p === '/index.html' ? '/' : p));
}

/** 8 hex characters that change whenever a kept file or the header rules change. */
export function contentStamp(publicDir) {
  const h = createHash('sha256');
  const files = cachedPaths(publicDir).map((p) => (p === '/' ? '/index.html' : p)).concat(['/_headers']).sort();
  for (const p of files) {
    h.update(p + '\n');
    h.update(readFileSync(join(publicDir, p.slice(1))));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 8);
}

/** The version shown in the settings ("v1.3"), read from public/js/app.js. */
export function appVersion(publicDir) {
  const m = /const APP_VERSION = '(v\d+\.\d+)';/.exec(readFileSync(join(publicDir, 'js/app.js'), 'utf8'));
  if (!m) throw new Error('APP_VERSION not found in public/js/app.js');
  return m[1];
}

/** VERSION and FILES as written in public/sw.js. */
export function readSw(publicDir) {
  const text = readFileSync(join(publicDir, 'sw.js'), 'utf8');
  const v = /const VERSION = '([^']+)';/.exec(text);
  const f = /const FILES = \[([\s\S]*?)\];/.exec(text);
  return {
    text,
    version: v ? v[1] : null,
    files: f ? [...f[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
  };
}

export function expectedVersion(publicDir) {
  return appVersion(publicDir) + '-' + contentStamp(publicDir);
}
