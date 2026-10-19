import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDragon, settle, countXp, jstDate, level, stageIndex, progress, xpForCompletion, dragonShapes, STAGES, XP_RULES,
} from '../public/js/dragon.js';
import {
  newTask, addStep, removeStep, setStepState, collectStepXp, completeTask, uncompleteTask, trashTask, restoreTask, purgeTask,
} from '../public/js/tasks.js';

const AT = '2026-10-19T09:00:00.000Z';
const TODAY = '2026-10-19';

/** A plain record for countXp: no add points unless a creation time is given. */
function rec(fields) {
  return Object.assign({ status: 'todo', xpGiven: 0, xpBucket: null, xpSteps: [], xpStepsLegacy: 0, createdAt: '' }, fields);
}

test('stages and levels', () => {
  assert.equal(stageIndex(0), 0);
  assert.equal(stageIndex(49), 0);
  assert.equal(stageIndex(50), 1);
  assert.equal(stageIndex(300), 2);
  assert.equal(stageIndex(1000), 3);
  assert.equal(stageIndex(3000), 4);
  assert.equal(STAGES[1].name, 'ちび竜');
  assert.equal(level(0), 1);
  assert.equal(level(5), 2);
  assert.equal(level(20), 3);
  assert.equal(level(245), 8);
  const p = progress(68);
  assert.equal(p.name, 'ちび竜');
  assert.equal(p.next, '若竜');
  assert.equal(p.remaining, 232);
});

test('reaching 50 evolves into the second stage', () => {
  const d = newDragon();
  const tasks = [rec({ status: 'done', xpGiven: 49, xpBucket: 'B' })];
  assert.equal(settle(d, tasks, 't', AT).evolvedTo, -1);
  tasks.push(rec({ status: 'done', xpGiven: 1, xpBucket: 'B' }));
  const r = settle(d, tasks, 't', AT);
  assert.equal(r.evolvedTo, 1);
  assert.equal(r.applied, 1);
  assert.equal(progress(d.total).name, 'ちび竜');
});

test('adding gives +1 up to 10 a day by the date in Japan time; a new day starts again', () => {
  const tasks = [];
  for (let i = 0; i < 12; i += 1) tasks.push(rec({ createdAt: '2026-10-19T01:00:00.000Z' })); // 10/19 10:00 in Japan
  assert.equal(countXp(tasks).other, 10);
  tasks.push(rec({ createdAt: '2026-10-19T15:30:00.000Z' })); // 10/20 00:30 in Japan (still 10/19 in UTC)
  assert.equal(countXp(tasks).other, 11);
  assert.equal(jstDate('2026-10-19T14:59:59.000Z'), '2026-10-19');
  assert.equal(jstDate('2026-10-19T15:00:00.000Z'), '2026-10-20');
  assert.equal(jstDate('not a time'), '');
});

test('early morning in Japan (UTC previous day) is counted on the Japanese date', () => {
  // ten tasks at 08:30 in Japan on 10/20 are 23:30 UTC on 10/19, ten more in the evening of 10/19 in Japan
  const tasks = [];
  for (let i = 0; i < 10; i += 1) tasks.push(rec({ createdAt: '2026-10-19T23:30:00.000Z' }));
  for (let i = 0; i < 10; i += 1) tasks.push(rec({ createdAt: '2026-10-19T11:00:00.000Z' }));
  assert.equal(countXp(tasks).other, 20); // two Japanese days, 10 each (one UTC day would have given 10)
});

test('settle writes only the changes to the recent list, and only when given a reason', () => {
  const d = newDragon();
  const tasks = [rec({ status: 'done', xpGiven: 23, xpBucket: 'A', createdAt: AT })];
  settle(d, tasks, null, AT);
  assert.equal(d.log.length, 0);
  assert.deepEqual(d.xp, { A: 23, B: 0, C: 0, other: 1 });
  tasks.push(rec({ createdAt: AT }));
  const r = settle(d, tasks, '追加', AT);
  assert.equal(r.applied, 1);
  assert.deepEqual(d.log, [{ at: AT, delta: 1, reason: '追加', bucket: 'other' }]);
  assert.equal(settle(d, tasks, '追加', AT).applied, 0);
  assert.equal(d.log.length, 1);
});

test('completion points', () => {
  assert.deepEqual(xpForCompletion({ rank: 'A', due: '2026-10-19' }, '2026-10-19'), { amount: 23, bucket: 'A', base: 20, onTime: 3 });
  assert.equal(xpForCompletion({ rank: 'C', due: null }, '2026-10-19').amount, 5);
  assert.equal(xpForCompletion({ rank: null, due: null }, '2026-10-19').bucket, 'other');
});

