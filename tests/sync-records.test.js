// The app's data <-> items (task:..., memo:..., goal:week:..., schedule:..., dragon:name), the "empty" device,
// receiving, "overwrite and add" while syncing, and the date checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../public/js/sync/records.js';
import { newState, countsOf } from '../public/js/store.js';
import { newTask, purgeTask, newPerson, newStep } from '../public/js/tasks.js';
import { rolloverGoals, rolloverSchedule } from '../public/js/plan.js';
import { canonical } from '../public/js/sync/rev.js';

const AT = '2026-10-20T01:00:00.000Z';
const TODAY = '2026-10-20'; // Tuesday; the week starts on 2026-10-19

function sample() {
  const s = newState(TODAY, AT);
  const t = newTask({ title: '研修資料の改訂', rank: 'B' }, AT, 0);
  s.tasks.push(t);
  s.memos.push({ id: 'm1', text: 'メモ', createdAt: AT, taskId: null, deletedAt: null, purgedAt: null });
  s.goals.week.lines = ['週の目標', '  ', '二つ目 '];
  s.goals.month.lines = ['月の目標'];
  s.goalLog.push({ kind: 'week', key: '2026-10-12', lines: ['先週'], closedAt: '2026-10-19T00:00:00.000Z' });
  s.schedule.lines = [{ id: 'l1', text: '9:00 朝礼' }];
  s.scheduleLog.push({ date: '2026-10-19', lines: [{ id: 'l0', text: '昨日の予定' }] });
  s.dragon.name = 'ソラ';
  return s;
}

test('every item of the data has a key; periods and days keep their key when they move to the history', () => {
  const s = sample();
  const items = R.itemsOf(s);
  const keys = [...items.keys()];
  assert.ok(keys.includes('task:' + s.tasks[0].id));
  assert.ok(keys.includes('memo:m1'));
  assert.equal(keys.filter((k) => k.startsWith('person:')).length, 10);
  assert.deepEqual(items.get('goal:week:2026-10-19'), { lines: ['週の目標', '二つ目'] }); // empty lines left out
  assert.deepEqual(items.get('goal:month:2026-10'), { lines: ['月の目標'] });
  assert.deepEqual(items.get('goal:year:2026'), { lines: [] });
  assert.deepEqual(items.get('goal:week:2026-10-12'), { lines: ['先週'] }); // closedAt is not in the content
  assert.deepEqual(items.get('schedule:2026-10-20'), { lines: [{ id: 'l1', text: '9:00 朝礼' }] });
  assert.deepEqual(items.get('schedule:2026-10-19'), { lines: [{ id: 'l0', text: '昨日の予定' }] });
  assert.deepEqual(items.get('dragon:name'), { name: 'ソラ' });
  // the week ends and the day changes: the same keys, the same contents (nothing new to send)
  const before = canonical(Object.fromEntries(items));
  rolloverGoals(s.goals, s.goalLog, '2026-10-26', '2026-10-26T00:00:00.000Z');
  rolloverSchedule(s, '2026-10-26');
  const after = R.itemsOf(s);
  for (const k of ['goal:week:2026-10-19', 'goal:month:2026-10', 'schedule:2026-10-20']) assert.equal(canonical(after.get(k)), canonical(items.get(k)), k);
  assert.notEqual(before, canonical(Object.fromEntries(after))); // only new, empty periods were added
  assert.deepEqual(after.get('goal:week:2026-10-26'), { lines: [] });
});

test('the same period twice (the clock was put back) becomes one item with the lines put together', () => {
  const s = sample();
  s.goalLog.push({ kind: 'week', key: '2026-10-19', lines: ['前に書いた', '週の目標'], closedAt: AT });
  assert.deepEqual(R.itemsOf(s).get('goal:week:2026-10-19'), { lines: ['前に書いた', '週の目標', '二つ目'] });
  // putting it back leaves one place for it
  R.applyItem(s, 'goal:week:2026-10-19', { lines: ['前に書いた', '週の目標', '二つ目'] }, { today: TODAY, at: AT });
  assert.equal(s.goalLog.filter((e) => e.key === '2026-10-19').length, 0);
  assert.deepEqual(s.goals.week.lines, ['前に書いた', '週の目標', '二つ目']);
});

