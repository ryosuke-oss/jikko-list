import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newTask, addStep, setStepState, removeStep, allStepsDone, collectStepXp, routeNow, linkStatus,
  smartCounts, matchFilters, emptyFilters, applyReorder, byOrder, completeTask, uncompleteTask,
  parkTask, returnDueParked, trashTask, dueInfo, rowMeta, ROUTE_MAX, nextOrder,
  purgeTask, purgeMemo, isPurged, isLive, PURGED_TASK_TITLE, restoreTask, keepXpSteps,
} from '../public/js/tasks.js';
import { countXp } from '../public/js/dragon.js';

const TODAY = '2026-10-19'; // Monday
const AT = '2026-10-19T09:00:00.000Z';
const people = new Map([
  ['boss', { id: 'boss', name: '上司' }],
  ['acc', { id: 'acc', name: '経理部' }],
  ['edu', { id: 'edu', name: '教育部' }],
]);

function task(fields, order = 0) {
  return newTask(Object.assign({ title: 'テスト' }, fields), AT, order);
}

test('route: up to 5 steps, the 6th is refused', () => {
  const t = task();
  for (let i = 0; i < ROUTE_MAX; i += 1) assert.ok(addStep(t, 'confirm', 'boss', ''));
  assert.equal(addStep(t, 'confirm', 'boss', ''), null);
  assert.equal(t.route.length, 5);
});

test('status linkage: wait -> stopped, no wait -> in progress, done prompts but does not complete', () => {
  const t = task();
  addStep(t, 'confirm', 'boss', '');
  addStep(t, 'request', 'acc', '');
  assert.equal(t.status, 'todo');
  setStepState(t, t.route[1].id, 'wait', TODAY);
  assert.equal(t.status, 'stopped');
  assert.equal(routeNow(t, people, TODAY).text, '経理部の返事待ち 0日');
  assert.equal(routeNow(t, people, '2026-10-21').text, '経理部の返事待ち 2日');
  setStepState(t, t.route[1].id, 'done', TODAY);
  assert.equal(t.status, 'doing');
  assert.equal(allStepsDone(t), false);
  assert.equal(routeNow(t, people, TODAY).text, '次: 上司に確認');
  setStepState(t, t.route[0].id, 'done', TODAY);
  assert.equal(allStepsDone(t), true);
  assert.equal(t.status, 'doing'); // never completed automatically
});

test('manual status change is allowed; the next step change links again', () => {
  const t = task();
  addStep(t, 'confirm', 'boss', '');
  t.status = 'stopped';
  setStepState(t, t.route[0].id, 'wait', TODAY);
  setStepState(t, t.route[0].id, 'todo', TODAY);
  assert.equal(t.status, 'doing');
  t.status = 'done';
  assert.equal(linkStatus(t), 'done');
});

test('removing the waiting step resumes the task', () => {
  const t = task();
  addStep(t, 'request', 'acc', '');
  setStepState(t, t.route[0].id, 'wait', TODAY);
  removeStep(t, t.route[0].id);
  assert.equal(t.status, 'doing');
});

test('+2 per step only the first time it is done', () => {
  const t = task();
  addStep(t, 'confirm', 'boss', '');
  addStep(t, 'confirm', 'edu', '');
  setStepState(t, t.route[0].id, 'done', TODAY);
  assert.equal(collectStepXp(t), 2);
  assert.equal(collectStepXp(t), 0);
  setStepState(t, t.route[0].id, 'todo', TODAY);
  setStepState(t, t.route[0].id, 'done', TODAY);
  assert.equal(collectStepXp(t), 0);
});

