// S22 (the computing part, on the fake Google): 1,000 tasks and 20,000 rows. The numbers are printed.
//   - a second device receiving the 20,000 rows for the first time (recorded)
//   - one ordinary run with 10 new rows: under 1 second
//   - what the app does on opening before it draws (read + check + count the dragon): under 1 second
// (Drawing the screen is measured in the browser; the time with the real Google is measured in 3-3 / 3-4.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FakeSheets } from './helpers/fake-google.js';
import { makeDevice, makeClock } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { newTask } from '../public/js/tasks.js';
import { settle } from '../public/js/dragon.js';

const TASKS = 1000;
const ROUNDS = 20; // every task written 20 times -> 20,000 rows

test('S22 1,000 tasks and 20,000 rows: the first receive is recorded; one run with 10 new rows and the opening stay under 1 second', { timeout: 240000 }, async (t) => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  await A.init();
  await A.connect();
  const ids = [];
  await A.edit((d) => {
    for (let i = 0; i < TASKS; i += 1) {
      const x = newTask({ title: 'タスク ' + i, rank: ['A', 'B', 'C'][i % 3], due: '2026-11-' + String(1 + (i % 28)).padStart(2, '0') }, clock.now(), i);
      x.memo = 'メモ '.repeat(20) + i;
      d.tasks.push(x);
      ids.push(x.id);
    }
  });
  const t0 = performance.now();
  await A.sync();
  for (let r = 1; r < ROUNDS; r += 1) {
    clock.tick(60 * 1000);
    await A.edit((d) => {
      for (const x of d.tasks) {
        x.nextAction = '次の一手 ' + r;
        x.updatedAt = clock.now();
      }
    });
    await A.sync();
  }
  const build = performance.now() - t0;
  const rows = Object.values(sheets.snapshot()).reduce((n, rr) => n + rr.length - 1, 0);
  assert.ok(rows >= TASKS * ROUNDS, 'rows: ' + rows);

  // the second device receives everything (all rows read, every fingerprint checked)
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await B.init();
  const t1 = performance.now();
  const rc = await B.connect();
  const receive = performance.now() - t1;
  assert.equal(rc.how, 'received');
  assert.equal((await B.data()).tasks.length, TASKS);

  // an ordinary run on B with 10 new rows from A
  clock.tick(60 * 1000);
  await A.edit((d) => {
    for (const x of d.tasks.slice(0, 10)) {
      x.title += '（直した）';
      x.updatedAt = clock.now();
    }
  });
  await A.sync();
  const runs = [];
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    const t2 = performance.now();
    last = await B.sync();
    runs.push(performance.now() - t2);
    if (i === 0) assert.equal(last.stats.applied, 10);
  }
  const oneRun = runs[0];

  // opening: read the data, check it, count the dragon (what app.js does before drawing)
  const opens = [];
  for (let i = 0; i < 3; i += 1) {
    const t3 = performance.now();
    const l = await ST.loadState(B.db);
    const data = ST.cleanState(l.data);
    settle(data.dragon, data.tasks, null, clock.now());
    opens.push(performance.now() - t3);
  }
  const revCount = (await ST.getAllRevs(B.db)).reduce((n, d) => n + Object.keys(d.v).length, 0);
  t.diagnostic('S22: タスク ' + TASKS + '件・記録 ' + rows + '行（作るのに ' + (build / 1000).toFixed(1) + '秒）・iPhone が持つ版 ' + revCount);
  t.diagnostic('S22: 2台目の初回の受け取り（' + rows + '行を読んで指紋を確かめる）' + (receive / 1000).toFixed(2) + '秒');
  t.diagnostic('S22: 新しい行10件の同期1回の計算 ' + runs.map((x) => Math.round(x) + 'ms').join(' / ') + '（1回目に10件を画面へ）');
  t.diagnostic('S22: 開くときの読み込み・点検・竜の数え直し ' + opens.map((x) => Math.round(x) + 'ms').join(' / '));
  assert.ok(oneRun < 1000, 'one run: ' + oneRun);
  assert.ok(Math.min(...opens) < 1000, 'opening: ' + opens);
});
