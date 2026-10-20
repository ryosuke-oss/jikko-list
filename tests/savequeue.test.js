// The app's line of writes (savequeue.js) with the real sync engine: what the person does at the moment the sync
// writes what another device changed is never lost, and the other device's change is never put back.
// The app is modelled the way app.js uses the line: S (data, rev, queue, waiting), save(keys), the sync's commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheets } from './helpers/fake-google.js';
import { connectedPair } from './helpers/device.js';
import * as ST from '../public/js/store.js';
import { queueSave, queueCommit, queueRun } from '../public/js/savequeue.js';
import { newTask } from '../public/js/tasks.js';

/** The app around device A: its data in memory, saves in the line, and the sync's writes in the same line. */
async function appOf(dev) {
  const l = await dev.load();
  const S = { data: l.data, rev: l.rev, queue: Promise.resolve(), waiting: 0 };
  const events = [];
  const app = { S, events, onQueued: null, onWriting: null };
  app.save = (keys) => queueSave(S, keys, {
    write: (data, k, rev) => ST.saveKeys(dev.db, data, k, rev),
    saved: () => {},
    stale: () => events.push('stale'),
    conflict: async () => {
      events.push('conflict');
      const r = await dev.load();
      S.data = r.data;
      S.rev = r.rev;
    },
    failed: (e) => { throw e; },
  });
  app.engine = dev.newEngine({
    hooks: {
      isEditing: () => false,
      commit: (data, rev, write) => {
        const slow = async () => {
          if (app.onWriting) { const f = app.onWriting; app.onWriting = null; await f(); }
          return write();
        };
        const p = queueCommit(S, data, rev, slow, { typing: () => false, flushTyping: () => {}, after: () => events.push('adopted') });
        if (app.onQueued) { const f = app.onQueued; app.onQueued = null; f(); }
        return p;
      },
    },
  });
  /** A task added the way the app adds one: into the data in memory, then a save in the line. */
  app.addTask = (title) => {
    S.data.tasks.push(newTask({ title }, new Date().toISOString(), 0));
    return app.save(['tasks']);
  };
  return app;
}

const titles = (d) => d.tasks.filter((t) => !t.deletedAt).map((t) => t.title).sort();

async function sharedTask(A, B, title) {
  await A.edit((d) => { d.tasks.push(newTask({ title }, A.clock.now(), 0)); });
  await A.sync();
  await B.sync();
  return (await B.data()).tasks.find((t) => t.title === title).id;
}

test('a task added while the sync\'s write waits in the line: the write lets it go first, nothing is lost or put back', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const id = await sharedTask(A, B, '共通のタスク');
  await B.edit((d) => { d.tasks.find((t) => t.id === id).title = 'iPhoneで直した'; });
  await B.sync();
  const app = await appOf(A);
  // the line is busy (e.g. a save of a moment ago) when the sync comes to write
  let open;
  app.S.queue = app.S.queue.then(() => new Promise((r) => { open = r; }));
  app.onQueued = () => { app.addTask('PCで足した'); open(); };
  let r = await app.engine.sync();
  await app.S.queue;
  if (r.status === 'retry') r = await app.engine.sync(); // gave way three times: the next run puts it on the screen
  await app.S.queue;
  assert.equal(r.status, 'synced');
  assert.deepEqual(app.events.filter((e) => e === 'stale' || e === 'conflict'), []);
  const stored = await A.data();
  assert.deepEqual(titles(stored), ['PCで足した', 'iPhoneで直した']);
  assert.deepEqual(titles(app.S.data), titles(stored)); // the screen and the database agree
  // the next run sends the task; the iPhone's change stays everywhere
  await app.engine.sync();
  await B.sync();
  assert.deepEqual(titles(await B.data()), ['PCで足した', 'iPhoneで直した']);
  assert.deepEqual(titles(await A.data()), ['PCで足した', 'iPhoneで直した']);
});

