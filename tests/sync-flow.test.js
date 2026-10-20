// The sync run (7-7) with two devices on the fake Google: questions, no signal and waiting versions, sending twice,
// pause and resume, dates, what is being edited, a failed save, two tabs, reading a file meanwhile, the dragon,
// marks, a drag, three devices and the stop against a run-away loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { makeDevice, makeClock, connectedPair } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { newTask, completeTask, setStepState, collectStepXp, trashTask, purgeTask, applyReorder, parkTask, returnDueParked, isLive } from '../public/js/tasks.js';
import { rolloverGoals, rolloverSchedule } from '../public/js/plan.js';
import { countXp } from '../public/js/dragon.js';
import { itemsOf } from '../public/js/sync/records.js';

async function add(dev, title, extra) {
  return dev.edit((d) => {
    const t = newTask(Object.assign({ title }, extra), dev.clock.now(), d.tasks.length);
    d.tasks.push(t);
    return t;
  });
}

async function change(dev, id, fn) {
  return dev.edit((d) => {
    const t = d.tasks.find((x) => x.id === id);
    fn(t, d);
    t.updatedAt = dev.clock.now();
  });
}

async function task(dev, id) {
  return (await dev.data()).tasks.find((t) => t.id === id);
}

async function settleAll(...devs) {
  for (let i = 0; i < 2; i += 1) for (const d of devs) await d.sync();
}

function myRows(sheets, dev, title) {
  return sheets.snapshot()[title].length - 1;
}

test('the same place changed on both: asked on both devices; the newer one is shown meanwhile and never sent as this device\'s; the answer reaches both', async () => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const t = await add(A, '名前を決める');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.title = 'PCの名前'; });
  clock.tick(1000);
  await change(B, t.id, (x) => { x.title = 'iPhoneの名前'; });
  await settleAll(A, B);
  const qa = await A.engine.questions();
  const qb = await B.engine.questions();
  assert.equal(qa.length, 1);
  assert.equal(qb.length, 1);
  assert.deepEqual(qa[0].fields.map((f) => f.field), ['title']);
  assert.equal(await A.engine.isQuestion('task:' + t.id), true);
  assert.equal((await task(A, t.id)).title, 'iPhoneの名前'); // the newer one, for the time being
  assert.equal((await task(B, t.id)).title, 'iPhoneの名前');
  // what is shown meanwhile is not this device's change: another run sends nothing
  const rowsBefore = Object.values(sheets.snapshot()).reduce((n, r) => n + r.length, 0);
  assert.equal((await A.sync()).stats.sent, 0);
  assert.equal(Object.values(sheets.snapshot()).reduce((n, rr) => n + rr.length, 0), rowsBefore);
  // something changed on top of it anyway (a memo): only that goes up, on the Mac's own version (its own name),
  // never the name shown for the time being; the question stays
  await change(A, t.id, (x) => { x.memo = '選ぶ前に触った'; });
  const r = await A.sync();
  assert.equal(r.stats.sent, 1);
  const sent = Object.values(sheets.snapshot()).flat().filter((row) => row[6] === 'task:' + t.id && (row[9] || '').includes('選ぶ前に触った'));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0][9]).title, 'PCの名前');
  assert.equal((await A.engine.questions()).length, 1);
  assert.equal((await task(A, t.id)).memo, '選ぶ前に触った');
  // the answer on A: "PC" (side of the Mac)
  await settleAll(A, B);
  const q2 = (await A.engine.questions())[0];
  const sideA = q2.a.device === 'Mac' ? 'a' : 'b';
  const ans = await A.engine.choose('task:' + t.id, sideA);
  assert.equal(ans.ok, true);
  assert.equal((await task(A, t.id)).title, 'PCの名前');
  assert.equal((await task(A, t.id)).memo, '選ぶ前に触った');
  await settleAll(A, B);
  assert.equal((await task(B, t.id)).title, 'PCの名前');
  assert.equal((await task(B, t.id)).memo, '選ぶ前に触った');
  assert.equal((await B.engine.questions()).length, 0);
  assert.deepEqual(await A.items(), await B.items());
  // the value not chosen stays in the sheet
  const all = Object.values(sheets.snapshot()).flat().map((row) => row[9] || '');
  assert.ok(all.some((j) => j.includes('iPhoneの名前')));
  assert.ok(Object.values(sheets.snapshot()).flat().some((row) => row[5] === '選んだ結果'));
});