test('putting items in: replace or add; past periods go to the history; future ones wait (not shown yet)', () => {
  const s = sample();
  const at = '2026-10-20T05:00:00.000Z';
  const t2 = Object.assign(newTask({ title: '別の端末で足した' }, at, 3), { id: 't2' });
  assert.equal(R.applyItem(s, 'task:t2', t2, { today: TODAY, at }), 'ok');
  assert.equal(s.tasks.length, 2);
  assert.equal(R.applyItem(s, 'task:t2', Object.assign({}, t2, { title: '直した' }), { today: TODAY, at }), 'ok');
  assert.equal(s.tasks.find((x) => x.id === 't2').title, '直した');
  // memos are kept in the order they were written
  R.applyItem(s, 'memo:m0', { id: 'm0', text: '前のメモ', createdAt: '2026-10-19T00:00:00.000Z', taskId: null, deletedAt: null, purgedAt: null }, { today: TODAY, at });
  assert.deepEqual(s.memos.map((m) => m.id), ['m0', 'm1']);
  // goals: now / history (new, changed, emptied) / later
  R.applyItem(s, 'goal:week:2026-10-19', { lines: ['直した週'] }, { today: TODAY, at });
  assert.deepEqual(s.goals.week.lines, ['直した週']);
  R.applyItem(s, 'goal:week:2026-10-05', { lines: ['前の前の週'] }, { today: TODAY, at });
  assert.deepEqual(s.goalLog.find((e) => e.key === '2026-10-05').lines, ['前の前の週']);
  R.applyItem(s, 'goal:week:2026-10-12', { lines: [] }, { today: TODAY, at });
  assert.equal(s.goalLog.some((e) => e.key === '2026-10-12'), false);
  assert.equal(R.applyItem(s, 'goal:week:2026-10-26', { lines: ['来週'] }, { today: TODAY, at }), 'future');
  assert.equal(R.applyItem(s, 'goal:month:2026-11', { lines: ['来月'] }, { today: TODAY, at }), 'future');
  assert.equal(s.goalLog.some((e) => e.key === '2026-10-26' || e.key === '2026-11'), false);
  // the date check has not run yet on this device (its period is still last week): wait
  const old = newState('2026-10-13', AT);
  assert.equal(R.applyItem(old, 'goal:week:2026-10-19', { lines: ['今週'] }, { today: TODAY, at }), 'wait');
  // schedule: today / the past / tomorrow
  R.applyItem(s, 'schedule:2026-10-20', { lines: [{ id: 'x', text: '15:00 面談' }] }, { today: TODAY, at });
  assert.deepEqual(s.schedule.lines, [{ id: 'x', text: '15:00 面談' }]);
  R.applyItem(s, 'schedule:2026-10-18', { lines: [{ id: 'y', text: '日曜' }] }, { today: TODAY, at });
  assert.equal(s.scheduleLog.find((e) => e.date === '2026-10-18').lines[0].text, '日曜');
  assert.equal(R.applyItem(s, 'schedule:2026-10-21', { lines: [{ id: 'z', text: '明日' }] }, { today: TODAY, at }), 'future');
  R.applyItem(s, 'dragon:name', { name: 'リュウ' }, { today: TODAY, at });
  assert.equal(s.dragon.name, 'リュウ');
  // what was put in reads back as the same content (nothing new to send)
  const items = R.itemsOf(s);
  assert.deepEqual(items.get('schedule:2026-10-20'), { lines: [{ id: 'x', text: '15:00 面談' }] });
  assert.equal(canonical(items.get('task:t2')), canonical(R.cleanContent('task:t2', Object.assign({}, t2, { title: '直した' }))));
});