test('a task added while the sync\'s write is being done: it lands in the new data and is saved right after', async () => {
  const sheets = new FakeSheets();
  const { A, B } = await connectedPair(sheets);
  const id = await sharedTask(A, B, '共通のタスク');
  await B.edit((d) => { d.tasks.find((t) => t.id === id).title = 'iPhoneで直した'; });
  await B.sync();
  const app = await appOf(A);
  let saved = null;
  app.onWriting = async () => { saved = app.addTask('書いている間に足した'); };
  const r = await app.engine.sync();
  assert.equal(r.status, 'synced');
  assert.equal(await saved, true);
  await app.S.queue;
  assert.deepEqual(app.events.filter((e) => e === 'stale' || e === 'conflict'), []);
  const stored = await A.data();
  assert.deepEqual(titles(stored), ['iPhoneで直した', '書いている間に足した']);
  assert.deepEqual(titles(app.S.data), titles(stored));
  await app.engine.sync();
  await B.sync();
  assert.deepEqual(titles(await B.data()), ['iPhoneで直した', '書いている間に足した']);
});

test('the sync\'s write is refused when the data on the screen is not the one it started from; a failed write leaves the data as it was', async () => {
  const S = { data: { v: 1 }, rev: 5, queue: Promise.resolve(), waiting: 0 };
  const hooks = { typing: () => false, flushTyping: () => {}, after: () => {} };
  await assert.rejects(queueCommit(S, { v: 2 }, 4, async () => 6, hooks), ST.ConflictError);
  assert.deepEqual(S.data, { v: 1 });
  await assert.rejects(queueCommit(S, { v: 2 }, 5, async () => 6, Object.assign({}, hooks, { typing: () => true })), ST.ConflictError);
  const before = S.data;
  await assert.rejects(queueCommit(S, { v: 2 }, 5, async () => { throw new Error('disk full'); }, hooks), /disk full/);
  assert.equal(S.data, before);
  assert.equal(S.rev, 5);
  assert.equal(await queueCommit(S, { v: 3 }, 5, async () => 6, hooks), 6);
  assert.deepEqual([S.data, S.rev], [{ v: 3 }, 6]);
});

test('a step of the line that fails never stops the saves after it', async () => {
  const S = { data: { v: 1 }, rev: 1, queue: Promise.resolve(), waiting: 0 };
  const written = [];
  const io = { write: async (d) => { written.push(d.v); return S.rev + 1; }, saved: () => {}, stale: () => {}, conflict: async () => { throw new Error('reading again failed'); }, failed: () => {} };
  await assert.rejects(queueRun(S, async () => { throw new Error('a reading of another tab failed'); }), /failed/);
  S.data.v = 2;
  assert.equal(await queueSave(S, ['tasks'], io), true);
  // a save whose conflict handling fails too: the line still goes on
  const bad = Object.assign({}, io, { write: async () => { throw new ST.ConflictError('x'); } });
  assert.equal(await queueSave(S, ['tasks'], bad), false);
  S.data.v = 3;
  assert.equal(await queueSave(S, ['tasks'], io), true);
  assert.deepEqual(written, [2, 3]);
  assert.equal(S.waiting, 0);
  assert.equal(await S.queue, true);
});

test('the sync\'s write fails while the person did something during it: the data before it comes back, and the person is told to do it again', async () => {
  const S = { data: { tasks: ['前から'] }, rev: 5, queue: Promise.resolve(), waiting: 0 };
  const hooks = { typing: () => false, flushTyping: () => {}, after: () => {} };
  const written = [];
  const io = { write: async (d) => { written.push(d.tasks.slice()); return S.rev + 1; }, saved: () => {}, stale: () => written.push('stale'), conflict: async () => {}, failed: () => {} };
  const synced = { tasks: ['前から', '相手から'] };
  let mine = null;
  const p = queueCommit(S, synced, 5, async () => {
    S.data.tasks.push('書いている間に足した'); // the person, during the write: into the new data
    mine = queueSave(S, ['tasks'], io);
    throw new Error('disk full');
  }, hooks);
  await assert.rejects(p, /disk full/);
  // the new data may hold a question's content for the time being: never saved without the sync's records
  assert.equal(await mine, false);
  assert.deepEqual(written, ['stale']);
  assert.deepEqual(S.data, { tasks: ['前から'] });
});