test('completion gives points by rank (+3 on time) and undo takes exactly that back', () => {
  const noAdd = (t) => Object.assign(t, { createdAt: '' }); // count only the completion here
  const a = noAdd(task({ rank: 'A', due: '2026-10-20' }));
  const r = completeTask(a, TODAY, AT);
  assert.equal(r.amount, 23);
  assert.equal(countXp([a]).A, 23);
  assert.equal(uncompleteTask(a, AT).amount, -23);
  assert.deepEqual(countXp([a]), { A: 0, B: 0, C: 0, other: 0 });
  assert.equal(a.status, 'todo');
  const late = noAdd(task({ rank: 'A', due: '2026-10-18' }));
  assert.equal(completeTask(late, TODAY, AT).amount, 20);
  const b = noAdd(task({ rank: 'B' }));
  assert.equal(completeTask(b, TODAY, AT).amount, 10);
  const c = noAdd(task({ rank: 'C', due: TODAY }));
  assert.equal(completeTask(c, TODAY, AT).amount, 8);
  assert.deepEqual(countXp([a, late, b, c]), { A: 20, B: 10, C: 8, other: 0 });
});

test('undo restores the status before completion', () => {
  const t = task({ rank: 'B' });
  t.status = 'stopped';
  completeTask(t, TODAY, AT);
  uncompleteTask(t, AT);
  assert.equal(t.status, 'stopped');
});

test('smart lists and filters count what they should', () => {
  const ts = [
    task({ title: 'a', due: TODAY, rank: 'A', star: true }),
    task({ title: 'b', due: '2026-10-18', rank: 'B' }),
    task({ title: 'c', rank: 'C', duration: '3d' }),
    task({ title: 'd', due: '2026-10-25', rank: 'C', duration: '1w' }),
    task({ title: 'e' }),
  ];
  ts[2].status = 'stopped';
  ts[3].cOption = true;
  parkTask(ts[4], null, AT);
  const done = task({ title: 'f', due: TODAY });
  done.status = 'done';
  const gone = task({ title: 'g', due: TODAY });
  trashTask(gone, AT);
  const all = ts.concat([done, gone]);
  assert.deepEqual(smartCounts(all, TODAY), { today: 1, overdue: 1, all: 4, star: 1, stopped: 1, parked: 1 });
  const count = (f) => all.filter((t) => !t.deletedAt && t.status !== 'done' && !t.parked && matchFilters(Object.assign(emptyFilters(), f), t, TODAY)).length;
  assert.equal(count({ rank: 'A' }), 1);
  assert.equal(count({ rank: 'C' }), 2);
  assert.equal(count({ due: 'week' }), 2); // 10/19 and 10/25; 10/18 is the previous week
  assert.equal(count({ duration: '3d' }), 1);
  assert.equal(count({ duration: '1w' }), 1);
  assert.equal(count({ cOption: true }), 1);
  assert.equal(count({ status: 'stopped' }), 1);
  assert.equal(count({ rank: 'C', duration: '1w' }), 1);
});

const titles = (ts) => ts.slice().sort(byOrder).map((t) => t.title).join('');

test('reorder in a filtered view keeps hidden rows in place', () => {
  const ts = ['a', 'b', 'c', 'd'].map((title, i) => task({ title }, i));
  // only a and c are visible; the user moves c above a: only c moves, right above a (0-2 c)
  assert.deepEqual(applyReorder(ts, [ts[2].id, ts[0].id], ts[2].id, AT), [ts[2].id]);
  assert.equal(titles(ts), 'cabd');
});

test('one drag changes the number of one task only: halfway between the rows above and below', () => {
  const ts = ['a', 'b', 'c', 'd', 'e'].map((title, i) => task({ title }, i));
  const before = ts.map((t) => t.order);
  const later = '2026-10-19T10:00:00.000Z';
  // e goes between b and c
  const ids = [ts[0], ts[1], ts[4], ts[2], ts[3]].map((t) => t.id);
  assert.deepEqual(applyReorder(ts, ids, ts[4].id, later), [ts[4].id]);
  assert.equal(ts[4].order, 1.5);
  assert.equal(ts[4].updatedAt, later);
  assert.deepEqual(ts.slice(0, 4).map((t) => t.order), before.slice(0, 4));
  assert.equal(titles(ts), 'abecd');
  // to the top: one less than the visible top row; to the bottom: one more than the visible bottom row
  applyReorder(ts, [ts[3], ts[0], ts[1], ts[4], ts[2]].map((t) => t.id), ts[3].id, later);
  assert.equal(ts[3].order, -1);
  applyReorder(ts, [ts[3], ts[1], ts[4], ts[2], ts[0]].map((t) => t.id), ts[0].id, later);
  assert.equal(ts[0].order, 3);
  assert.equal(titles(ts), 'dbeca');
});

