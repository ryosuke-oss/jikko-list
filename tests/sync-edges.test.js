// The holes found by the review of 3-2 (and the ones found while fixing them), each kept closed by a test:
//  - an edit made while an item is a question ("どちらを残す？") is never lost and never sends the content shown meanwhile
//  - answering never touches other items, and an edit not sent yet is kept before answering
//  - what the last read of a run brings in is not left behind
//  - the date "today" is the device's own; a tab name already taken by another device is not shared;
//    the file search lagging right after the file was made is not "the file is gone"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { makeDevice, makeClock, connectedPair } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { newTask } from '../public/js/tasks.js';
import { defaultClock, buildRow } from '../public/js/sync/engine.js';
import { versionName } from '../public/js/sync/rev.js';
import { todayStr } from '../public/js/util.js';

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

const task = async (dev, id) => (await dev.data()).tasks.find((t) => t.id === id);
const inSheet = (sheets, text) => Object.values(sheets.snapshot()).flat().some((row) => (row[9] || '').includes(text));

async function conflictPair() {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const t = await add(A, '元の名前');
  await A.sync();
  await B.sync();
  await A.sync();
  await change(A, t.id, (x) => { x.title = 'PCの名前'; });
  clock.tick(1000);
  await change(B, t.id, (x) => { x.title = 'iPhoneの名前'; });
  await B.sync();
  return { sheets, A, B, clock, t };
}

test('a memo saved while the run that finds the question is running is kept, sent, and survives either answer', async () => {
  for (const pickMac of [true, false]) {
    const { sheets, A, B, t } = await conflictPair();
    const realRead = A.google.readTabs;
    let once = true;
    A.google.readTabs = async (...args) => {
      if (once) {
        once = false;
        await change(A, t.id, (x) => { x.memo = '会議中に追記したメモ'; });
      }
      return realRead(...args);
    };
    await A.sync(); // finds the question; the memo was saved meanwhile, so it is not overwritten now
    A.google.readTabs = realRead;
    assert.equal((await task(A, t.id)).memo, '会議中に追記したメモ');
    await A.sync(); // the memo becomes a version of the Mac's own (with the Mac's name), the question stays
    assert.equal((await task(A, t.id)).memo, '会議中に追記したメモ');
    assert.ok(inSheet(sheets, '会議中に追記したメモ'));
    await B.sync();
    await A.sync();
    const q = (await A.engine.questions())[0];
    assert.ok(q, 'still asked');
    const mac = q.a.device === 'Mac' ? 'a' : 'b';
    const side = pickMac ? mac : (mac === 'a' ? 'b' : 'a');
    assert.equal((await A.engine.choose(q.key, side)).ok, true);
    await A.sync();
    await B.sync();
    for (const dev of [A, B]) {
      const x = await task(dev, t.id);
      assert.equal(x.memo, '会議中に追記したメモ', dev.name + ' memo');
      assert.equal(x.title, pickMac ? 'PCの名前' : 'iPhoneの名前');
    }
  }
});

test('the detail was open when the question arrived: what was typed and saved afterwards is kept', async () => {
  const { sheets, A, B, t } = await conflictPair();
  A.editing.add('task:' + t.id); // the detail sheet is open
  await A.sync(); // the question is found, the content for the time being is not put in while editing
  assert.equal((await task(A, t.id)).title, 'PCの名前');
  await change(A, t.id, (x) => { x.nextAction = '詳細で書いた次の一手'; }); // saved when the sheet closes
  A.editing.clear();
  await A.sync();
  await B.sync();
  await A.sync();
  assert.equal((await task(A, t.id)).nextAction, '詳細で書いた次の一手');
  assert.ok(inSheet(sheets, '詳細で書いた次の一手'));
  const q = (await A.engine.questions())[0];
  assert.ok(q);
  await A.engine.choose(q.key, 'a');
  await A.sync();
  await B.sync();
  assert.equal((await task(B, t.id)).nextAction, '詳細で書いた次の一手');
  assert.deepEqual(await A.items(), await B.items());
});

test('the content shown for the time being is never sent as this device\'s, even when something is changed on top of it', async () => {
  const { sheets, A, B, t } = await conflictPair();
  await A.sync();
  assert.equal((await task(A, t.id)).title, 'iPhoneの名前'); // the newer one, for the time being
  await change(A, t.id, (x) => { x.star = true; });
  await A.sync();
  const macRows = sheets.snapshot()[(await A.syncRecords()).config.myTab].slice(1).filter((r) => r[6] === 'task:' + t.id);
  for (const r of macRows) assert.notEqual(JSON.parse(r[9]).title, 'iPhoneの名前', 'the Mac never sends the iPhone name as its own');
  assert.equal(JSON.parse(macRows[macRows.length - 1][9]).star, true);
  await B.sync();
  assert.equal((await B.engine.questions()).length, 1); // still a question on the other device
  assert.equal((await task(B, t.id)).star, true); // the change on top travelled
});

