// Connecting a device (7-12 "つなぐときの決まり"): the file is made only after asking, an empty device receives
// without asking, a device with data is asked and keeps a copy, an empty sync file gets this device's data
// (same-name people joined), and two files / a file in the trash / a lost file stop everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { makeDevice, makeClock, connectedPair } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { newTask } from '../public/js/tasks.js';

async function withTask(dev, title, extra) {
  return dev.edit((d) => {
    const t = newTask(Object.assign({ title }, extra), dev.clock.now(), d.tasks.length);
    d.tasks.push(t);
    return t;
  });
}

test('no sync file yet: it is made only when the person says so ("作りますか？")', async () => {
  const sheets = new FakeSheets();
  const A = await makeDevice(sheets, 'Mac');
  await A.init();
  await withTask(A, '最初のタスク');
  const no = await A.connect({ create: async () => false });
  assert.equal(no.status, 'cancelled');
  assert.equal(sheets.files.length, 0);
  assert.equal(sheets.calls(null, 'createFile'), 0);
  let asked = 0;
  const yes = await A.connect({ create: async () => { asked += 1; return true; } });
  assert.equal(asked, 1);
  assert.equal(yes.status, 'connected');
  assert.equal(yes.how, 'created');
  assert.equal(sheets.files.length, 1);
  const tabs = sheets.snapshot();
  assert.deepEqual(Object.keys(tabs).sort(), ['説明', (await A.syncRecords()).config.myTab].sort());
  const mine = tabs[(await A.syncRecords()).config.myTab];
  assert.deepEqual(mine[0], ['日時', '端末', '種類', '見出し', '状態', '操作', '項目キー', '版', '元の版', '中身']);
  assert.equal(mine.length - 1, 11); // 10 people + 1 task, nothing empty
  assert.ok(mine.slice(1).every((r) => r[1] === 'Mac' && r[5] === '追加'));
  assert.equal((await A.engine.status()).pending, 0);
});

test('an empty second device receives without being asked', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await A.init();
  await withTask(A, 'PCで足した');
  await A.connect();
  await B.init();
  let asked = 0;
  const r = await B.connect({ create: async () => true, receive: async () => { asked += 1; return true; } });
  assert.equal(r.status, 'connected');
  assert.equal(r.how, 'received');
  assert.equal(r.kept, false); // nothing to keep: the notice does not speak of a copy
  assert.equal(asked, 0);
  assert.deepEqual(await B.items(), await A.items());
  assert.equal(sheets.calls('iPhone', 'createFile'), 0);
});

test('a second device with data is asked; "やめる" changes nothing; "受け取る" keeps a copy first and keeps the device settings', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await A.init();
  await withTask(A, 'PCのタスク');
  await A.connect();
  await B.init();
  await withTask(B, 'iPhoneのタスク');
  await B.edit((d) => { d.settings.lastExportAt = '2026-10-18T00:00:00.000Z'; });
  const before = await B.items();
  let counts = null;
  const no = await B.connect({ receive: async (c) => { counts = c; return false; } });
  assert.equal(no.status, 'cancelled');
  assert.equal(counts.tasks, 1);
  assert.deepEqual(await B.items(), before);
  assert.equal(Object.keys(sheets.snapshot()).length, 2); // no tab was made for B
  const yes = await B.connect({ receive: async () => true });
  assert.equal(yes.how, 'received');
  assert.equal(yes.kept, true);
  assert.deepEqual(await B.items(), await A.items());
  const data = await B.data();
  assert.equal(data.settings.lastExportAt, '2026-10-18T00:00:00.000Z');
  const copy = (await ST.listBackups(B.db)).find((b) => b.id === 'pre-sync');
  assert.ok(copy);
  assert.deepEqual(copy.data.tasks.map((t) => t.title), ['iPhoneのタスク']);
  assert.equal((await ST.listBackups(B.db)).some((b) => b.id === 'pre-import'), false); // its own slot
});

test('an empty sync file (only the first people): this device\'s data goes up, same-name people are joined, routes follow', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await A.init();
  await A.connect(); // A was empty: the file has A's 10 people only
  await B.init();
  const keiriB = (await B.data()).people.find((p) => p.name === '経理部');
  await withTask(B, 'iPhoneの依頼', { steps: [{ kind: 'request', whoId: keiriB.id, note: '' }] });
  let asked = 0;
  const r = await B.connect({ receive: async () => { asked += 1; return true; } });
  assert.equal(r.how, 'sent');
  assert.equal(asked, 0);
  const keiriA = (await A.data()).people.find((p) => p.name === '経理部');
  const bd = await B.data();
  assert.equal(bd.people.length, 10);
  assert.equal(bd.people.find((p) => p.name === '経理部').id, keiriA.id);
  assert.equal(bd.tasks[0].route[0].whoId, keiriA.id);
  await A.sync();
  const ad = await A.data();
  assert.equal(ad.people.length, 10); // no second "経理部"
  assert.equal(ad.tasks[0].title, 'iPhoneの依頼');
  assert.equal(ad.tasks[0].route[0].whoId, keiriA.id);
  assert.deepEqual(await A.items(), await B.items());
});