test('when the two numbers are too close, all tasks are numbered again first (rare)', () => {
  const ts = ['a', 'b', 'c'].map((title, i) => task({ title }, 0));
  ts[1].createdAt = '2026-10-19T09:00:01.000Z';
  ts[2].createdAt = '2026-10-19T09:00:02.000Z';
  // same numbers (order 0): c between a and b
  const changed = applyReorder(ts, [ts[0], ts[2], ts[1]].map((t) => t.id), ts[2].id, AT);
  assert.ok(changed.length > 1);
  assert.equal(titles(ts), 'acb');
  // halving the same gap again and again (each new row goes right below x): renumbering kicks in, order stays right
  const xs = ['x', 'y'].map((title, i) => task({ title }, i));
  let renumbered = 0;
  for (let k = 0; k < 60; k += 1) {
    const z = task({ title: 'z' + k }, 99);
    xs.push(z);
    const sorted = xs.slice().sort(byOrder).filter((t) => t !== z);
    const changed = applyReorder(xs, [sorted[0], z, sorted[1]].map((t) => t.id), z.id, AT);
    if (changed.length > 1) renumbered += 1;
    assert.equal(xs.slice().sort(byOrder)[1].id, z.id, 'round ' + k);
  }
  assert.ok(renumbered >= 1 && renumbered <= 5, 'renumbered ' + renumbered + ' times in 60 drags');
});

test('a drag with no visible neighbour, or of an unknown row, changes nothing', () => {
  const ts = ['a', 'b'].map((title, i) => task({ title }, i));
  assert.deepEqual(applyReorder(ts, [ts[0].id], ts[0].id, AT), []);
  assert.deepEqual(applyReorder(ts, [ts[0].id, ts[1].id], 'nope', AT), []);
  assert.equal(titles(ts), 'ab');
});

test('parked tasks with a return date come back on top, marked', () => {
  const ts = ['a', 'b', 'c'].map((title, i) => task({ title }, i));
  parkTask(ts[2], '2026-10-20', AT);
  assert.deepEqual(returnDueParked(ts, TODAY, AT), []);
  assert.deepEqual(returnDueParked(ts, '2026-10-20', AT), [ts[2].id]);
  assert.equal(ts[2].parked, false);
  assert.equal(ts[2].returnedMark, true);
  assert.equal(ts.slice().sort(byOrder)[0].title, 'c');
  assert.equal(nextOrder(ts), 2);
});

test('due colors: overdue and today red, 1-3 days orange, later gray', () => {
  assert.deepEqual([dueInfo('2026-10-18', TODAY).tone, dueInfo('2026-10-18', TODAY).text], ['red', '昨日']);
  assert.equal(dueInfo('2026-10-15', TODAY).text, '10/15(木)');
  assert.deepEqual([dueInfo(TODAY, TODAY).tone, dueInfo(TODAY, TODAY).text], ['red', '今日']);
  assert.deepEqual([dueInfo('2026-10-20', TODAY).tone, dueInfo('2026-10-20', TODAY).text], ['orange', '明日']);
  assert.deepEqual([dueInfo('2026-10-22', TODAY).tone, dueInfo('2026-10-22', TODAY).text], ['orange', 'あと3日']);
  assert.deepEqual([dueInfo('2026-10-23', TODAY).tone, dueInfo('2026-10-23', TODAY).text], ['gray', '10/23(金)']);
  assert.equal(dueInfo('2027-01-05', TODAY).text, '2027/1/5(火)');
});

test('row meta shows the wait first, then the date and the duration', () => {
  const t = task({ due: '2026-10-22', duration: '1d' });
  addStep(t, 'request', 'acc', '');
  setStepState(t, t.route[0].id, 'wait', '2026-10-17');
  assert.deepEqual(rowMeta(t, people, TODAY).map((m) => m.text), ['経理部の返事待ち 2日', 'あと3日', '所要1日']);
});