test('"empty" device: no task (trash and marks too), no memo, no lines (history too), the first dragon name, the first 10 people', () => {
  const fresh = () => newState(TODAY, AT);
  assert.equal(R.isEmptyState(fresh()), true);
  const cases = {
    'a task in the trash': (s) => { const t = newTask({ title: 'x' }, AT, 0); t.deletedAt = AT; s.tasks.push(t); },
    'a completely deleted task': (s) => { const t = newTask({ title: 'x' }, AT, 0); purgeTask(t, AT); s.tasks.push(t); },
    'a memo': (s) => { s.memos.push({ id: 'm', text: 'x', createdAt: AT, taskId: null, deletedAt: AT, purgedAt: null }); },
    'a goal line in the history': (s) => { s.goalLog.push({ kind: 'year', key: '2025', lines: ['x'], closedAt: AT }); },
    'a goal line now': (s) => { s.goals.year.lines = ['x']; },
    'a schedule line in the history': (s) => { s.scheduleLog.push({ date: '2026-10-01', lines: [{ id: 'a', text: 'x' }] }); },
    'the dragon renamed': (s) => { s.dragon.name = 'ソラ'; },
    'a person renamed': (s) => { s.people[0].name = '部長'; },
    'a person regrouped': (s) => { s.people[0].group = 'team'; },
    'a person deleted': (s) => { s.people[3].deletedAt = AT; },
    'a person added': (s) => { s.people.push(newPerson('田中', 'team', null)); },
  };
  for (const [what, fn] of Object.entries(cases)) {
    const s = fresh();
    fn(s);
    assert.equal(R.isEmptyState(s), false, what);
  }
  // empty lines alone do not count
  const s = fresh();
  s.goals.week.lines = ['', '  '];
  assert.equal(R.isEmptyState(s), true);
});

test('receiving: the data is rebuilt from the items; settings and the recent points of this device stay', () => {
  const src = sample();
  const items = R.itemsOf(src);
  const mine = newState(TODAY, AT);
  mine.settings.lastExportAt = '2026-10-18T00:00:00.000Z';
  mine.dragon.log.push({ at: AT, delta: 1, reason: '追加', bucket: 'other' });
  const { state, notShown } = R.stateFromItems(items, { today: TODAY, at: AT, keep: mine });
  assert.deepEqual(notShown, []);
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.goals.week.lines, ['週の目標', '二つ目']);
  assert.equal(state.dragon.name, 'ソラ');
  assert.equal(state.settings.lastExportAt, '2026-10-18T00:00:00.000Z');
  assert.equal(state.dragon.log.length, 1);
  assert.deepEqual(state.people.map((p) => p.name), src.people.map((p) => p.name)); // the first people in their usual order
  assert.equal(canonical(Object.fromEntries(R.itemsOf(state))), canonical(Object.fromEntries(items)));
});

test('reading a file while syncing: "overwrite and add" (nothing missing from the file is removed, empty periods erase nothing)', () => {
  const cur = sample();
  const keep = cur.tasks[0];
  const shared = Object.assign(newTask({ title: '両方にある' }, AT, 1), { id: 'shared' });
  cur.tasks.push(shared);
  const file = newState(TODAY, AT);
  file.tasks.push(Object.assign({}, shared, { title: 'ファイルの中身' }));
  file.tasks.push(Object.assign(newTask({ title: 'ファイルだけ' }, AT, 2), { id: 'only-file' }));
  file.goals.week.lines = []; // empty: the device's goals stay
  const { state } = R.mergeImport(cur, file, { today: TODAY, at: AT });
  assert.deepEqual(state.tasks.map((t) => t.title).sort(), ['ファイルだけ', 'ファイルの中身', keep.title].sort());
  assert.deepEqual(state.goals.week.lines, ['週の目標', '  ', '二つ目 ']);
  assert.equal(state.memos.length, 1);
  assert.equal(state.dragon.name, 'ソラ');
  assert.equal(countsOf(state).tasks, 3);
});