test('answered differently on two devices before they met: asked again', async () => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const t = await add(A, '名前');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.title = 'PC案'; });
  clock.tick(1000);
  await change(B, t.id, (x) => { x.title = 'iPhone案'; });
  await settleAll(A, B);
  const q = (await A.engine.questions())[0];
  const mac = q.a.device === 'Mac' ? 'a' : 'b';
  const phone = mac === 'a' ? 'b' : 'a';
  await A.engine.choose(q.key, mac);
  await B.engine.choose(q.key, phone);
  await settleAll(A, B);
  const again = await A.engine.questions();
  assert.equal(again.length, 1);
  assert.deepEqual(again[0].fields.map((f) => f.field), ['title']);
  assert.equal((await B.engine.questions()).length, 1);
  await A.engine.choose(q.key, 'a');
  await settleAll(A, B);
  assert.equal((await B.engine.questions()).length, 0);
  assert.deepEqual(await A.items(), await B.items());
});

test('no signal: nothing goes to Google, the changes wait ("未送信"), and go when the signal is back', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  A.online = false;
  await add(A, '地下で足した');
  const calls = sheets.log.length;
  const r = await A.sync();
  assert.equal(r.status, 'offline');
  assert.equal(r.pending, 1);
  assert.equal(sheets.log.length, calls);
  A.online = true;
  const r2 = await A.sync();
  assert.equal(r2.status, 'synced');
  assert.equal(r2.stats.sent, 1);
  await B.sync();
  assert.ok((await B.data()).tasks.some((t) => t.title === '地下で足した'));
  // the signal goes away while sending: the version waits and is sent next time
  await add(A, '送る途中で切れた');
  sheets.inject({ device: 'Mac', method: 'appendRows', error: 'offline' });
  const r3 = await A.sync();
  assert.equal(r3.status, 'offline');
  assert.equal(r3.pending, 1);
  assert.equal((await A.engine.status()).pending, 1);
  const r4 = await A.sync();
  assert.equal(r4.stats.sent, 1);
  assert.equal(r4.pending, 0);
});

test('sent, but the answer never came back: the rows are found next time and not sent again; duplicate rows count once', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const myTab = (await A.syncRecords()).config.myTab;
  await add(A, '一つ目');
  sheets.inject({ device: 'Mac', method: 'appendRows', error: 'lost' });
  const r = await A.sync();
  assert.equal(r.status, 'offline');
  const rows = myRows(sheets, A, myTab);
  const r2 = await A.sync();
  assert.equal(r2.stats.sent, 0); // found in the sheet: not sent again
  assert.equal(r2.pending, 0);
  assert.equal(myRows(sheets, A, myTab), rows);
  // the same row twice in the sheet (sent twice): one version
  const last = sheets.snapshot()[myTab].slice(-1)[0];
  sheets.appendRaw(myTab, last);
  const rb = await B.sync();
  assert.equal(rb.stats.unreadable, 0);
  assert.equal((await B.data()).tasks.filter((t) => t.title === '一つ目').length, 1);
  const docs = await ST.getAllRevs(B.db);
  const versions = docs.filter((d) => d.key.startsWith('task:')).map((d) => Object.keys(d.v).length);
  assert.deepEqual(versions, [1]);
});