test('two sync files, a file in the trash, or a file that was there before and is gone: stop, never make one silently', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  await A.init();
  await A.connect();
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await B.init();
  // a second file (made elsewhere)
  await sheets.client('other').createFile();
  assert.deepEqual(await B.connect(), { status: 'error', error: 'two-files' });
  sheets.files[1].deleted = true;
  // the file is in the trash: nothing is made unless the person says so (asked with the trash in mind)
  sheets.trash(sheets.files[0].id);
  const asked = [];
  assert.deepEqual(await B.connect({ create: async (o) => { asked.push(o); return false; } }), { status: 'cancelled' });
  assert.deepEqual(asked, [{ trashed: true }]);
  // A was connected and syncing: the file in the trash stops it (the file itself is looked at every 30 minutes)
  clock.tick(31 * 60 * 1000);
  const r = await A.sync();
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'file-trashed');
  // the file is gone completely: A (connected before) does not make a new one
  sheets.files[0].deleted = true;
  await A.engine.pause();
  const C = await makeDevice(sheets, 'iPad', { clock });
  await C.init();
  await C.storage.saveSync({ config: { status: 'off', fileId: 'file-1', deviceId: 'cccc000000000000', deviceName: 'iPad', myTab: '記録_iPad_cccc' } }, []);
  assert.deepEqual(await C.connect(), { status: 'error', error: 'file-missing' });
  assert.equal(sheets.calls('iPhone', 'createFile') + sheets.calls('iPad', 'createFile'), 0);
  assert.equal(sheets.calls(null, 'createFile'), 2); // A's first one and the "elsewhere" one above
  const s = await A.engine.status();
  assert.equal(s.status, 'paused');
});

test('the file went to the trash: the device with the data makes a new one (asked), the other one receives it after taking itself off', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const { A, B } = await connectedPair(sheets, { clock });
  await A.edit((d) => { d.tasks.push(newTask({ title: 'Mac のタスク' }, clock.now(), 0)); });
  await A.sync();
  await B.sync();
  sheets.trash(sheets.files[0].id);
  clock.tick(31 * 60 * 1000);
  const r = await A.sync();
  assert.equal(r.error, 'file-trashed'); // stops; makes nothing by itself
  assert.equal(sheets.files.length, 1);
  // the person chooses to make a new one on the Mac: 外す -> つなぐ -> "作り直しますか？" -> 作り直す
  await A.engine.detach();
  const asked = [];
  const ra = await A.connect({ create: async (o) => { asked.push(o); return true; }, receive: async () => true });
  assert.deepEqual(asked, [{ trashed: true }]);
  assert.equal(ra.how, 'created');
  assert.equal(sheets.files.length, 2);
  // the iPhone (still tied to the old file) stops, takes itself off and connects: it receives the new file
  clock.tick(31 * 60 * 1000);
  assert.equal((await B.sync()).error, 'file-trashed');
  await B.engine.detach();
  const rb = await B.connect({ create: async () => { throw new Error('must not be asked'); }, receive: async () => true });
  assert.equal(rb.how, 'received');
  assert.ok((await B.data()).tasks.some((t) => t.title === 'Mac のタスク'));
  assert.equal(sheets.files.filter((f) => !f.trashed).length, 1);
});

test('an empty device that connects again keeps the copy of its earlier connection (an empty copy never replaces it)', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  await A.init();
  await A.edit((d) => { d.tasks.push(newTask({ title: '同期データ側' }, clock.now(), 0)); });
  await A.connect();
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await B.init();
  await B.edit((d) => { d.tasks.push(newTask({ title: 'iPhone にだけあった' }, clock.now(), 0)); });
  assert.equal((await B.connect()).how, 'received');
  const copy = (await ST.listBackups(B.db)).find((b) => b.kind === 'presync');
  assert.ok(copy.data.tasks.some((t) => t.title === 'iPhone にだけあった'));
  // taken off, emptied, connected again: received without a question, and the copy is still the one with the task
  await B.engine.detach();
  await B.edit((d) => { const fresh = ST.newState(clock.today(), clock.now()); for (const k of ST.KEYS) d[k] = fresh[k]; });
  let asked = 0;
  assert.equal((await B.connect({ receive: async () => { asked += 1; return true; } })).how, 'received');
  assert.equal(asked, 0);
  const after = (await ST.listBackups(B.db)).find((b) => b.kind === 'presync');
  assert.ok(after.data.tasks.some((t) => t.title === 'iPhone にだけあった'));
});

test('two devices that each made a file at the same moment: both stop ("2つある") when the files are looked at; a removed file stops too', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  const B = await makeDevice(sheets, 'iPhone', { clock });
  await A.init();
  await B.init();
  // both asked "作りますか？" before either file existed
  const gate = [];
  const both = Promise.all([
    A.connect({ create: () => new Promise((r) => gate.push(r)) }),
    B.connect({ create: () => new Promise((r) => gate.push(r)) }),
  ]);
  while (gate.length < 2) await new Promise((r) => setTimeout(r, 1));
  gate.forEach((r) => r(true));
  const [ra, rb] = await both;
  assert.equal(ra.how, 'created');
  assert.equal(rb.how, 'created');
  assert.equal(sheets.files.length, 2);
  clock.tick(31 * 60 * 1000);
  const sa = await A.sync();
  const sb = await B.sync();
  assert.deepEqual([sa.status, sa.error, sb.status, sb.error], ['error', 'two-files', 'error', 'two-files']);
  // the person removes B's file completely: B stops ("見つかりません"), A goes on with its file
  sheets.files[1].deleted = true;
  clock.tick(31 * 60 * 1000);
  assert.equal((await A.sync()).status, 'synced');
  const s2 = await B.sync();
  assert.equal(s2.status, 'error');
  assert.ok(['file-missing', 'not-found'].includes(s2.error));
  assert.equal(sheets.calls(null, 'createFile'), 2);
});
