// Many random operations on three devices with random syncs, lost answers, no signal and busy servers.
// At the end (signal back, every question answered) every device must hold exactly the same items,
// nothing may wait to be sent, every version a device made must be in the sheet, and the dragon must
// equal what the records say. The random numbers are seeded: the same run every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets, mulberry32 } from './helpers/fake-google.js';
import { makeDevice, makeClock } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import * as T from '../public/js/tasks.js';
import { countXp } from '../public/js/dragon.js';

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

async function operate(rnd, dev, clock) {
  const at = clock.now();
  const today = clock.today();
  const op = Math.floor(rnd() * 16);
  await dev.edit((d) => {
    const live = d.tasks.filter((t) => !t.purgedAt);
    const t = live.length ? pick(rnd, live) : null;
    const touch = (x) => { x.updatedAt = at; };
    switch (op) {
      case 0: case 1: d.tasks.push(T.newTask({ title: dev.name + 'の' + Math.floor(rnd() * 1000), rank: pick(rnd, ['A', 'B', 'C', null]) }, at, T.nextOrder(d.tasks))); break;
      case 2: if (t) { t.title = dev.name + '直し' + Math.floor(rnd() * 100); touch(t); } break;
      case 3: if (t) { t.due = '2026-11-' + String(1 + Math.floor(rnd() * 28)).padStart(2, '0'); touch(t); } break;
      case 4: if (t) { if (t.status === 'done') T.uncompleteTask(t, at); else T.completeTask(t, today, at); } break;
      case 5: if (t && t.route.length < T.ROUTE_MAX) { T.addStep(t, 'confirm', d.people[0].id, ''); touch(t); } break;
      case 6: if (t && t.route.length) { const s = pick(rnd, t.route); T.setStepState(t, s.id, pick(rnd, ['wait', 'done', 'todo']), today); T.collectStepXp(t); touch(t); } break;
      case 7: if (t) { if (t.deletedAt) T.restoreTask(t, at); else T.trashTask(t, at); } break;
      case 8: if (t && t.deletedAt && rnd() < 0.5) T.purgeTask(t, at); break;
      case 9: {
        const vis = d.tasks.filter((x) => T.isLive(x) && !x.parked).sort(T.byOrder);
        if (vis.length > 2) {
          const ids = vis.map((x) => x.id);
          const [m] = ids.splice(Math.floor(rnd() * ids.length), 1);
          ids.splice(Math.floor(rnd() * (ids.length + 1)), 0, m);
          T.applyReorder(d.tasks, ids, m, at);
        }
        break;
      }
      case 10: if (t && !t.deletedAt && t.status !== 'done') { if (t.parked) T.unparkTask(t, d.tasks, false, at); else T.parkTask(t, rnd() < 0.5 ? null : '2026-11-30', at); } break;
      case 11: d.memos.push({ id: dev.name + '-m-' + Math.floor(rnd() * 1e9), text: dev.name + 'のメモ', createdAt: at, taskId: null, deletedAt: null, purgedAt: null }); break;
      case 12: if (d.memos.length) { const m = pick(rnd, d.memos); if (!m.purgedAt) m.text = dev.name + 'メモ直し' + Math.floor(rnd() * 100); } break;
      case 13: if (d.goals.week.lines.length < 8) d.goals.week.lines.push(dev.name + '目標' + Math.floor(rnd() * 100)); else d.goals.week.lines.splice(0, 1); break;
      case 14: if (d.schedule.lines.length < 20) d.schedule.lines.push({ id: dev.name + '-s-' + Math.floor(rnd() * 1e9), text: '10:00 ' + dev.name }); else d.schedule.lines.splice(0, 1); break;
      default: { const p = pick(rnd, d.people); p.name = (dev.name + '相手' + Math.floor(rnd() * 10)).slice(0, 20); p.initial = T.initialOf(p.name); }
    }
  });
}

async function quiesce(devs, sheets, answered) {
  sheets.faults.length = 0;
  for (const d of devs) d.online = true;
  for (let round = 0; round < 12; round += 1) {
    for (const d of devs) await d.sync();
    for (const d of devs) await d.sync();
    let asked = 0;
    for (const d of devs) {
      for (const q of await d.engine.questions()) {
        asked += 1;
        answered.n += 1;
        await d.engine.choose(q.key, 'a');
      }
    }
    if (!asked) {
      const items = await Promise.all(devs.map((d) => d.items()));
      if (items.every((x) => JSON.stringify(x) === JSON.stringify(items[0]))) return round;
    }
  }
  return -1;
}

