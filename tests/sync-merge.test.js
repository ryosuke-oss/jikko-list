// 7-5 of the spec, every row of the tables: what is put together automatically and what is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeItem, lineFates, mergeOrder } from '../public/js/sync/merge.js';
import { cleanContent } from '../public/js/sync/records.js';
import { canonical } from '../public/js/sync/rev.js';
import { newTask, completeTask, parkTask, unparkTask, purgeTask, purgeMemo, newPerson } from '../public/js/tasks.js';
import { countXp } from '../public/js/dragon.js';

const T0 = '2026-10-20T01:00:00.000Z';
const TA = '2026-10-20T02:00:00.000Z'; // the change on side a
const TB = '2026-10-20T03:00:00.000Z'; // the change on side b (newer)
const NA = '2-aaaaaaaaaaaaaaaa';
const NB = '2-bbbbbbbbbbbbbbbb';
const TODAY = '2026-10-20';

function step(id, kind, whoId, note) {
  return { id, kind, whoId, note, state: 'todo', waitSince: null, doneAt: null, xpGiven: false };
}

function baseTask() {
  const x = newTask({ title: '研修資料の改訂', due: '2026-10-23', rank: 'B', duration: '3d' }, T0, 1);
  x.id = 't1';
  x.route = [step('s1', 'confirm', 'p1', ''), step('s2', 'request', 'p2', ''), step('s3', 'reply', 'p3', '')];
  return cleanContent('task:t1', x);
}

function edit(o, fn, at) {
  const x = structuredClone(o);
  fn(x);
  x.updatedAt = at;
  return cleanContent('task:t1', x);
}

function mt(o, a, b, prefer) {
  const r = mergeItem('task:t1', o, a, b, { aName: NA, bName: NB, prefer });
  return { c: r.content, f: r.conflicts.map((x) => x.field), r };
}

// ---------------------------------------------------------------- tasks

test('task places that are asked (title, due, rank, duration, next action, memo): one side -> taken, the same -> kept, different -> asked', () => {
  const o = baseTask();
  const cases = [['title', 'A案', 'B案'], ['due', '2026-10-24', '2026-10-25'], ['rank', 'A', 'C'], ['duration', '1w', '1m'], ['nextAction', '電話する', 'メールする'], ['memo', 'Aのメモ', 'Bのメモ']];
  for (const [f, va, vb] of cases) {
    const a = edit(o, (x) => { x[f] = va; }, TA);
    const b = edit(o, (x) => { x[f] = vb; }, TB);
    const same = edit(o, (x) => { x[f] = va; }, TB);
    assert.deepEqual(mt(o, a, o).f, [], f + ': only a');
    assert.equal(mt(o, a, o).c[f], va, f);
    assert.equal(mt(o, o, b).c[f], vb, f);
    assert.deepEqual(mt(o, a, same).f, [], f + ': the same value on both');
    assert.equal(mt(o, a, same).c[f], va);
    const both = mt(o, a, b);
    assert.deepEqual(both.f, [f], f + ': different on both');
    assert.equal(both.c[f], vb, f + ': shown for now = the newer side');
    assert.equal(mt(o, a, b, 'a').c[f], va);
    assert.equal(mt(o, a, b, 'b').c[f], vb);
  }
  // true/false places (★ and the C option) can only change one way: taken automatically
  const s = mt(o, edit(o, (x) => { x.star = true; }, TA), edit(o, (x) => { x.rank = 'C'; x.cOption = true; }, TB));
  assert.deepEqual(s.f, []);
  assert.equal(s.c.star, true);
  assert.equal(s.c.cOption, true);
  assert.equal(s.c.rank, 'C');
});

test('links: one at a time (Slack on one side and the document on the other -> both); the same link differently -> asked', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.links.slack = 'https://example.com/slack'; x.links.web = 'https://example.com/a'; }, TA);
  const b = edit(o, (x) => { x.links.doc = 'https://example.com/doc'; x.links.web = 'https://example.com/b'; }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, ['links.web']);
  assert.equal(r.c.links.slack, 'https://example.com/slack');
  assert.equal(r.c.links.doc, 'https://example.com/doc');
  assert.equal(mt(o, a, b, 'a').c.links.web, 'https://example.com/a');
});