test('both devices put the same two versions together at the same time: the same name, one version', async () => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const t = await add(A, '元');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.due = '2026-10-30'; });
  clock.tick(1000);
  await change(B, t.id, (x) => { x.memo = 'iPhoneのメモ'; });
  await A.sync();
  await B.sync(); // B merges
  // A also merges before reading B's merge (it reads B's change first): make A forget B's merge row for a moment
  const docsB = await ST.getRevs(B.db, ['task:' + t.id]);
  const merges = Object.entries(docsB.get('task:' + t.id).v).filter(([, v]) => v.o === 'merge').map(([n]) => n);
  assert.equal(merges.length, 1);
  await A.sync();
  const docsA = await ST.getRevs(A.db, ['task:' + t.id]);
  assert.deepEqual(Object.keys(docsA.get('task:' + t.id).v).sort(), Object.keys(docsB.get('task:' + t.id).v).sort());
  const x = await task(A, t.id);
  assert.equal(x.due, '2026-10-30');
  assert.equal(x.memo, 'iPhoneのメモ');
});

test('pause: no call to Google at all; what was changed meanwhile goes after "再開"', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  await A.engine.pause();
  const calls = sheets.log.length;
  await add(A, '一時停止中に足した');
  assert.equal((await A.sync()).status, 'paused');
  assert.equal((await A.sync()).status, 'paused');
  assert.equal(sheets.log.length, calls);
  assert.equal((await A.engine.status()).status, 'paused');
  await A.engine.resume();
  const r = await A.sync();
  assert.equal(r.stats.sent, 1);
  await B.sync();
  assert.ok((await B.data()).tasks.some((t) => t.title === '一時停止中に足した'));
});

test('dates: the end of a period or a day sends nothing new; a period that has not come yet waits; both bringing back the same task ask nothing', async () => {
  const sheets = new FakeSheets();
  const clockA = makeClock('2026-10-20T01:00:00.000Z');
  const clockB = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock: clockA });
  const B = await makeDevice(sheets, 'iPhone', { clock: clockB });
  await A.init();
  await B.init();
  await A.connect();
  await B.connect();
  await A.edit((d) => { d.goals.week.lines = ['今週の目標']; d.schedule.lines = [{ id: 'l1', text: '9:00 朝礼' }]; });
  const t = await add(A, '箱のタスク');
  await change(A, t.id, (x) => { parkTask(x, '2026-10-27', clockA.now()); });
  await settleAll(A, B);
  // a week later on A: the date check moves the goals and the schedule to the history
  clockA.set('2026-10-27T01:00:00.000Z');
  clockB.set('2026-10-27T01:00:00.000Z');
  for (const [dev, clock] of [[A, clockA], [B, clockB]]) {
    await dev.edit((d) => {
      rolloverGoals(d.goals, d.goalLog, clock.today(), clock.now());
      rolloverSchedule(d, clock.today());
      returnDueParked(d.tasks, clock.today(), clock.now()); // both bring the task back from the box
    });
  }
  const ra = await A.sync();
  const rb = await B.sync();
  await settleAll(A, B);
  assert.equal(ra.stats.sent, 1); // only the task that came back (no goal / schedule rows)
  assert.equal((await A.engine.questions()).length + (await B.engine.questions()).length, 0);
  assert.equal((await A.data()).goalLog.find((e) => e.key === '2026-10-19').lines[0], '今週の目標');
  assert.equal((await B.data()).scheduleLog.find((e) => e.date === '2026-10-20').lines[0].text, '9:00 朝礼');
  assert.equal((await task(B, t.id)).parked, false);
  assert.deepEqual(await A.items(), await B.items());
  assert.ok(rb.status === 'synced');
  // B's clock runs a week ahead: its goals for "next week" wait on A until that week comes
  clockB.set('2026-11-03T01:00:00.000Z');
  await B.edit((d) => { rolloverGoals(d.goals, d.goalLog, clockB.today(), clockB.now()); d.goals.week.lines = ['未来の週の目標']; });
  await B.sync();
  await A.sync();
  assert.equal((await A.data()).goals.week.start, '2026-10-26');
  assert.equal(JSON.stringify(await A.data()).includes('未来の週の目標'), false); // not shown yet
  assert.equal((await A.engine.status()).waiting, 1);
  clockA.set('2026-11-03T01:00:00.000Z');
  await A.edit((d) => { rolloverGoals(d.goals, d.goalLog, clockA.today(), clockA.now()); });
  await A.sync();
  assert.deepEqual((await A.data()).goals.week.lines, ['未来の週の目標']);
  assert.equal((await A.engine.status()).waiting, 0);
});