test('the trash and completely deleting never take points away', () => {
  const d = newDragon();
  const t = newTask({ title: 'a', rank: 'A', due: TODAY }, AT, 0);
  addStep(t, 'confirm', 'boss', '');
  setStepState(t, t.route[0].id, 'done', TODAY);
  collectStepXp(t);
  completeTask(t, TODAY, AT);
  const tasks = [t];
  settle(d, tasks, null, AT);
  assert.equal(d.total, 23 + 2 + 1);
  trashTask(t, AT);
  assert.equal(settle(d, tasks, null, AT).applied, 0);
  purgeTask(t, AT);
  assert.equal(settle(d, tasks, null, AT).applied, 0);
  assert.equal(d.total, 26);
});

test('the same step done on two devices counts once', () => {
  const t = newTask({ title: 'a' }, AT, 0);
  const s = addStep(t, 'confirm', 'boss', '');
  setStepState(t, s.id, 'done', TODAY);
  const copy = structuredClone(t);
  collectStepXp(t);
  collectStepXp(copy);
  // both devices recorded the same step id: joined, it is still one step
  const joined = Object.assign(structuredClone(t), { xpSteps: [...new Set([...t.xpSteps, ...copy.xpSteps])] });
  assert.equal(countXp([joined]).other - 1, XP_RULES.step);
});

// A small pseudo-random generator, so a failure can be repeated with the same seed.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

test('random phase-1 operations: the points recorded as they came equal the points counted from the records', () => {
  for (const seed of [1, 7, 42, 2026, 31337]) {
    const rand = rng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const d = newDragon();
    const tasks = [];
    const perDay = new Map(); // what phase 1 did by hand: +1 per add while the day had fewer than 10
    let recorded = 0;
    let ms = Date.parse('2026-10-18T20:00:00.000Z'); // 10/19 05:00 in Japan: early mornings are included
    for (let i = 0; i < 400; i += 1) {
      ms += Math.floor(rand() * 3) * 60 * 60 * 1000; // 0-2 hours later
      const at = new Date(ms).toISOString();
      const today = jstDate(at);
      const live = tasks.filter((t) => !t.deletedAt);
      const op = rand();
      if (op < 0.3 || !live.length) {
        const t = newTask({ title: 't' + i, rank: pick(['A', 'B', 'C', null]), due: rand() < 0.5 ? today : null }, at, tasks.length);
        tasks.push(t);
        const n = perDay.get(today) || 0;
        if (n < XP_RULES.addPerDay) recorded += 1;
        perDay.set(today, n + 1);
      } else if (op < 0.45) {
        const t = pick(live);
        const r = completeTask(t, today, at);
        if (r) recorded += r.amount;
      } else if (op < 0.55) {
        const t = pick(live);
        const r = uncompleteTask(t, at);
        if (r) recorded += r.amount;
      } else if (op < 0.75) {
        const t = pick(live);
        if (t.route.length < 5) addStep(t, 'confirm', 'boss', '');
        const s = pick(t.route);
        setStepState(t, s.id, rand() < 0.7 ? 'done' : 'todo', today);
        recorded += collectStepXp(t);
      } else if (op < 0.82) {
        const t = pick(live);
        if (t.route.length) removeStep(t, pick(t.route).id);
      } else if (op < 0.9) {
        trashTask(pick(live), at);
      } else if (op < 0.95) {
        const gone = tasks.filter((t) => t.deletedAt && !t.purgedAt);
        if (gone.length) restoreTask(pick(gone), at);
      } else {
        const gone = tasks.filter((t) => t.deletedAt && !t.purgedAt);
        if (gone.length) purgeTask(pick(gone), at);
      }
      const before = d.total;
      const r = settle(d, tasks, 'op', at);
      assert.equal(r.applied, d.total - before);
      assert.equal(d.total, recorded, 'seed ' + seed + ' step ' + i);
    }
    assert.ok(recorded > 100, 'seed ' + seed + ' reached ' + recorded);
  }
});

test('every stage has shapes, and only simple SVG elements are used', () => {
  const allowed = new Set(['ellipse', 'circle', 'polyline', 'polygon', 'path', 'rect', 'g']);
  for (let s = 0; s < 5; s += 1) {
    let leaves = 0;
    const walk = (list) => list.forEach(([tag, , kids]) => {
      assert.ok(allowed.has(tag), tag);
      if (kids) walk(kids); else leaves += 1;
    });
    walk(dragonShapes(s));
    assert.ok(leaves > 5, 'stage ' + s + ' has ' + leaves + ' shapes');
  }
});
