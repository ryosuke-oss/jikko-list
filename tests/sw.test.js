import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicFiles, cachedPaths, readSw, expectedVersion } from '../tools/sw-files.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('the service worker keeps exactly the files of the app (run `npm run stamp` after changing public/)', () => {
  const sw = readSw(PUBLIC);
  assert.deepEqual(sw.files, cachedPaths(PUBLIC));
  assert.ok(sw.files.includes('/'));
  assert.ok(sw.files.includes('/js/app.js'));
  assert.ok(sw.files.includes('/vendor/Sortable.min.js'));
  for (const f of sw.files) assert.ok(existsSync(join(PUBLIC, f === '/' ? 'index.html' : f.slice(1))), f);
  // every file of the site is either kept or left out on purpose
  const leftOut = publicFiles(PUBLIC).filter((p) => !sw.files.includes(p === '/index.html' ? '/' : p));
  assert.deepEqual(leftOut.filter((p) => !/connect-test|LICENSE|^\/_headers$|^\/sw\.js$/.test(p)), []);
  assert.ok(!sw.files.some((p) => /connect-test|LICENSE|_headers|sw\.js/.test(p)));
});

test('the version changes with the files (a stale box would keep old files on phones)', () => {
  assert.equal(readSw(PUBLIC).version, expectedVersion(PUBLIC));
  assert.match(readSw(PUBLIC).version, /^v\d+\.\d+-[0-9a-f]{8}$/);
});

test('the service worker never handles other sites or the connection test page', () => {
  const text = readSw(PUBLIC).text;
  assert.match(text, /url\.origin !== self\.location\.origin/);
  assert.match(text, /startsWith\('\/connect-test'\)/);
  assert.match(text, /req\.method !== 'GET'/);
  assert.doesNotMatch(text, /importScripts|eval\(|googleapis/);
});

test('the headers allow the service worker and keep sw.js fresh; the app still talks only to its own site', () => {
  const headers = readFileSync(join(PUBLIC, '_headers'), 'utf8');
  const global = headers.split('\n').find((l) => l.startsWith('  Content-Security-Policy:'));
  assert.match(global, /connect-src 'self'; worker-src 'self';/);
  assert.doesNotMatch(global, /googleapis/);
  assert.match(headers, /\/sw\.js\n  Cache-Control: no-cache/);
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(PUBLIC, 'index.html'), 'utf8'))[1];
  assert.match(meta, /connect-src 'self'; worker-src 'self';/);
  // the meta copy says the same as the header (frame-ancestors only works as a header)
  assert.equal(meta, global.replace('  Content-Security-Policy: ', '').replace("; frame-ancestors 'none'", ''));
});

test('another page under public/ stops the stamp until it is decided how the worker handles it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jikko-sw-'));
  mkdirSync(join(dir, 'js'));
  writeFileSync(join(dir, 'index.html'), 'x');
  writeFileSync(join(dir, 'js', 'app.js'), "const APP_VERSION = 'v9.9';");
  writeFileSync(join(dir, '_headers'), '/*');
  assert.deepEqual(cachedPaths(dir), ['/', '/js/app.js']);
  writeFileSync(join(dir, 'help.html'), 'x');
  assert.throws(() => cachedPaths(dir), /help\.html/);
});
