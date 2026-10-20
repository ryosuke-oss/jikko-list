// When Google says no: busy (429 / 5xx) -> wait and try 3 times; the key ran out (401) -> log in again;
// no permission (403) / no file (404) -> stop and say so. Broken rows are skipped and counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { connectedPair } from './helpers/device.js';
import { newTask } from '../public/js/tasks.js';
import { buildRow } from '../public/js/sync/engine.js';
import { versionName, canonical } from '../public/js/sync/rev.js';
import { cleanContent } from '../public/js/sync/records.js';

async function add(dev, title) {
  return dev.edit((d) => {
    const t = newTask({ title }, dev.clock.now(), d.tasks.length);
    d.tasks.push(t);
    return t;
  });
}

test('busy (429 / 5xx): wait and try again up to 3 times; still busy -> stop this run, the versions wait', async () => {
  const sheets = new FakeSheets();
  const { A } = await connectedPair(sheets);
  const waits = [];
  const e = A.newEngine({ sleep: async (ms) => { waits.push(ms); } });
  await add(A, '混んでいる');
  sheets.inject({ device: 'Mac', method: 'readTabs', error: 429, times: 2 });
  const r = await e.sync();
  assert.equal(r.status, 'synced');
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(r.stats.sent, 1);
  await add(A, 'もっと混んでいる');
  waits.length = 0;
  sheets.inject({ device: 'Mac', method: 'appendRows', error: 503, times: 4 });
  const r2 = await e.sync();
  assert.equal(r2.status, 'error');
  assert.equal(r2.error, 'busy');
  assert.deepEqual(waits, [1000, 3000, 9000]);
  assert.equal(r2.pending, 1);
  assert.equal((await e.status()).lastError.kind, 'busy');
  const r3 = await e.sync();
  assert.equal(r3.status, 'synced');
  assert.equal(r3.stats.sent, 1);
});

test('the key ran out (401): "log in again", nothing more is tried in that run', async () => {
  const sheets = new FakeSheets();
  const { A } = await connectedPair(sheets);
  await add(A, '鍵切れ');
  sheets.inject({ device: 'Mac', method: 'readTabs', error: 401 });
  const before = sheets.calls('Mac');
  const r = await A.sync();
  assert.equal(r.status, 'need-login');
  assert.equal(sheets.calls('Mac') - before, 1);
  assert.equal(r.pending, 1);
  // without a key the engine does not even try
  const e = A.newEngine({ google: Object.assign({}, A.google, { hasToken: () => false }) });
  const calls = sheets.calls('Mac');
  assert.equal((await e.sync()).status, 'need-login');
  assert.equal(sheets.calls('Mac'), calls);
});

test('no permission (403) or no file (404): stop and say so; no file is made', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  sheets.inject({ device: 'Mac', method: 'readTabs', error: 403 });
  const r = await A.sync();
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'forbidden');
  sheets.files[0].deleted = true;
  const r2 = await B.sync();
  assert.equal(r2.status, 'error');
  assert.equal(r2.error, 'not-found');
  assert.equal(sheets.calls('iPhone', 'createFile'), 0);
  assert.equal(sheets.calls(null, 'createFile'), 1);
  assert.equal((await B.engine.status()).lastError.kind, 'not-found');
});

test('broken rows are skipped and counted ("読めない行"), blank rows are ignored, nothing else is affected', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const tabB = (await B.syncRecords()).config.myTab;
  const t = newTask({ title: '本物' }, A.clock.now(), 0);
  const c = cleanContent('task:' + t.id, t);
  const good = buildRow('task:' + t.id, await versionName('task:' + t.id, [], c), { p: [], c, t: A.clock.now(), o: 'add' }, 'iPhone');
  const bad = (g, h, i, j) => ['', '', '', '', '', '', g, h, i, j];
  sheets.appendRaw(tabB, bad('nonsense', good[7], good[8], good[9])); // the key
  sheets.appendRaw(tabB, bad(good[6], 'x-1', good[8], good[9])); // the version name
  sheets.appendRaw(tabB, bad(good[6], good[7], good[8], '{not json')); // the content
  sheets.appendRaw(tabB, bad(good[6], good[7], good[8], good[9].replace('本物', '偽物'))); // changed by hand
  sheets.appendRaw(tabB, bad('task:other', good[7], good[8], good[9])); // another key
  sheets.appendRaw(tabB, bad(good[6], good[7], good[8], canonical(Object.assign({}, c, { memo: 'あ'.repeat(60000) })))); // too long
  sheets.appendRaw(tabB, ['', '', '', '', '', '', '', '', '', '']);
  sheets.appendRaw(tabB, good);
  const r = await A.sync();
  assert.equal(r.status, 'synced');
  assert.equal(r.stats.unreadable, 6);
  assert.equal((await A.engine.status()).unreadable, 6);
  const tasks = (await A.data()).tasks;
  assert.deepEqual(tasks.map((x) => x.title), ['本物']);
});