test('route points cannot be padded by adding and deleting steps (at most 5 per task)', () => {
  const t = task();
  let total = 0;
  for (let k = 0; k < 8; k += 1) {
    const s = addStep(t, 'confirm', 'boss', '');
    setStepState(t, s.id, 'done', TODAY);
    total += collectStepXp(t);
    removeStep(t, s.id);
  }
  assert.equal(total, 10);
  // the ids of the steps that earned points stay, even though the steps were deleted
  assert.equal(t.xpSteps.length, 5);
  assert.equal(t.stepXpCount, 5);
  assert.equal(countXp([Object.assign(t, { createdAt: '' })]).other, 10);
});

test('a task completed from the later box goes back into the box on undo', () => {
  const t = task({ rank: 'C' });
  parkTask(t, '2026-10-26', AT);
  completeTask(t, TODAY, AT);
  assert.equal(t.parked, false);
  uncompleteTask(t, AT);
  assert.equal(t.parked, true);
  assert.equal(t.returnOn, '2026-10-26');
});

test('completely deleting keeps a small mark: the points stay, the contents go, it is in no list', () => {
  const t = task({ title: '秘密の名前', rank: 'A', due: TODAY, star: true });
  t.memo = 'メモ';
  t.links.web = 'https://example.com/';
  const s = addStep(t, 'request', 'acc', 'メモ');
  setStepState(t, s.id, 'done', TODAY);
  collectStepXp(t);
  completeTask(t, TODAY, AT);
  const pointsBefore = countXp([t]);
  trashTask(t, AT);
  purgeTask(t, '2026-10-19T10:00:00.000Z');
  assert.ok(isPurged(t));
  assert.equal(t.title, PURGED_TASK_TITLE);
  assert.equal(t.memo, '');
  assert.deepEqual(t.route, []);
  assert.deepEqual(t.links, { slack: '', doc: '', web: '' });
  assert.equal(t.due, null);
  assert.equal(t.star, false);
  assert.equal(t.deletedAt, AT);
  assert.equal(t.purgedAt, '2026-10-19T10:00:00.000Z');
  assert.equal(t.status, 'done');
  assert.deepEqual(countXp([t]), pointsBefore);
  assert.equal(isLive(t), false);
  assert.deepEqual(smartCounts([t], TODAY), { today: 0, overdue: 0, all: 0, star: 0, stopped: 0, parked: 0 });
  const m = { id: 'm1', text: 'メモの中身', createdAt: AT, taskId: t.id, deletedAt: AT };
  purgeMemo(m, AT);
  assert.deepEqual(m, { id: 'm1', text: '（消したメモ）', createdAt: AT, taskId: null, deletedAt: AT, purgedAt: AT });
});

test('a completely deleted task never comes back from the trash, even through an undo button', () => {
  const t = task({ title: 'x' });
  trashTask(t, AT);
  purgeTask(t, AT);
  assert.equal(restoreTask(t, AT), false);
  assert.ok(t.deletedAt);
  const u = task({ title: 'y' });
  trashTask(u, AT);
  assert.equal(restoreTask(u, AT), true);
  assert.equal(u.deletedAt, null);
  // even a mark that somehow lost its trash date is not live
  const v = task({ title: 'z' });
  v.purgedAt = AT;
  assert.equal(isLive(v), false);
});

test('saving over a copy that another tab changed keeps every step that earned points (at most 5)', () => {
  const mine = task();
  const theirs = structuredClone(mine);
  mine.xpSteps = ['s1', 's2'];
  theirs.xpSteps = ['s2', 's3', 's4'];
  theirs.xpStepsLegacy = 1;
  keepXpSteps(mine, theirs);
  assert.deepEqual(mine.xpSteps, ['s1', 's2', 's3', 's4']);
  assert.equal(mine.xpStepsLegacy, 1);
  assert.equal(mine.stepXpCount, 5);
  const full = task();
  full.xpSteps = ['a', 'b', 'c', 'd', 'e'];
  keepXpSteps(full, Object.assign(task(), { xpSteps: ['f'], xpStepsLegacy: 0 }));
  assert.equal(full.xpSteps.length, 5);
});
