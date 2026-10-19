import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newTask, addStep, setStepState, removeStep, allStepsDone, collectStepXp, routeNow, linkStatus,
  smartCounts, matchFilters, emptyFilters, applyReorder, byOrder, completeTask, uncompleteTask,
  parkTask, returnDueParked, trashTask, dueInfo, rowMeta, ROUTE_MAX, nextOrder,
} from '../public/js/tasks.js';
import { newDragon } from '../public/js/dragon.js';

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
  const d = newDragon();
  const a = task({ rank: 'A', due: '2026-10-20' });
  const r = completeTask(a, d, TODAY, AT);
  assert.equal(r.amount, 23);
  assert.equal(d.xp.A, 23);
  assert.equal(d.total, 23);
  uncompleteTask(a, d, AT);
  assert.equal(d.total, 0);
  assert.equal(a.status, 'todo');
  const late = task({ rank: 'A', due: '2026-10-18' });
  assert.equal(completeTask(late, d, TODAY, AT).amount, 20);
  const b = task({ rank: 'B' });
  assert.equal(completeTask(b, d, TODAY, AT).amount, 10);
  const c = task({ rank: 'C', due: TODAY });
  assert.equal(completeTask(c, d, TODAY, AT).amount, 8);
  assert.equal(d.xp.A, 20);
  assert.equal(d.xp.B, 10);
  assert.equal(d.xp.C, 8);
});

test('undo restores the status before completion', () => {
  const d = newDragon();
  const t = task({ rank: 'B' });
  t.status = 'stopped';
  completeTask(t, d, TODAY, AT);
  uncompleteTask(t, d, AT);
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

test('reorder in a filtered view keeps hidden rows in place', () => {
  const ts = ['a', 'b', 'c', 'd'].map((title, i) => task({ title }, i));
  // only a and c are visible; the user moves c above a
  applyReorder(ts, [ts[2].id, ts[0].id]);
  const order = ts.slice().sort(byOrder).map((t) => t.title).join('');
  assert.equal(order, 'cbad');
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
});

test('a task completed from the later box goes back into the box on undo', () => {
  const d = newDragon();
  const t = task({ rank: 'C' });
  parkTask(t, '2026-10-26', AT);
  completeTask(t, d, TODAY, AT);
  assert.equal(t.parked, false);
  uncompleteTask(t, d, AT);
  assert.equal(t.parked, true);
  assert.equal(t.returnOn, '2026-10-26');
});