test('status: both completed -> the earlier completion; ★ completed and not -> asked; neither -> decided again from the route', () => {
  const o = baseTask();
  const a = edit(o, (x) => { completeTask(x, TODAY, TA); }, TA);
  const b = edit(o, (x) => { completeTask(x, TODAY, TB); }, TB);
  const both = mt(o, a, b);
  assert.deepEqual(both.f, []);
  assert.equal(both.c.status, 'done');
  assert.equal(both.c.doneAt, TA); // the earlier one, with its points
  assert.equal(both.c.xpGiven, a.xpGiven);
  // ★ completed on one side, a step put on "wait" on the other
  const w = edit(o, (x) => { x.route[0].state = 'wait'; x.route[0].waitSince = TODAY; x.status = 'stopped'; }, TB);
  const q = mt(o, a, w);
  assert.ok(q.f.includes('status'));
  assert.equal(mt(o, a, w, 'a').c.status, 'done');
  assert.equal(mt(o, a, w, 'b').c.status, 'stopped');
  // neither completed: in progress on one side, stopped by hand on the other -> from the route
  const doing = edit(o, (x) => { x.status = 'doing'; }, TA);
  const stopped = edit(o, (x) => { x.status = 'stopped'; }, TB);
  assert.equal(mt(o, doing, stopped).c.status, 'doing'); // no step waiting
  assert.deepEqual(mt(o, doing, stopped).f, []);
  const waitB = edit(o, (x) => { x.route[1].state = 'wait'; x.route[1].waitSince = TODAY; x.status = 'stopped'; }, TB);
  assert.equal(mt(o, doing, waitB).c.status, 'stopped'); // a step is waiting
});

test('route steps (told apart by id): kind, person and note one by one; the state of a step as one place', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.route[0].whoId = 'p9'; x.route[2].note = 'Aのメモ'; }, TA);
  const b = edit(o, (x) => { x.route[1].note = 'Bのメモ'; x.route[2].note = 'Bのメモ'; x.route[1].kind = 'confirm'; }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, ['route.s3.note']);
  assert.equal(r.c.route[0].whoId, 'p9');
  assert.equal(r.c.route[1].note, 'Bのメモ');
  assert.equal(r.c.route[1].kind, 'confirm');
  // the state (todo / wait / done with its date) of the same step changed differently
  const sa = edit(o, (x) => { x.route[0].state = 'wait'; x.route[0].waitSince = TODAY; x.status = 'stopped'; }, TA);
  const sb = edit(o, (x) => { x.route[0].state = 'done'; x.route[0].doneAt = TODAY; x.status = 'doing'; }, TB);
  assert.ok(mt(o, sa, sb).f.includes('route.s1.state'));
  // different steps' states: both taken
  const sc = edit(o, (x) => { x.route[1].state = 'done'; x.route[1].doneAt = TODAY; x.status = 'doing'; }, TB);
  const m = mt(o, sa, sc);
  assert.deepEqual(m.f.filter((f) => f.startsWith('route')), []);
  assert.equal(m.c.route[0].state, 'wait');
  assert.equal(m.c.route[1].state, 'done');
  assert.equal(m.c.status, 'stopped'); // one step is waiting
});

test('steps added on both sides stay (automatic); ★ more than 5 steps together -> which route', () => {
  const o = edit(baseTask(), (x) => { x.route = x.route.slice(0, 2); }, T0);
  const a = edit(o, (x) => { x.route.push(step('a1', 'confirm', 'p5', 'A')); }, TA);
  const b = edit(o, (x) => { x.route.push(step('b1', 'confirm', 'p6', 'B')); }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, []);
  assert.deepEqual(r.c.route.map((s) => s.id).sort(), ['a1', 'b1', 's1', 's2']);
  assert.deepEqual(r.c.route.slice(0, 2).map((s) => s.id), ['s1', 's2']);
  const a2 = edit(a, (x) => { x.route.push(step('a2', 'confirm', 'p5', '')); }, TA);
  const b2 = edit(b, (x) => { x.route.push(step('b2', 'confirm', 'p6', '')); }, TB);
  const over = mt(o, a2, b2);
  assert.deepEqual(over.f, ['route']); // 6 steps: asked as one place
  assert.deepEqual(mt(o, a2, b2, 'a').c.route.map((s) => s.id), ['s1', 's2', 'a1', 'a2']);
  assert.deepEqual(mt(o, a2, b2, 'b').c.route.map((s) => s.id), ['s1', 's2', 'b1', 'b2']);
});

