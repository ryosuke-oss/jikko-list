// 8 of the spec, checked on the fake Google with numbers:
//   S12 rows are only added (no earlier row changes, no device writes in another device's tab)
//   S13 two devices syncing at the same moment, 10 times: no version lost
//   S17 rows changed by hand: a removed row is noticed and the sync goes on; a rewritten cell is not used
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { connectedPair } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { newTask } from '../public/js/tasks.js';
import { fastHash } from '../public/js/sync/rev.js';

async function add(dev, title) {
  return dev.edit((d) => {
    const t = newTask({ title }, dev.clock.now(), d.tasks.length);
    d.tasks.push(t);
    return t;
  });
}

async function change(dev, id, fn) {
  return dev.edit((d) => {
    const t = d.tasks.find((x) => x.id === id);
    fn(t);
    t.updatedAt = dev.clock.now();
  });
}

function rowHashes(snap) {
  const out = {};
  for (const [tab, rows] of Object.entries(snap)) out[tab] = rows.map((r) => fastHash(JSON.stringify(r)));
  return out;
}

async function mineVersions(dev) {
  const out = [];
  for (const d of await ST.getAllRevs(dev.db)) for (const [n, v] of Object.entries(d.v)) if (v.m) out.push(n);
  return out;
}

test('S12 rows are only added: after 10 runs on each device no earlier row (A..J) changed, and nobody wrote in another device\'s tab', async (t) => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const ta = await add(A, 'PCのタスク');
  const tb = await add(B, 'iPhoneのタスク');
  await A.sync();
  await B.sync();
  await A.sync();
  const tabs = { Mac: (await A.syncRecords()).config.myTab, iPhone: (await B.syncRecords()).config.myTab };
  const before = rowHashes(sheets.snapshot());
  const logStart = sheets.log.length;
  for (let i = 0; i < 10; i += 1) {
    clock.tick(60 * 1000);
    await change(A, ta.id, (x) => { x.title = 'PCのタスク ' + i; });
    await change(B, tb.id, (x) => { x.memo = 'iPhoneのメモ ' + i; });
    if (i % 3 === 0) await change(A, tb.id, (x) => { x.due = '2026-11-' + String(10 + i).padStart(2, '0'); });
    await A.sync();
    await B.sync();
  }
  const after = rowHashes(sheets.snapshot());
  let changed = 0;
  let compared = 0;
  for (const [tab, rows] of Object.entries(before)) {
    rows.forEach((h, i) => {
      compared += 1;
      if (after[tab][i] !== h) changed += 1;
    });
  }
  const writes = sheets.log.slice(logStart).filter((l) => l.method === 'appendRows' || l.method === 'addTab');
  const wrongTab = writes.filter((l) => l.title !== tabs[l.device]).length;
  const counts = Object.entries(after).map(([tab, rows]) => tab + ' ' + (before[tab] ? before[tab].length - (tab === '説明' ? 0 : 1) : 0) + '→' + (rows.length - (tab === '説明' ? 0 : 1)) + '行').join('、');
  t.diagnostic('S12: 比べた行 ' + compared + '・変わった行 ' + changed + '・書き込み ' + writes.length + '回（うち他の端末のタブ ' + wrongTab + '回）・' + counts);
  assert.equal(changed, 0);
  assert.equal(wrongTab, 0);
  assert.ok(writes.length >= 10);
  await A.sync(); // A reads B's last change
  assert.deepEqual(await A.items(), await B.items());
});

