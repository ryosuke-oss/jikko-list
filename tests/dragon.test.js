import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDragon, grant, grantAdd, level, stageIndex, progress, xpForCompletion, dragonShapes, STAGES } from '../public/js/dragon.js';

const AT = '2026-10-19T09:00:00.000Z';

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
  assert.equal(grant(d, 'B', 49, 't', AT).evolvedTo, -1);
  assert.equal(grant(d, 'B', 1, 't', AT).evolvedTo, 1);
  assert.equal(progress(d.total).name, 'ちび竜');
});

test('adding gives +1 up to 10 times a day, then stops; a new day starts again', () => {
  const d = newDragon();
  for (let i = 0; i < 12; i += 1) grantAdd(d, '2026-10-19', AT);
  assert.equal(d.xp.other, 10);
  assert.equal(grantAdd(d, '2026-10-19', AT).applied, 0);
  assert.equal(grantAdd(d, '2026-10-20', AT).applied, 1);
  assert.equal(d.total, 11);
});

test('taking back never goes below zero', () => {
  const d = newDragon();
  grant(d, 'A', 5, 't', AT);
  const r = grant(d, 'A', -20, 't', AT);
  assert.equal(r.applied, -5);
  assert.equal(d.xp.A, 0);
});

test('completion points', () => {
  assert.deepEqual(xpForCompletion({ rank: 'A', due: '2026-10-19' }, '2026-10-19'), { amount: 23, bucket: 'A', base: 20, onTime: 3 });
  assert.equal(xpForCompletion({ rank: 'C', due: null }, '2026-10-19').amount, 5);
  assert.equal(xpForCompletion({ rank: null, due: null }, '2026-10-19').bucket, 'other');
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