test('a removed step is removed (automatic); ★ removed on one side and changed on the other -> asked', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.route.splice(1, 1); }, TA);
  assert.deepEqual(mt(o, a, o).c.route.map((s) => s.id), ['s1', 's3']);
  const b = edit(o, (x) => { x.route[0].note = '別の段を直した'; }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, []);
  assert.deepEqual(r.c.route.map((s) => s.id), ['s1', 's3']);
  const b2 = edit(o, (x) => { x.route[1].note = '消された段を直した'; }, TB);
  const q = mt(o, a, b2);
  assert.deepEqual(q.f, ['route.s2.removed']);
  assert.deepEqual(mt(o, a, b2, 'a').c.route.map((s) => s.id), ['s1', 's3']);
  assert.deepEqual(mt(o, a, b2, 'b').c.route.map((s) => s.note), ['', '消された段を直した', '']);
});

test('the order of the steps: the side that moved them (both moved: the newer one)', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.route.reverse(); }, TA);
  const b = edit(o, (x) => { x.route.push(step('b1', 'confirm', 'p6', '')); x.route.splice(0, 1); }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, []);
  // a moved them (s3 first); b removed s1 and added b1 after s3 there: b1 stays right after s3
  assert.deepEqual(r.c.route.map((s) => s.id), ['s3', 'b1', 's2']);
  const b2 = edit(o, (x) => { x.route = [x.route[1], x.route[0], x.route[2]]; }, TB);
  assert.deepEqual(mt(o, a, b2).c.route.map((s) => s.id), ['s2', 's1', 's3']); // both moved: the newer (b)
});

test('the later box (put away with its return date as one place) is asked', () => {
  const o = baseTask();
  const a = edit(o, (x) => { parkTask(x, '2026-10-26', TA); }, TA);
  const b = edit(o, (x) => { parkTask(x, '2026-10-21', TB); }, TB);
  assert.deepEqual(mt(o, a, b).f, ['park']);
  assert.equal(mt(o, a, b, 'a').c.returnOn, '2026-10-26');
  assert.deepEqual(mt(o, a, edit(o, (x) => { x.title = '別'; }, TB)).f, []);
});

test('the trash: both -> the earlier date; ★ in the trash on one side and changed on the other -> asked', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.deletedAt = TA; }, TA);
  const b = edit(o, (x) => { x.deletedAt = TB; }, TB);
  assert.deepEqual(mt(o, a, b).f, []);
  assert.equal(mt(o, a, b).c.deletedAt, TA);
  const changed = edit(o, (x) => { x.title = '直した'; }, TB);
  const q = mt(o, a, changed);
  assert.deepEqual(q.f, ['trash']);
  assert.equal(mt(o, a, changed, 'a').c.deletedAt, TA); // ゴミ箱のまま (the change is kept inside)
  assert.equal(mt(o, a, changed, 'a').c.title, '直した');
  assert.equal(mt(o, a, changed, 'b').c.deletedAt, null); // 戻して残す
  // moving it in the list is not "changing" it
  const moved = edit(o, (x) => { x.order = -5; }, TB);
  assert.deepEqual(mt(o, a, moved).f, []);
  assert.equal(mt(o, a, moved).c.deletedAt, TA);
  // taken back out of the trash on one side
  assert.equal(mt(a, a, edit(a, (x) => { x.deletedAt = null; }, TB)).c.deletedAt, null);
});