// SYNC_SEEDS=40 runs seeds 1..40 (more than the usual 6)
const SEEDS = Array.from({ length: Number(process.env.SYNC_SEEDS) || 6 }, (_, i) => i + 1);
for (const seed of SEEDS) {
  test('random operations on three devices (seed ' + seed + '): after the signal is back and every question answered, all the same, nothing lost', { timeout: 120000 }, async (t) => {
    const rnd = mulberry32(seed);
    const sheets = new FakeSheets();
    const clock = makeClock('2026-10-20T01:00:00.000Z');
    const devs = [];
    for (const n of ['Mac', 'iPhone', 'iPad']) {
      const d = await makeDevice(sheets, n, { clock });
      await d.init();
      await d.connect();
      devs.push(d);
    }
    let syncs = 0;
    let faults = 0;
    const answered = { n: 0 };
    for (let i = 0; i < 250; i += 1) {
      clock.tick(Math.floor(rnd() * 60000));
      const dev = pick(rnd, devs);
      const r = rnd();
      if (r < 0.03) {
        // now and then a question is answered in the middle of everything
        const qs = await dev.engine.questions();
        if (qs.length) { await dev.engine.choose(qs[0].key, rnd() < 0.5 ? 'a' : 'b'); answered.n += 1; }
      } else if (r < 0.58) await operate(rnd, dev, clock);
      else if (r < 0.62) dev.online = !dev.online;
      else {
        const f = rnd();
        if (f < 0.1) { sheets.inject({ device: dev.name, method: 'appendRows', error: 'lost' }); faults += 1; }
        else if (f < 0.15) { sheets.inject({ device: dev.name, method: 'readTabs', error: 503, times: 4 }); faults += 1; }
        else if (f < 0.2) { sheets.inject({ device: dev.name, method: 'appendRows', error: 'offline' }); faults += 1; }
        await dev.sync();
        syncs += 1;
      }
    }
    const rounds = await quiesce(devs, sheets, answered);
    assert.ok(rounds >= 0, 'the devices did not settle');
    const inSheet = new Set(Object.values(sheets.snapshot()).flat().map((row) => row[7]));
    let made = 0;
    let lost = 0;
    let questions = 0;
    for (const d of devs) {
      const st = await d.engine.status();
      assert.equal(st.pending, 0, d.name + ' pending');
      assert.equal(st.unreadable, 0, d.name + ' unreadable');
      questions += st.choices;
      for (const doc of await ST.getAllRevs(d.db)) {
        for (const [n, v] of Object.entries(doc.v)) {
          if (!v.m) continue;
          made += 1;
          if (!inSheet.has(n)) lost += 1;
        }
      }
      const data = await d.data();
      assert.deepEqual(data.dragon.xp, countXp(data.tasks), d.name + ' dragon');
    }
    const items = await devs[0].items();
    t.diagnostic('seed ' + seed + ': 同期 ' + syncs + '回・故障 ' + faults + '回・端末が作った版 ' + made + '・取りこぼし ' + lost + '・答えた質問 ' + answered.n + '・残った質問 ' + questions + '・そろうまで ' + rounds + '巡・項目 ' + Object.keys(items).length);
    assert.equal(lost, 0);
    assert.equal(questions, 0);
  });
}

// The person also saves changes in the middle of runs (while a run waits for Google). Every change is a new
// "token" added to the memo of a task, never removed by the person (nothing is completely deleted here), so each
// token must end up in some row of the sheet: a token missing from the sheet is a change that was lost.
async function tokenEdit(rnd, dev, tokens) {
  await dev.edit((d) => {
    const live = d.tasks.filter((t) => !t.purgedAt);
    if (!live.length) return;
    const t = pick(rnd, live);
    const tok = '#' + dev.name + tokens.size;
    tokens.add(tok);
    t.memo = (t.memo + ' ' + tok).slice(-1900);
    t.updatedAt = dev.clock.now();
  });
}

for (const seed of SEEDS.map((s) => s + 100)) {
  test('edits saved while runs are going on (seed ' + seed + '): every saved change reaches the sheet, nothing is lost', { timeout: 120000 }, async (t) => {
    const rnd = mulberry32(seed);
    const sheets = new FakeSheets();
    const clock = makeClock('2026-10-20T01:00:00.000Z');
    const devs = [];
    for (const n of ['Mac', 'iPhone', 'iPad']) {
      const d = await makeDevice(sheets, n, { clock });
      await d.init();
      await d.connect();
      devs.push(d);
    }
    const byName = Object.fromEntries(devs.map((d) => [d.name, d]));
    const tokens = new Set();
    for (const d of devs) for (let i = 0; i < 3; i += 1) await d.edit((x) => { x.tasks.push(T.newTask({ title: d.name + 'の共有' + i }, clock.now(), T.nextOrder(x.tasks))); });
    for (const d of devs) await d.sync();
    for (const d of devs) await d.sync();
    let during = 0;
    sheets.during = async (device, method) => {
      if (method === 'readTabs' && rnd() < 0.35) {
        during += 1;
        await tokenEdit(rnd, byName[device], tokens);
      }
    };
    for (let i = 0; i < 150; i += 1) {
      clock.tick(Math.floor(rnd() * 30000));
      const dev = pick(rnd, devs);
      const r = rnd();
      if (r < 0.04) {
        const qs = await dev.engine.questions();
        if (qs.length) await dev.engine.choose(qs[0].key, rnd() < 0.5 ? 'a' : 'b');
      } else if (r < 0.35) await tokenEdit(rnd, dev, tokens);
      else if (r < 0.45) await dev.edit((d) => { const x = d.tasks.find((y) => !y.purgedAt); if (x) { x.title = dev.name + '名前' + i; x.updatedAt = clock.now(); } });
      else if (r < 0.5) dev.editing = rnd() < 0.5 ? new Set() : new Set((await dev.data()).tasks.map((x) => 'task:' + x.id).slice(0, 1));
      else if (r < 0.55) dev.online = !dev.online;
      else {
        if (rnd() < 0.15) sheets.inject({ device: dev.name, method: 'appendRows', error: 'lost' });
        await dev.sync();
      }
    }
    sheets.during = null;
    for (const d of devs) d.editing = new Set();
    const answered = { n: 0 };
    const rounds = await quiesce(devs, sheets, answered);
    assert.ok(rounds >= 0, 'the devices did not settle');
    const sheet = JSON.stringify(sheets.snapshot());
    const lost = [...tokens].filter((tok) => !sheet.includes(tok + '"') && !sheet.includes(tok + ' ') && !sheet.includes(tok + '\\'));
    t.diagnostic('seed ' + seed + ': 手元の変更 ' + tokens.size + '件（うち同期の途中に保存 ' + during + '件）・シートに無い変更 ' + lost.length + '件・答えた質問 ' + answered.n + '・そろうまで ' + rounds + '巡');
    assert.deepEqual(lost, []);
  });
}