test('what is being edited is not overwritten; it comes in when the editing is over', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const t = await add(A, '詳細を開いている');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.due = '2026-10-31'; });
  await A.sync();
  B.editing.add('task:' + t.id);
  const r = await B.sync();
  assert.equal(r.stats.deferred, 1);
  assert.equal((await task(B, t.id)).due, null);
  B.editing.clear();
  const r2 = await B.sync();
  assert.equal(r2.stats.applied, 1);
  assert.equal((await task(B, t.id)).due, '2026-10-31');
});

test('changed by the person while the run was waiting for Google: not overwritten, put together next time', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const t = await add(A, '同時に触る');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.due = '2026-11-02'; });
  await A.sync();
  // B's run reads the data, then (while it waits for Google) the person saves a change of the same task
  const realRead = B.google.readTabs;
  let once = true;
  B.google.readTabs = async (...args) => {
    if (once) {
      once = false;
      await change(B, t.id, (x) => { x.memo = '打っていた'; });
    }
    return realRead(...args);
  };
  const r = await B.sync();
  B.google.readTabs = realRead;
  assert.equal(r.stats.deferred, 1);
  let x = await task(B, t.id);
  assert.equal(x.memo, '打っていた');
  assert.equal(x.due, null);
  await settleAll(B, A);
  x = await task(B, t.id);
  assert.equal(x.memo, '打っていた');
  assert.equal(x.due, '2026-11-02');
  assert.deepEqual(await A.items(), await B.items());
});

test('saving the result fails: the version shown does not move (no change is mistaken for this device\'s), next time it comes in', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const t = await add(A, '保存に失敗する');
  await A.sync();
  const appliedBefore = (await B.syncRecords()).applied;
  const realCommit = B.storage.commit;
  B.storage.commit = async () => { throw Object.assign(new Error('the disk is full (test)'), { name: 'QuotaExceededError' }); };
  const r = await B.sync();
  B.storage.commit = realCommit;
  assert.equal(r.status, 'error');
  assert.equal((await B.data()).tasks.length, 0);
  assert.deepEqual((await B.syncRecords()).applied, appliedBefore);
  // another tab keeps saving first, three times: the screen stays, the run says "retry"
  let n = 0;
  B.storage.commit = async () => { n += 1; throw new ST.ConflictError('conflict'); };
  const r2 = await B.sync();
  B.storage.commit = realCommit;
  assert.equal(r2.status, 'retry');
  assert.equal(n, 3);
  assert.equal((await B.data()).tasks.length, 0);
  const r3 = await B.sync();
  assert.equal(r3.status, 'synced');
  assert.equal((await task(B, t.id)).title, '保存に失敗する');
  // nothing was sent back as if B had changed it
  assert.equal(sheets.calls('iPhone', 'appendRows'), 0);
});

test('two tabs of one device sync at the same time: one after the other (Web Locks), nothing sent twice', async () => {
  const sheets = new FakeSheets();
  sheets.latency = 3;
  const { A, B } = await connectedPair(sheets);
  const tab2 = A.newEngine();
  await add(A, 'タブ1');
  await add(A, 'タブ2');
  const [r1, r2] = await Promise.all([A.engine.sync(), tab2.sync()]);
  assert.equal(r1.status, 'synced');
  assert.equal(r2.status, 'synced');
  assert.equal(r1.stats.sent + r2.stats.sent, 2);
  const myTab = (await A.syncRecords()).config.myTab;
  const keys = sheets.snapshot()[myTab].slice(1).map((r) => r[7]);
  assert.equal(new Set(keys).size, keys.length);
  await B.sync();
  assert.equal((await B.data()).tasks.length, 2);
});