test('answering keeps an edit that is not sent yet (asked again with it) and never touches other items', async () => {
  const { sheets, A, B, t } = await conflictPair();
  await A.edit((d) => { d.goals.week.lines = ['週の目標']; d.schedule.lines = [{ id: 's1', text: '9:00 朝礼' }]; });
  await A.sync();
  await B.sync();
  await A.sync();
  const rowsBefore = Object.values(sheets.snapshot()).reduce((n, r) => n + r.length, 0);
  await change(A, t.id, (x) => { x.memo = '答える直前に書いた'; });
  const q = (await A.engine.questions())[0];
  const r = await A.engine.choose(q.key, 'a');
  assert.deepEqual(r, { ok: false, reason: 'changed' }); // asked again, with the memo
  assert.equal((await task(A, t.id)).memo, '答える直前に書いた');
  await A.sync();
  assert.ok(inSheet(sheets, '答える直前に書いた'));
  const q2 = (await A.engine.questions())[0];
  const r2 = await A.engine.choose(q2.key, 'a');
  assert.equal(r2.ok, true);
  assert.equal((await task(A, t.id)).memo, '答える直前に書いた');
  // nothing else was made into a version by the answers (no empty goals or schedule)
  const goalRows = Object.values(sheets.snapshot()).flat().filter((row) => (row[6] || '').startsWith('goal:') || (row[6] || '').startsWith('schedule:'));
  assert.ok(goalRows.every((row) => JSON.parse(row[9]).lines.length > 0), 'no empty goal / schedule rows');
  await A.sync();
  await B.sync();
  assert.deepEqual((await B.data()).goals.week.lines, ['週の目標']);
  assert.equal((await B.data()).schedule.lines.length, 1);
  assert.ok(Object.values(sheets.snapshot()).reduce((n, rr) => n + rr.length, 0) > rowsBefore);
});

test('rows that arrive in the last read of a run are not left behind (put on the screen in that run)', async () => {
  const sheets = new FakeSheets();
  const { A, B, clock } = await connectedPair(sheets);
  const t = await add(A, 'K');
  await A.sync();
  await B.sync();
  await A.sync();
  await B.sync();
  const key = 'task:' + t.id;
  const recB = await B.syncRecords();
  let parent = recB.applied[key][0];
  let content = (await ST.getRevs(B.db, [key])).get(key).v[parent].c;
  // A changes the due date (so every round of its run sends and reads again) ...
  await change(A, t.id, (x) => { x.due = '2026-10-30'; });
  // ... while B (which has not seen A's rows) writes one change at each of A's reads after the first
  const realRead = A.google.readTabs;
  let calls = 0;
  const fields = ['memo', 'nextAction', 'title'];
  A.google.readTabs = async (...args) => {
    calls += 1;
    if (calls >= 2 && calls <= 4) {
      clock.tick(1000);
      const c = structuredClone(content);
      c[fields[calls - 2]] = 'B-' + fields[calls - 2];
      c.updatedAt = clock.now();
      const name = await versionName(key, [parent], c);
      sheets.appendRaw(recB.config.myTab, buildRow(key, name, { p: [parent], c, t: clock.now(), o: 'edit' }, 'iPhone'));
      parent = name;
      content = c;
    }
    return realRead(...args);
  };
  const r = await A.sync();
  A.google.readTabs = realRead;
  assert.equal(r.status, 'synced');
  assert.equal(calls, 4); // the run went round three times and read B's last change in its last read
  const x = await task(A, t.id);
  assert.deepEqual([x.memo, x.nextAction, x.title, x.due], ['B-memo', 'B-nextAction', 'B-title', '2026-10-30']);
  const rec = await A.syncRecords();
  const doc = (await ST.getRevs(A.db, [key])).get(key);
  const tipsNow = Object.keys(doc.v).filter((n) => !Object.values(doc.v).some((v) => v.p.includes(n)));
  assert.deepEqual(tipsNow, [rec.applied[key][0]]); // what A shows is the one current version
  await A.sync();
  await B.sync();
  assert.deepEqual(await A.items(), await B.items());
});

test('"today" is the date of the device (not UTC) when no clock is given', () => {
  assert.equal(defaultClock().today(), todayStr());
});

