import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, buildExport, validateImport, parseImportText, cleanState, exportFileName, countsOf, cleanTask, cleanMemo, DB_VERSION } from '../public/js/store.js';
import { newTask, addStep, setStepState, removeStep, collectStepXp, completeTask, trashTask, purgeTask, purgeMemo } from '../public/js/tasks.js';
import { settle, countXp, XP_MODEL } from '../public/js/dragon.js';

const TODAY = '2026-10-19';
const AT = '2026-10-19T09:00:00.000Z';

function sample() {
  const s = newState(TODAY, AT);
  const t1 = newTask({ title: '一つ目', due: '2026-10-23', rank: 'B', duration: '3d', star: true }, AT, 0);
  addStep(t1, 'request', s.people[2].id, 'メモ');
  setStepState(t1, t1.route[0].id, 'wait', TODAY);
  t1.links.web = 'https://example.com/';
  const t2 = newTask({ title: '二つ目', rank: 'A' }, AT, 1);
  completeTask(t2, TODAY, AT);
  s.tasks.push(t1, t2);
  settle(s.dragon, s.tasks, '追加', AT);
  s.memos.push({ id: 'm1', text: 'メモの行', createdAt: AT, taskId: null, deletedAt: null, purgedAt: null });
  s.goals.week.lines = ['週の目標', ''];
  s.schedule.lines = [{ id: 'l1', text: '9:00 予定' }];
  s.scheduleLog.push({ date: '2026-10-18', lines: [{ id: 'l0', text: '前の日' }] });
  s.goalLog.push({ kind: 'week', key: '2026-10-12', lines: ['先週'], closedAt: AT });
  return s;
}

test('export -> import gives back exactly the same data', () => {
  const s = sample();
  const file = JSON.parse(JSON.stringify(buildExport(s, AT)));
  const r = validateImport(file);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, JSON.parse(JSON.stringify(s)));
  // and checking it again changes nothing
  assert.deepEqual(cleanState(r.data), r.data);
  assert.equal(r.counts.tasks, 1);
  assert.equal(r.counts.done, 1);
  assert.equal(countsOf(s).memos, 1);
});

test('broken or foreign files are refused', () => {
  assert.equal(parseImportText('{not json').ok, false);
  assert.equal(parseImportText('[]').ok, false);
  assert.match(parseImportText(JSON.stringify({ app: 'other', format: 1, data: {} })).error, /書き出しファイルではありません/);
  assert.match(parseImportText(JSON.stringify({ app: 'jikko-list', format: 2, data: {} })).error, /版/);
  const s = sample();
  const bad = buildExport(s, AT);
  bad.data.tasks[0].title = '';
  assert.equal(validateImport(JSON.parse(JSON.stringify(bad))).ok, false);
  const dup = buildExport(s, AT);
  dup.data.tasks[1].id = dup.data.tasks[0].id;
  assert.match(validateImport(JSON.parse(JSON.stringify(dup))).error, /重複/);
  const noArr = buildExport(s, AT);
  noArr.data.tasks = 'x';
  assert.equal(validateImport(JSON.parse(JSON.stringify(noArr))).ok, false);
});

test('only http(s) links survive', () => {
  const s = sample();
  const f = JSON.parse(JSON.stringify(buildExport(s, AT)));
  f.data.tasks[0].links = { slack: 'javascript:alert(1)', doc: 'https://example.com/doc', web: 'data:text/html,x' };
  const r = validateImport(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tasks[0].links, { slack: '', doc: 'https://example.com/doc', web: '' });
});

test('file name', () => {
  assert.equal(exportFileName(new Date(2026, 9, 19, 9, 5)), 'jikko-list_20261019-0905.json');
});

test('version 1.2 data: the step count becomes step ids, the steps already deleted stay a count', () => {
  const s = sample();
  const t = s.tasks[0];
  const a = addStep(t, 'confirm', s.people[0].id, '');
  const b = addStep(t, 'confirm', s.people[1].id, '');
  setStepState(t, a.id, 'done', TODAY);
  setStepState(t, b.id, 'done', TODAY);
  collectStepXp(t);
  removeStep(t, b.id);
  // what version 1.2 saved: only the count, no ids
  const old = JSON.parse(JSON.stringify(buildExport(s, AT)));
  const o = old.data.tasks[0];
  delete o.xpSteps;
  delete o.xpStepsLegacy;
  delete o.purgedAt;
  o.stepXpCount = 2;
  const r = validateImport(old);
  assert.equal(r.ok, true, r.error);
  const m = r.data.tasks[0];
  assert.deepEqual(m.xpSteps, [a.id]);
  assert.equal(m.xpStepsLegacy, 1);
  assert.equal(m.stepXpCount, 2);
  assert.equal(m.purgedAt, null);
  assert.equal(countXp([m]).other, 2 * 2 + 1);
});

test('older settings read as points model 1; new data starts with the current model', () => {
  const s = sample();
  assert.equal(s.settings.xpModel, XP_MODEL);
  const f = JSON.parse(JSON.stringify(buildExport(s, AT)));
  delete f.data.settings.xpModel;
  assert.equal(validateImport(f).data.settings.xpModel, 1);
});

test('completely deleted tasks and memos stay as marks: kept through export and import, not counted as trash', () => {
  const s = sample();
  const [t1, t2] = s.tasks;
  trashTask(t1, AT);
  trashTask(t2, AT);
  purgeTask(t2, AT);
  s.memos[0].deletedAt = AT;
  purgeMemo(s.memos[0], AT);
  const pointsBefore = countXp(s.tasks);
  const r = validateImport(JSON.parse(JSON.stringify(buildExport(s, AT))));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, JSON.parse(JSON.stringify(s)));
  assert.equal(r.data.tasks[1].purgedAt, AT);
  assert.equal(r.data.tasks[1].title, '（消したタスク）');
  assert.deepEqual(countXp(r.data.tasks), pointsBefore);
  assert.equal(countsOf(r.data).trash, 1); // t1 in the trash; the mark of t2 is not shown anywhere
  assert.equal(countsOf(r.data).memos, 0);
  // a mark without its placeholder name is still read
  const f = JSON.parse(JSON.stringify(buildExport(s, AT)));
  f.data.tasks[1].title = '';
  f.data.memos[0].text = '';
  assert.equal(validateImport(f).ok, true);
});

test('a mark read without a trash date is put in the trash; the database version stops older tabs', () => {
  const t = cleanTask(Object.assign(newTask({ title: 'x' }, AT, 0), { purgedAt: AT, deletedAt: null }));
  assert.equal(t.deletedAt, AT);
  const m = cleanMemo({ id: 'm', text: '', createdAt: AT, taskId: null, deletedAt: null, purgedAt: AT });
  assert.equal(m.deletedAt, AT);
  assert.equal(m.text, '（消したメモ）');
  assert.equal(DB_VERSION, 3); // 2 in 3-1 (stops tabs of 1.2), 3 in 3-2 (the sync stores)
});
