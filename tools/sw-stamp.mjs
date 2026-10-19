// npm run stamp — writes the list of kept files and the version into public/sw.js.
// Run it after changing anything under public/ (tests/sw.test.js fails until it is run).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedPaths, expectedVersion } from './sw-files.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const swPath = join(publicDir, 'sw.js');
const text = readFileSync(swPath, 'utf8');
const version = expectedVersion(publicDir);
const list = cachedPaths(publicDir).map((p) => "  '" + p + "',").join('\n');
const next = text
  .replace(/const VERSION = '[^']*';/, "const VERSION = '" + version + "';")
  .replace(/const FILES = \[[\s\S]*?\];/, 'const FILES = [\n' + list + '\n];');
if (next === text) {
  console.log('sw.js is up to date (' + version + ')');
} else {
  writeFileSync(swPath, next);
  console.log('sw.js updated: ' + version + ' (' + cachedPaths(publicDir).length + ' files)');
}
