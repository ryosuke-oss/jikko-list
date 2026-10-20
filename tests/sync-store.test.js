// The database: version 3 adds the two sync stores and keeps everything that was there (phase 1 and 3-1 data),
// and the data and the sync records are written in one transaction (all or nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from './helpers/fake-idb.js';
import * as ST from '../public/js/store.js';
import { newTask, completeTask, addStep, setStepState, collectStepXp, trashTask, purgeTask } from '../public/js/tasks.js';
import { settle } from '../public/js/dragon.js';

const AT = '2026-10-19T09:00:00.000Z';
const TODAY = '2026-10-19';

/** Open a database the way an older version of the app did (only `state` and `backups`). */
function openOld(factory, version) {
  return new Promise((resolve, reject) => {
    const req = factory.open(ST.DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(db, store, entries) {
  return new Promise((resolve, reject) => {
    const t = db.transaction([store], 'readwrite');
    const st = t.objectStore(store);
    for (const [k, v] of entries) (k === null ? st.put(v) : st.put(v, k));
    t.oncomplete = resolve;
    t.onabort = () => reject(t.error);
  });
}

/** What version 1.2 (phase 1) kept: steps counted (stepXpCount), no marks, settings without xpModel. */
function phase1Data() {
  const s = ST.newState(TODAY, AT);
  const t1 = newTask({ title: '一つ目', rank: 'B', due: '2026-10-23' }, AT, 0);
  const st = addStep(t1, 'request', s.people[2].id, '');
  setStepState(t1, st.id, 'done', TODAY);
  collectStepXp(t1);
  const t2 = newTask({ title: '二つ目', rank: 'A' }, AT, 1);
  completeTask(t2, TODAY, AT);
  const t3 = newTask({ title: 'ゴミ箱の' }, AT, 2);
  trashTask(t3, AT);
  s.tasks.push(t1, t2, t3);
  settle(s.dragon, s.tasks, '追加', AT);
  s.memos.push({ id: 'm1', text: 'メモ', createdAt: AT, taskId: null, deletedAt: null });
  s.goals.week.lines = ['週の目標'];
  s.schedule.lines = [{ id: 'l1', text: '9:00 朝礼' }];
  s.goalLog.push({ kind: 'week', key: '2026-10-12', lines: ['先週'], closedAt: AT });
  const raw = JSON.parse(JSON.stringify(s));
  for (const t of raw.tasks) { delete t.xpSteps; delete t.xpStepsLegacy; delete t.purgedAt; }
  delete raw.settings.xpModel;
  return raw;
}

/** What version 1.3 (3-1) keeps: step ids, marks of completely deleted tasks and memos. */
function v13Data() {
  const s = ST.newState(TODAY, AT);
  const t1 = newTask({ title: '残る' }, AT, 0);
  const t2 = newTask({ title: '完全に消す' }, AT, 1);
  completeTask(t2, TODAY, AT);
  trashTask(t2, AT);
  purgeTask(t2, AT);
  s.tasks.push(t1, t2);
  s.memos.push({ id: 'm1', text: '（消したメモ）', createdAt: AT, taskId: null, deletedAt: AT, purgedAt: AT });
  settle(s.dragon, s.tasks, null, AT);
  return JSON.parse(JSON.stringify(s));
}

async function fill(db, data, rev, backups) {
  await put(db, 'state', [...Object.entries(data), ['rev', rev]]);
  await put(db, 'backups', backups.map((b) => [null, b]));
}

for (const [label, version, make] of [['phase 1 (version 1)', 1, phase1Data], ['3-1 (version 2)', 2, v13Data]]) {
  test('a device with ' + label + ' data: raising the database to version 3 keeps every byte of state and backups', async () => {
    const factory = createFakeIndexedDB();
    const old = await openOld(factory, version);
    const data = make();
    const backup = { id: 'auto-' + TODAY, kind: 'auto', date: TODAY, at: AT, counts: { tasks: 1 }, data: structuredClone(data) };
    await fill(old, data, 7, [backup, { id: 'pre-import', kind: 'pre', date: TODAY, at: AT, counts: {}, data: structuredClone(data) }]);
    old.close();
    const before = factory.dump(ST.DB_NAME);
    assert.equal(before.version, version);
    const db = await ST.openDb(factory);
    const after = factory.dump(ST.DB_NAME);
    assert.equal(after.version, 3);
    assert.equal(ST.DB_VERSION, 3);
    assert.deepEqual(after.stores.state, before.stores.state);
    assert.deepEqual(after.stores.backups, before.stores.backups);
    assert.deepEqual(after.stores.sync, {});
    assert.deepEqual(after.stores.revs, {});
    // the app reads it as before
    const loaded = await ST.loadState(db);
    assert.equal(loaded.rev, 7);
    const clean = ST.cleanState(loaded.data);
    assert.equal(clean.tasks.length, data.tasks.length);
    assert.equal(ST.countsOf(clean).trash, data.tasks.filter((t) => t.deletedAt && !t.purgedAt).length);
    assert.deepEqual(await ST.listBackups(db), Object.values(before.stores.backups));
    // and the sync stores work
    assert.deepEqual(await ST.loadSync(db), { config: undefined, progress: undefined, applied: undefined });
  });
}

test('a tab still open on the old version is asked to let go (and the app\'s handler closes it)', async () => {
  const factory = createFakeIndexedDB();
  const old = await openOld(factory, 2);
  let told = 0;
  old.onversionchange = () => { told += 1; old.close(); };
  const db = await ST.openDb(factory);
  assert.equal(told, 1);
  assert.equal(db.version, 3);
  // nothing older can open it any more
  await assert.rejects(openOld(factory, 2));
});

test('data and sync records go in one transaction: written together, or (another tab first / disk full) not at all', async () => {
  const factory = createFakeIndexedDB();
  const db = await ST.openDb(factory);
  const s = ST.newState(TODAY, AT);
  const rev1 = await ST.saveKeys(db, s, ST.KEYS, 0);
  const t = newTask({ title: '同期で入った' }, AT, 0);
  const s2 = structuredClone(s);
  s2.tasks.push(t);
  const parts = { progress: { tabs: {}, pending: [] }, applied: { ['task:' + t.id]: ['1-0000000000000000', 'h'] } };
  const revs = [{ key: 'task:' + t.id, v: { '1-0000000000000000': { p: [], c: t } } }];
  // another tab saved first: nothing is written
  await assert.rejects(ST.commitSync(db, s2, ST.KEYS, rev1 - 1, parts, revs), ST.ConflictError);
  assert.equal((await ST.loadState(db)).data.tasks.length, 0);
  assert.equal((await ST.loadSync(db)).applied, undefined);
  assert.equal((await ST.getRevs(db, ['task:' + t.id])).size, 0);
  // the disk is full in the middle: nothing is written
  factory.failPuts(ST.DB_NAME, 1, 'revs');
  await assert.rejects(ST.commitSync(db, s2, ST.KEYS, rev1, parts, revs));
  assert.equal((await ST.loadState(db)).rev, rev1);
  assert.equal((await ST.loadState(db)).data.tasks.length, 0);
  assert.equal((await ST.loadSync(db)).applied, undefined);
  // normally: everything together
  const rev2 = await ST.commitSync(db, s2, ST.KEYS, rev1, parts, revs);
  assert.equal(rev2, rev1 + 1);
  assert.equal((await ST.loadState(db)).data.tasks.length, 1);
  assert.deepEqual((await ST.loadSync(db)).applied, parts.applied);
  assert.equal((await ST.getRevs(db, ['task:' + t.id])).get('task:' + t.id).v['1-0000000000000000'].c.title, '同期で入った');
  // the app's own saves never touch the sync records
  await ST.saveKeys(db, s2, ['tasks'], rev2);
  assert.deepEqual((await ST.loadSync(db)).applied, parts.applied);
  // the copy before receiving has a slot of its own
  await ST.savePreImport(db, s, AT);
  await ST.savePreSync(db, s2, AT);
  const kinds = (await ST.listBackups(db)).map((b) => b.id + ':' + b.kind).sort();
  assert.deepEqual(kinds, ['pre-import:pre', 'pre-sync:presync']);
});