test('a file read in (or a copy restored) while a run waits: the read data is kept and sent next time', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const t = await add(A, '前からある');
  await settleAll(A, B);
  await change(A, t.id, (x) => { x.memo = 'PCで直した'; });
  await A.sync();
  const realRead = B.google.readTabs;
  let once = true;
  B.google.readTabs = async (...args) => {
    if (once) {
      once = false;
      // "読み込む": overwrite and add (0-2 p), saved by the app in the middle of the run
      await B.edit((d) => {
        const x = d.tasks.find((y) => y.id === t.id);
        x.title = 'ファイルの名前';
        x.updatedAt = B.clock.now();
        d.tasks.push(newTask({ title: 'ファイルから足した' }, B.clock.now(), 9));
      });
    }
    return realRead(...args);
  };
  await B.sync();
  B.google.readTabs = realRead;
  let bd = await B.data();
  assert.equal(bd.tasks.find((x) => x.id === t.id).title, 'ファイルの名前');
  await settleAll(B, A);
  bd = await B.data();
  const x = bd.tasks.find((y) => y.id === t.id);
  assert.equal(x.title, 'ファイルの名前');
  assert.equal(x.memo, 'PCで直した');
  assert.ok(bd.tasks.some((y) => y.title === 'ファイルから足した'));
  assert.deepEqual(await A.items(), await B.items());
});

test('the dragon: the same completion and the same step done on two devices count once; Japan-time mornings; deleting completely takes nothing', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-19T16:30:00.000Z'); // 2026-10-20 01:30 in Japan (the day before in UTC)
  const A = await makeDevice(sheets, 'Mac', { clock });
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await A.init();
  await B.init();
  await A.connect();
  await B.connect();
  const t = await add(A, '両方で完了', { rank: 'B', steps: [{ kind: 'confirm', whoId: 'x', note: '' }] });
  await settleAll(A, B);
  const before = (await A.data()).dragon.total;
  assert.equal(before, (await B.data()).dragon.total);
  // offline on both: complete the same task, mark the same step done
  for (const dev of [A, B]) {
    clock.tick(1000);
    await change(dev, t.id, (x) => {
      setStepState(x, x.route[0].id, 'done', clock.today());
      collectStepXp(x);
      completeTask(x, clock.today(), clock.now());
    });
  }
  await settleAll(A, B);
  const ad = await A.data();
  const bd = await B.data();
  assert.equal(ad.dragon.total, bd.dragon.total);
  assert.equal(ad.dragon.total - before, 10 + 2); // rank B once + the step once
  assert.deepEqual(ad.dragon.xp, countXp(ad.tasks));
  // 8 tasks on each device in the Japan-time morning of the same day: the day counts 10 at most, on both
  for (const dev of [A, B]) for (let i = 0; i < 8; i += 1) await add(dev, dev.name + '朝' + i);
  await settleAll(A, B);
  const a2 = await A.data();
  const b2 = await B.data();
  assert.equal(a2.dragon.total, b2.dragon.total);
  assert.deepEqual(a2.dragon.xp, countXp(a2.tasks));
  const added = a2.dragon.total - ad.dragon.total;
  assert.equal(added, 10 - 1); // 1 was already counted that day (the first task)
  // completely deleted on A: nothing is taken away on either device
  await change(A, t.id, (x) => { trashTask(x, clock.now()); purgeTask(x, clock.now()); });
  await settleAll(A, B);
  assert.equal((await A.data()).dragon.total, a2.dragon.total);
  assert.equal((await B.data()).dragon.total, a2.dragon.total);
});

test('a task deleted completely on one device disappears on the other (a mark, in no list)', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const t = await add(A, '消す');
  await settleAll(A, B);
  await change(A, t.id, (x) => { trashTask(x, A.clock.now()); purgeTask(x, A.clock.now()); });
  await settleAll(A, B);
  const x = await task(B, t.id);
  assert.ok(x.purgedAt);
  assert.equal(x.title, '（消したタスク）');
  assert.equal(isLive(x), false);
  assert.equal(ST.countsOf(await B.data()).trash, 0);
  const sheetRow = Object.values(sheets.snapshot()).flat().find((r) => r[6] === 'task:' + t.id && r[4] === '消した');
  assert.ok(sheetRow);
  assert.equal(sheetRow[3], '（消した）');
});