test('completely deleted (mark): both -> deleted; ★ deleted on one side and changed on the other -> asked; the points stay', () => {
  const done = edit(baseTask(), (x) => { completeTask(x, TODAY, T0); x.xpSteps = ['s1']; }, T0);
  const pa = edit(done, (x) => { x.deletedAt = TA; purgeTask(x, TA); }, TA);
  const pb = edit(done, (x) => { x.deletedAt = TB; purgeTask(x, TB); }, TB);
  const both = mt(done, pa, pb);
  assert.deepEqual(both.f, []);
  assert.equal(both.c.purgedAt, TA);
  assert.equal(both.c.title, '（消したタスク）');
  assert.deepEqual(countXp([cleanContent('task:t1', both.c)]), countXp([done]));
  // untouched on the other side: deleted
  const auto = mt(done, pa, done);
  assert.deepEqual(auto.f, []);
  assert.equal(auto.c.purgedAt, TA);
  assert.equal(auto.c.memo, '');
  assert.deepEqual(countXp([cleanContent('task:t1', auto.c)]), countXp([done]));
  // ★ changed on the other side
  const changed = edit(done, (x) => { x.memo = '大事なメモ'; }, TB);
  const q = mt(done, pa, changed);
  assert.deepEqual(q.f, ['purged']);
  assert.equal(mt(done, pa, changed, 'a').c.purgedAt, TA); // 消す
  assert.equal(mt(done, pa, changed, 'a').c.memo, '');
  const keep = mt(done, pa, changed, 'b').c; // 残す
  assert.equal(keep.purgedAt, null);
  assert.equal(keep.memo, '大事なメモ');
  assert.equal(keep.title, '研修資料の改訂');
  // an answer "残す" made after a mark is not undone by the mark
  assert.equal(mt(pa, pa, cleanContent('task:t1', keep)).c.purgedAt, null);
});

test('decided automatically: the order (newer), the "back from the box" mark (removed wins), points of steps (joined), created (older) / updated (newer)', () => {
  const o = edit(baseTask(), (x) => { x.returnedMark = true; x.xpSteps = ['s1']; }, T0);
  const a = edit(o, (x) => { x.order = 5; x.returnedMark = false; x.xpSteps = ['s1', 's2']; x.createdAt = '2026-10-19T00:00:00.000Z'; }, TA);
  const b = edit(o, (x) => { x.order = 7; x.xpSteps = ['s1', 's3']; }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, []);
  assert.equal(r.c.order, 7); // the newer side
  assert.equal(r.c.returnedMark, false);
  assert.deepEqual(r.c.xpSteps, ['s1', 's2', 's3']); // the same step once
  assert.equal(r.c.createdAt, '2026-10-19T00:00:00.000Z');
  assert.equal(r.c.updatedAt, TB);
  // at most 5 steps per task earn points
  const many = edit(o, (x) => { x.xpSteps = ['a', 'b', 'c', 'd', 'e']; }, TA);
  const more = edit(o, (x) => { x.xpSteps = ['f', 'g']; }, TB);
  assert.equal(mt(o, many, more).c.xpSteps.length, 5);
});

test('both devices bring the same task back from the later box on the same day: no question', () => {
  const o = edit(baseTask(), (x) => { parkTask(x, '2026-10-20', T0); }, T0);
  const a = edit(o, (x) => { unparkTask(x, [x], true, TA); x.order = -1; }, TA);
  const b = edit(o, (x) => { unparkTask(x, [x], true, TB); x.order = -3; }, TB);
  const r = mt(o, a, b);
  assert.deepEqual(r.f, []);
  assert.equal(r.c.parked, false);
  assert.equal(r.c.returnedMark, true);
  assert.equal(r.c.order, -3);
});

test('the same inputs always give the same result (two devices merging at once make the same version)', () => {
  const o = baseTask();
  const a = edit(o, (x) => { x.title = 'A'; x.route.push(step('a1', 'confirm', 'p5', '')); }, TA);
  const b = edit(o, (x) => { x.due = '2026-10-30'; x.route.splice(0, 1); }, TB);
  assert.equal(canonical(mt(o, a, b).c), canonical(mt(structuredClone(o), structuredClone(a), structuredClone(b)).c));
});

// ---------------------------------------------------------------- memos and people

function memo(text, extra) {
  return cleanContent('memo:m1', Object.assign({ id: 'm1', text, createdAt: T0, taskId: null, deletedAt: null, purgedAt: null }, extra));
}