test('a device whose tab name (device name + first 4 characters) is already used by another device takes a longer one', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  await A.init();
  await A.storage.saveSync({ config: { status: 'off', deviceId: 'abcd111111111111', deviceName: 'Mac' } }, []);
  await A.connect();
  const B = await makeDevice(sheets, 'Mac', { clock });
  await B.init();
  await B.storage.saveSync({ config: { status: 'off', deviceId: 'abcd222222222222', deviceName: 'Mac' } }, []);
  const r = await B.connect();
  assert.equal(r.status, 'connected');
  const tabs = Object.keys(sheets.snapshot()).filter((x) => x.startsWith('記録_'));
  assert.deepEqual(tabs.sort(), ['記録_Mac_abcd', '記録_Mac_abcd22']);
  assert.equal((await B.syncRecords()).config.myTab, '記録_Mac_abcd22');
  await add(B, '二台目の Mac');
  await B.sync();
  assert.equal(sheets.snapshot()['記録_Mac_abcd'].filter((row) => (row[9] || '').includes('二台目の Mac')).length, 0);
  await A.sync();
  assert.ok((await A.data()).tasks.some((x) => x.title === '二台目の Mac'));
});

test('right after the file was made the search may not list it yet: that is not "the file is gone"', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, 'Mac', { clock });
  await A.init();
  const real = A.google.createFile;
  A.google.createFile = async () => {
    const f = await real();
    sheets.hidden.add(f.id);
    return f;
  };
  const r = await A.connect();
  assert.equal(r.status, 'connected');
  assert.equal(r.sync.status, 'synced');
  clock.tick(31 * 60 * 1000);
  await add(A, '作った直後');
  assert.equal((await A.sync()).status, 'synced'); // the search still lags; the file is read normally
  sheets.hidden.clear();
  clock.tick(31 * 60 * 1000);
  assert.equal((await A.sync()).status, 'synced');
  assert.equal(sheets.files.length, 1);
});

test('paused in the middle of a run (the person pressed 一時停止): no call to Google after the one under way', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  await add(A, '止める直前に足した');
  // the person pauses while the rows are being added: the read that checks them is not made
  const realAppend = A.google.appendRows;
  let pausedOnce = false;
  let readsAtPause = null;
  A.google.appendRows = async (...args) => {
    const out = await realAppend(...args);
    if (!pausedOnce) { pausedOnce = true; readsAtPause = sheets.calls('Mac', 'readTabs'); await A.engine.pause(); }
    return out;
  };
  const appends = sheets.calls('Mac', 'appendRows');
  const r = await A.sync();
  assert.equal(r.status, 'paused');
  assert.equal(sheets.calls('Mac', 'appendRows') - appends, 1);
  assert.equal(sheets.calls('Mac', 'readTabs'), readsAtPause); // the read that checks the rows is not made
  // paused before anything is read: no call at all
  const before = sheets.log.length;
  assert.equal((await A.sync()).status, 'paused');
  assert.equal(sheets.log.length, before);
  // 再開: the rows already added are found (not sent twice) and the other device gets the task
  await A.engine.resume();
  assert.equal((await A.sync()).status, 'synced');
  await B.sync();
  assert.ok((await B.data()).tasks.some((t) => t.title === '止める直前に足した'));
  const myTab = (await A.syncRecords()).config.myTab;
  assert.equal(sheets.files[0].tabs.get(myTab).filter((row) => (row[3] || '') === '止める直前に足した').length, 1);
});

test('connecting: a write refused once (the person saved meanwhile) keeps the versions made while connecting', async () => {
  const sheets = new FakeSheets();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const { A, B } = await connectedPair(sheets, { clock });
  const id = await A.edit((d) => { const t = newTask({ title: '2台で別の所' }, clock.now(), 0); d.tasks.push(t); return t.id; });
  await A.sync();
  await B.sync();
  // different places on both; the iPhone's rows that put them together are not in the file (as if not sent yet)
  await A.edit((d) => { const t = d.tasks.find((x) => x.id === id); t.memo = 'Macのメモ'; t.updatedAt = clock.now(); });
  clock.tick(1000);
  await B.edit((d) => { const t = d.tasks.find((x) => x.id === id); t.due = '2026-10-30'; t.updatedAt = clock.now(); });
  await A.sync();
  await B.sync();
  const bTab = (await B.syncRecords()).config.myTab;
  const rows = sheets.files[0].tabs.get(bTab);
  const merged = rows.filter((row) => row[6] === 'task:' + id).slice(-1)[0];
  rows.splice(rows.indexOf(merged), 1); // the version that put them together is not in the file
  // a third device connects; its first write is refused once
  const C = await makeDevice(sheets, 'iPad', { clock });
  await C.init();
  let refuse = 1;
  C.engine = C.newEngine({
    hooks: {
      isEditing: () => false,
      commit: (data, rev, write) => (refuse-- > 0 ? Promise.reject(new ST.ConflictError('the app saved first')) : write()),
    },
  });
  assert.equal((await C.connect()).how, 'received');
  const sy = await C.syncRecords();
  const [tip] = sy.applied['task:' + id];
  const docs = await ST.getRevs(C.db, ['task:' + id]);
  assert.ok(docs.get('task:' + id).v[tip], 'the version on the screen is in the records');
  const t = (await C.data()).tasks.find((x) => x.id === id);
  assert.deepEqual([t.memo, t.due], ['Macのメモ', '2026-10-30']);
});