test('S13 two devices syncing at the same moment, 10 times: every version of both devices is in the sheet (none lost)', async (t) => {
  const sheets = new FakeSheets();
  sheets.latency = 6; // answers come back after a random wait, so the two runs interleave
  const { A, B, clock } = await connectedPair(sheets);
  const ta = await add(A, 'PCだけが直す');
  const tb = await add(B, 'iPhoneだけが直す');
  const shared = await add(A, '両方が直す（違う所）');
  await A.sync();
  await B.sync();
  await A.sync();
  let overlapped = 0;
  let maxGap = 0;
  for (let i = 0; i < 10; i += 1) {
    clock.tick(30 * 1000);
    await change(A, ta.id, (x) => { x.title = 'PC ' + i; });
    await change(B, tb.id, (x) => { x.title = 'iPhone ' + i; });
    await change(A, shared.id, (x) => { x.due = '2026-11-' + String(10 + i).padStart(2, '0'); });
    await change(B, shared.id, (x) => { x.memo = 'iPhone ' + i; });
    const starts = [];
    const ends = [];
    const run = async (dev) => {
      starts.push(Date.now());
      const r = await dev.sync();
      ends.push(Date.now());
      return r;
    };
    const rs = await Promise.all([run(A), run(B)]);
    assert.ok(rs.every((r) => r.status === 'synced'), JSON.stringify(rs.map((r) => r.status)));
    maxGap = Math.max(maxGap, Math.abs(starts[0] - starts[1]));
    if (Math.max(...starts) < Math.min(...ends)) overlapped += 1;
  }
  for (let i = 0; i < 2; i += 1) { await A.sync(); await B.sync(); }
  const inSheet = new Set(Object.values(sheets.snapshot()).flat().map((r) => r[7]));
  const mine = [...(await mineVersions(A)), ...(await mineVersions(B))];
  const lost = mine.filter((n) => !inSheet.has(n));
  const questions = (await A.engine.questions()).length + (await B.engine.questions()).length;
  t.diagnostic('S13: 同時の同期 10回（実際に重なった回 ' + overlapped + '・開始のずれ 最大 ' + maxGap + 'ms）・両端末が作った版 ' + mine.length + '・シートにある ' + (mine.length - lost.length) + '・取りこぼし ' + lost.length + '件・質問 ' + questions + '件');
  assert.equal(lost.length, 0);
  assert.equal(questions, 0);
  assert.ok(overlapped >= 5, 'the runs should really overlap: ' + overlapped);
  assert.deepEqual(await A.items(), await B.items());
  const x = (await A.data()).tasks.find((y) => y.id === shared.id);
  assert.equal(x.due, '2026-11-19');
  assert.equal(x.memo, 'iPhone 9');
});

test('S17 rows changed by hand: a removed row is noticed, the tab is read again and the sync goes on; a rewritten J cell is "1 unreadable row" and is not used', async (t) => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const tabA = (await A.syncRecords()).config.myTab;
  const ids = [];
  for (const n of ['一', '二', '三']) ids.push((await add(A, n)).id);
  await A.sync();
  await B.sync();
  // 1. a person removes one of A's rows (one B has already read)
  const rowsA = sheets.snapshot()[tabA];
  const victim = rowsA.findIndex((r) => r[3] === '二');
  sheets.deleteRow(tabA, victim + 1);
  await add(A, '四');
  clock.tick(1000);
  const ra = await A.sync(); // A notices its own tab changed, reads it again, sends the missing row again
  const rb = await B.sync(); // B notices A's tab changed and reads it again
  const titlesInSheet = sheets.snapshot()[tabA].slice(1).map((r) => r[3]);
  t.diagnostic('S17-1: 手で1行消した → Mac の同期 ' + ra.status + '（送り直し含め ' + ra.stats.sent + '行）・iPhone の同期 ' + rb.status + '・Mac のタブの見出し ' + titlesInSheet.length + '行（「二」' + titlesInSheet.filter((x) => x === '二').length + '行）');
  assert.equal(ra.status, 'synced');
  assert.equal(rb.status, 'synced');
  assert.ok(titlesInSheet.includes('二')); // sent again
  assert.deepEqual((await B.data()).tasks.map((x) => x.title).sort(), ['一', '三', '二', '四'].sort());
  assert.equal(rb.stats.unreadable, 0);
  // 2. A changes a task; before B reads it, a person rewrites the J cell of that row
  await change(A, ids[0], (x) => { x.title = '一（直した）'; });
  await A.sync();
  const rows = sheets.snapshot()[tabA];
  const rowNo = rows.findIndex((r) => r[3] === '一（直した）') + 1;
  sheets.setCell(tabA, rowNo, 'J', rows[rowNo - 1][9].replace('一（直した）', '手で書き換えた'));
  const r2 = await B.sync();
  const bt = (await B.data()).tasks.find((x) => x.id === ids[0]);
  const st = await B.engine.status();
  t.diagnostic('S17-2: J列を1つ書き換え → iPhone の「読めない行」' + r2.stats.unreadable + '件（設定の表示 ' + st.unreadable + '件）・iPhone のタスク名「' + bt.title + '」');
  assert.equal(r2.status, 'synced');
  assert.equal(r2.stats.unreadable, 1);
  assert.equal(st.unreadable, 1);
  assert.equal(bt.title, '一'); // the rewritten row is not used
  assert.equal(JSON.stringify(await B.data()).includes('手で書き換えた'), false);
});
