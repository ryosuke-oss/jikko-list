import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, buildExport, validateImport, parseImportText, cleanState, exportFileName, countsOf } from '../public/js/store.js';
import { newTask, addStep, setStepState, completeTask } from '../public/js/tasks.js';
import { grantAdd } from '../public/js/dragon.js';

const TODAY = '2026-10-19';
const AT = '2026-10-19T09:00:00.000Z';

function sample() {
  const s = newState(TODAY, AT);
  const t1 = newTask({ title: '一つ目', due: '2026-10-23', rank: 'B', duration: '3d', star: true }, AT, 0);
  addStep(t1, 'request', s.people[2].id, 'メモ');
  setStepState(t1, t1.route[0].id, 'wait', TODAY);
  t1.links.web = 'https://example.com/';
  const t2 = newTask({ title: '二つ目', rank: 'A' }, AT, 1);
  completeTask(t2, s.dragon, TODAY, AT);
  grantAdd(s.dragon, TODAY, AT);
  s.tasks.push(t1, t2);
  s.memos.push({ id: 'm1', text: 'メモの行', createdAt: AT, taskId: null, deletedAt: null });
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
