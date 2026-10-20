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
  // the sync parts (3-2) are kept on the device too, so they work without a connection
  for (const f of ['rev', 'merge', 'records', 'engine', 'google', 'control', 'ui']) assert.ok(sw.files.includes('/js/sync/' + f + '.js'), f);
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

test('the headers allow the service worker and keep sw.js fresh; the app talks to its own site and the two Google API hosts only', () => {
  const headers = readFileSync(join(PUBLIC, '_headers'), 'utf8');
  const global = headers.split('\n').find((l) => l.startsWith('  Content-Security-Policy:'));
  // 3-3: the sync talks to Google's two API hosts (7-1 of the spec); the sign-in screen is a page move, not a request
  assert.match(global, /connect-src 'self' https:\/\/sheets\.googleapis\.com https:\/\/www\.googleapis\.com; worker-src 'self';/);
  assert.doesNotMatch(global, /accounts\.google\.com|\*/);
  assert.match(global, /script-src 'self';/);
  assert.match(global, /form-action 'none'/);
  assert.match(headers, /\/sw\.js\n  Cache-Control: no-cache/);
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(join(PUBLIC, 'index.html'), 'utf8'))[1];
  assert.match(meta, /connect-src 'self' https:\/\/sheets\.googleapis\.com https:\/\/www\.googleapis\.com; worker-src 'self';/);
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