test('same-name people of the sync data take the place of this device\'s ones, and route steps follow', () => {
  const s = newState(TODAY, AT);
  const keiri = s.people.find((p) => p.name === '経理部');
  const t = newTask({ title: 'x', steps: [{ kind: 'request', whoId: keiri.id, note: '' }] }, AT, 0);
  s.tasks.push(t);
  const there = [Object.assign(newPerson('経理部', 'dept', 'cash'), { id: 'sync-keiri' })];
  const map = R.adoptPeople(s, there);
  assert.equal(map.get(keiri.id), 'sync-keiri');
  assert.equal(s.tasks[0].route[0].whoId, 'sync-keiri');
  assert.equal(s.people.filter((p) => p.name === '経理部').length, 1);
  assert.equal(s.people.length, 10);
});

test('keys and contents are checked like the app\'s own data; row labels and tab names', () => {
  assert.equal(R.parseKey('task:abc').id, 'abc');
  assert.equal(R.parseKey('goal:week:2026-13-01'), null);
  assert.equal(R.parseKey('goal:month:2026-10').kind, 'month');
  assert.equal(R.parseKey('schedule:2026-02-30'), null);
  assert.equal(R.parseKey('other:1'), null);
  assert.throws(() => R.cleanContent('task:x', Object.assign(newTask({ title: 'a' }, AT, 0), { id: 'y' })), /合いません/);
  assert.throws(() => R.cleanContent('goal:year:2026', { lines: 'a' }));
  assert.throws(() => R.cleanContent('schedule:2026-10-20', { lines: [{ id: 'a', text: 1 }] }));
  assert.throws(() => R.cleanContent('dragon:name', { name: '' }));
  const t = newTask({ title: 'タスク名' }, AT, 0);
  assert.deepEqual(R.rowLabels('task:' + t.id, t, 'add'), { type: 'タスク', head: 'タスク名', state: '未着手', op: '追加' });
  purgeTask(t, AT);
  assert.deepEqual(R.rowLabels('task:' + t.id, t, 'edit'), { type: 'タスク', head: '（消した）', state: '消した', op: '変更' });
  assert.equal(R.rowLabels('goal:week:2026-10-19', { lines: [] }, 'merge').head, '週 10/19〜10/25');
  assert.equal(R.rowLabels('schedule:2026-10-20', { lines: [] }, 'choice').head, '予定 10/20');
  assert.equal(R.tabTitle('Mac', '3f9a0000'), '記録_Mac_3f9a');
  assert.equal(R.tabTitle("My 'PC'", 'b21c0000'), '記録_My_PC__b21c');
  assert.equal(R.deviceOfTab('記録_iPhone_b21c'), 'iPhone');
  assert.match(R.newDeviceId(), /^[0-9a-z]{16}$/);
});

test('reading a file while syncing: the first people of another device are joined by name (not doubled), routes follow', () => {
  const at = '2026-10-20T01:00:00.000Z';
  const here = newState('2026-10-20', at);
  const there = newState('2026-10-20', at); // the same 10 people with ids of their own
  there.people.push(newPerson('取引先のAさん', 'outside', ''));
  const second = there.people[1];
  const t = newTask({ title: '確認してもらう' }, at, 0);
  t.route = [newStep('confirm', second.id, '')];
  there.tasks.push(t);
  const out = R.mergeImport(here, there, { today: '2026-10-20', at }).state;
  assert.equal(out.people.length, here.people.length + 1); // only the new person is added
  assert.deepEqual(out.people.map((p) => p.name).filter((n, i, a) => a.indexOf(n) !== i), []); // no name twice
  const hereSecond = here.people.find((p) => p.name === second.name);
  assert.equal(out.tasks[0].route[0].whoId, hereSecond.id);
  // the same file read twice adds nothing more
  const again = R.mergeImport(out, there, { today: '2026-10-20', at }).state;
  assert.equal(again.people.length, out.people.length);
  assert.equal(again.tasks.length, 1);
});