test('one drag in the list changes one task, so one new row', async () => {
  const sheets = new FakeSheets();
  const { A } = await connectedPair(sheets);
  const ids = [];
  for (const n of ['一', '二', '三', '四', '五']) ids.push((await add(A, n)).id);
  await A.sync();
  const myTab = (await A.syncRecords()).config.myTab;
  const rows = myRows(sheets, A, myTab);
  await A.edit((d) => {
    const order = [ids[4], ids[0], ids[1], ids[2], ids[3]];
    const changed = applyReorder(d.tasks, order, ids[4], A.clock.now());
    assert.deepEqual(changed, [ids[4]]);
  });
  const r = await A.sync();
  assert.equal(r.stats.sent, 1);
  assert.equal(myRows(sheets, A, myTab), rows + 1);
});

test('three devices that changed different places: the ends are put together two at a time, the same on every device', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const devs = [];
  for (const n of ['Mac', 'iPhone', 'iPad']) {
    const d = await makeDevice(sheets, n, { clock });
    await d.init();
    await d.connect();
    devs.push(d);
  }
  const [A, B, C] = devs;
  const t = await add(A, '三台');
  await settleAll(A, B, C);
  await change(A, t.id, (x) => { x.due = '2026-10-29'; });
  clock.tick(1000);
  await change(B, t.id, (x) => { x.memo = 'iPhone'; });
  clock.tick(1000);
  await change(C, t.id, (x) => { x.rank = 'A'; });
  for (let i = 0; i < 3; i += 1) for (const d of devs) await d.sync();
  const x = await task(C, t.id);
  assert.equal(x.due, '2026-10-29');
  assert.equal(x.memo, 'iPhone');
  assert.equal(x.rank, 'A');
  assert.deepEqual(await A.items(), await B.items());
  assert.deepEqual(await B.items(), await C.items());
  const doc = (await ST.getRevs(A.db, ['task:' + t.id])).get('task:' + t.id);
  const tipsLeft = Object.keys(doc.v).filter((n) => !Object.values(doc.v).some((v) => v.p.includes(n)));
  assert.equal(tipsLeft.length, 1);
});

test('the stop against a run-away loop: at most once every 10 seconds and 120 times an hour', async () => {
  const sheets = new FakeSheets();
  const { A, clock } = await connectedPair(sheets);
  const e = A.newEngine({ limits: { minIntervalMs: 10000, perHour: 120 } });
  clock.tick(60000);
  assert.equal((await e.sync()).status, 'synced');
  const later = await e.sync();
  assert.equal(later.status, 'later');
  clock.tick(10000);
  assert.equal((await e.sync()).status, 'synced');
  const few = A.newEngine({ limits: { minIntervalMs: 0, perHour: 3 } });
  clock.tick(3600 * 1000);
  for (let i = 0; i < 3; i += 1) assert.equal((await few.sync()).status, 'synced');
  assert.equal((await few.sync()).status, 'later');
});

test('items keep their key and content through the whole trip (what a device shows = what the sheet holds)', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  await A.edit((d) => {
    d.memos.push({ id: 'memo-1', text: '会議のメモ', createdAt: A.clock.now(), taskId: null, deletedAt: null, purgedAt: null });
    d.goals.month.lines = ['月の目標'];
    d.schedule.lines = [{ id: 's1', text: '10:00 面談' }];
    d.dragon.name = 'ソラ';
    d.people[0].name = '部長';
  });
  await settleAll(A, B);
  const bd = await B.data();
  assert.equal(bd.memos[0].text, '会議のメモ');
  assert.deepEqual(bd.goals.month.lines, ['月の目標']);
  assert.equal(bd.schedule.lines[0].text, '10:00 面談');
  assert.equal(bd.dragon.name, 'ソラ');
  assert.equal(bd.people[0].name, '部長');
  assert.deepEqual([...itemsOf(bd).keys()].sort(), [...itemsOf(await A.data()).keys()].sort());
});