test('memo: the text is asked; the link to a task: the side that has one; ★ trash or delete on one side and the text changed on the other', () => {
  const o = memo('元のメモ');
  const opt = (prefer) => ({ aName: NA, bName: NB, prefer });
  const a = memo('Aで直した');
  const b = memo('Bで直した');
  assert.deepEqual(mergeItem('memo:m1', o, a, b, opt()).conflicts.map((c) => c.field), ['text']);
  assert.equal(mergeItem('memo:m1', o, a, o, opt()).content.text, 'Aで直した');
  const linked = memo('元のメモ', { taskId: 'task-9' });
  const r = mergeItem('memo:m1', o, linked, b, opt());
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.content.taskId, 'task-9');
  assert.equal(r.content.text, 'Bで直した');
  const trashed = memo('元のメモ', { deletedAt: TA });
  assert.deepEqual(mergeItem('memo:m1', o, trashed, b, opt()).conflicts.map((c) => c.field), ['trash']);
  assert.equal(mergeItem('memo:m1', o, trashed, linked, opt()).content.deletedAt, TA); // linking is not a change of the text
  const purged = structuredClone(trashed);
  purgeMemo(purged, TA);
  assert.deepEqual(mergeItem('memo:m1', o, cleanContent('memo:m1', purged), b, opt()).conflicts.map((c) => c.field), ['purged']);
  assert.equal(mergeItem('memo:m1', o, cleanContent('memo:m1', purged), o, opt()).content.purgedAt, TA);
  assert.equal(mergeItem('memo:m1', o, cleanContent('memo:m1', purged), b, opt('b')).content.text, 'Bで直した');
});

test('people: name, group and icon one by one; ★ deleted on one side and changed on the other', () => {
  const p = (extra) => cleanContent('person:p1', Object.assign(newPerson('経理部', 'dept', 'cash'), { id: 'p1' }, extra));
  const o = p({});
  const opt = { aName: NA, bName: NB };
  const r = mergeItem('person:p1', o, p({ name: '経理' }), p({ group: 'team' }), opt);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.content.name, '経理');
  assert.equal(r.content.group, 'team');
  assert.equal(r.content.initial, '経');
  assert.deepEqual(mergeItem('person:p1', o, p({ name: '経理' }), p({ name: '財務' }), opt).conflicts.map((c) => c.field), ['name']);
  assert.deepEqual(mergeItem('person:p1', o, p({ deletedAt: TA }), p({ name: '財務' }), opt).conflicts.map((c) => c.field), ['deleted']);
  assert.equal(mergeItem('person:p1', o, p({ deletedAt: TA }), o, opt).content.deletedAt, TA);
});

// ---------------------------------------------------------------- goals (the examples of 7-5)

function goal(lines) {
  return cleanContent('goal:week:2026-10-19', { lines });
}

function mg(o, a, b, opt = {}) {
  const r = mergeItem('goal:week:2026-10-19', o ? goal(o) : null, goal(a), goal(b), Object.assign({ aName: NA, bName: NB }, opt));
  return { lines: r.content.lines, f: r.conflicts.map((c) => c.field) };
}

test('goals, the examples of 7-5 (before: A, B, C)', () => {
  const O = ['A', 'B', 'C'];
  assert.deepEqual(mg(O, ['A2', 'B', 'C'], ['A', 'B2', 'C']), { lines: ['A2', 'B2', 'C'], f: [] });
  assert.deepEqual(mg(O, ['A2', 'B', 'C'], ['A', 'X', 'B', 'C']), { lines: ['A2', 'X', 'B', 'C'], f: [] });
  assert.deepEqual(mg(O, ['A', 'B', 'C', 'P'], ['A', 'B', 'C', 'Q']), { lines: ['A', 'B', 'C', 'P', 'Q'], f: [] });
  // the order of lines added at the same place follows the version names
  assert.deepEqual(mg(O, ['A', 'B', 'C', 'P'], ['A', 'B', 'C', 'Q'], { aName: NB, bName: NA }).lines, ['A', 'B', 'C', 'Q', 'P']);
  assert.deepEqual(mg(O, ['A2', 'B', 'C'], ['A3', 'B', 'C']).f, ['line.0']);
  assert.deepEqual(mg(O, ['B', 'C'], ['A3', 'B', 'C']).f, ['line.0']); // ★ deleted / rewritten
  const ten = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const over = mg(ten, ten.concat(['a1', 'a2']), ten.concat(['b1']));
  assert.deepEqual(over.f, ['over']); // ★ 11 lines together
  assert.equal(mg(ten, ten.concat(['a1', 'a2']), ten.concat(['b1']), { prefer: 'a' }).lines.length, 10);
  // both deleted the same line / both added the same line: no question, once
  assert.deepEqual(mg(O, ['A', 'C'], ['A', 'C']), { lines: ['A', 'C'], f: [] });
  assert.deepEqual(mg(O, ['A', 'C'], ['A', 'B', 'C', 'N']), { lines: ['A', 'C', 'N'], f: [] });
  assert.deepEqual(mg(O, ['A', 'B', 'C', 'N'], ['A', 'B', 'C', 'N']).lines, ['A', 'B', 'C', 'N']);
  // made on both devices before they ever synced (no common version): both kept
  assert.deepEqual(mg(null, ['P'], ['Q']), { lines: ['P', 'Q'], f: [] });
});

test('lines of one side: kept, rewritten, deleted, added after a line', () => {
  const r = lineFates(['A', 'B', 'C'], ['A2', 'B', 'X', 'Y']);
  assert.deepEqual(r.fate, [{ t: 'rep', text: 'A2' }, { t: 'keep' }, { t: 'rep', text: 'X' }]);
  assert.deepEqual([...r.ins], [[2, ['Y']]]);
  assert.deepEqual(mergeOrder(['x', 'y'], ['x', 'y', 'a'], ['n', 'x', 'y', 'b'], new Set(['x', 'y', 'a', 'n', 'b']), 'a'), ['n', 'x', 'y', 'a', 'b']);
});

// ---------------------------------------------------------------- schedule (lines with ids)

function day(lines) {
  return cleanContent('schedule:2026-10-20', { lines: lines.map(([id, text]) => ({ id, text })) });
}

function ms(o, a, b, prefer) {
  const r = mergeItem('schedule:2026-10-20', o ? day(o) : null, day(a), day(b), { aName: NA, bName: NB, prefer });
  return { lines: r.content.lines.map((l) => l.id + ':' + l.text), f: r.conflicts.map((c) => c.field) };
}

test('schedule: lines added on both sides stay where each side wrote them; removed lines go; the same line differently -> asked', () => {
  const O = [['l1', '9:00 朝礼'], ['l2', '13:00 MTG']];
  assert.deepEqual(ms(O, [['l1', '9:00 朝礼'], ['a1', '10:00 電話'], ['l2', '13:00 MTG']], [['l1', '9:00 朝礼'], ['l2', '13:00 MTG'], ['b1', '17:00 日報']]),
    { lines: ['l1:9:00 朝礼', 'a1:10:00 電話', 'l2:13:00 MTG', 'b1:17:00 日報'], f: [] });
  assert.deepEqual(ms(O, [['l2', '13:00 MTG']], O), { lines: ['l2:13:00 MTG'], f: [] });
  assert.deepEqual(ms(O, [['l1', '9:30 朝礼'], ['l2', '13:00 MTG']], [['l1', '9:15 朝礼'], ['l2', '13:00 MTG']]).f, ['line.l1']);
  // ★ removed on one side, rewritten on the other
  const q = ms(O, [['l2', '13:00 MTG']], [['l1', '9:15 朝礼'], ['l2', '13:00 MTG']]);
  assert.deepEqual(q.f, ['line.l1']);
  assert.deepEqual(ms(O, [['l2', '13:00 MTG']], [['l1', '9:15 朝礼'], ['l2', '13:00 MTG']], 'a').lines, ['l2:13:00 MTG']);
  // moved: the newer side's order
  assert.deepEqual(ms(O, [['l2', '13:00 MTG'], ['l1', '9:00 朝礼']], O).lines, ['l2:13:00 MTG', 'l1:9:00 朝礼']);
  // ★ more than 30 lines together
  const many = (p, n) => Array.from({ length: n }, (_, i) => [p + i, p + i]);
  assert.deepEqual(ms([], many('a', 20), many('b', 11)).f, ['over']);
  assert.equal(ms([], many('a', 20), many('b', 11), 'b').lines.length, 11);
});

test('the dragon name: asked when both changed it differently, taken when one side did', () => {
  const o = { name: 'アオ' };
  const opt = { aName: NA, bName: NB };
  assert.deepEqual(mergeItem('dragon:name', o, { name: 'ソラ' }, { name: 'リュウ' }, opt).conflicts.map((c) => c.field), ['name']);
  assert.equal(mergeItem('dragon:name', o, { name: 'ソラ' }, o, opt).content.name, 'ソラ');
  assert.deepEqual(mergeItem('dragon:name', null, { name: 'ソラ' }, { name: 'ソラ' }, opt).conflicts, []);
});
