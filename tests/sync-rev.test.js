import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical, sha256hex, fingerprint, versionName, checkVersion, parseVersion, compareVersions, nextGen,
  normParents, tips, ancestors, mergeBase, contentHash,
} from '../public/js/sync/rev.js';

test('SHA-256 is the standard one (known value) and the fingerprint is its first 16 characters', async () => {
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256hex('実行リスト'), (await sha256hex('実行リスト')));
  const fp = await fingerprint('task:1', [], { a: 1 });
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, (await sha256hex(canonical(['task:1', [], { a: 1 }]))).slice(0, 16));
});

test('the same content gives the same name whatever the order of its fields (a second send is the same version)', async () => {
  const a = { title: 'x', due: null, route: [{ id: 's', note: '' }], links: { web: '', slack: '' } };
  const b = { links: { slack: '', web: '' }, route: [{ note: '', id: 's' }], due: null, title: 'x' };
  assert.equal(canonical(a), canonical(b));
  assert.equal(await versionName('task:t1', [], a), await versionName('task:t1', [], b));
  assert.equal(contentHash(a), contentHash(b));
  // a different key, parent or content gives another name
  const n = await versionName('task:t1', [], a);
  assert.notEqual(await versionName('task:t2', [], a), n);
  assert.notEqual(await versionName('task:t1', ['1-0000000000000000'], a), n);
  assert.notEqual(await versionName('task:t1', [], Object.assign({}, a, { title: 'y' })), n);
  // undefined fields are left out, like JSON
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
});

test('generations: new item 1, a change = parent + 1, a merge or an answer = the largest parent + 1', async () => {
  const v1 = await versionName('memo:m', [], { text: 'a' });
  assert.equal(parseVersion(v1).gen, 1);
  const v2 = await versionName('memo:m', [v1], { text: 'b' });
  assert.equal(parseVersion(v2).gen, 2);
  const v3 = await versionName('memo:m', [v2], { text: 'c' });
  const w2 = await versionName('memo:m', [v1], { text: 'w' });
  const m = await versionName('memo:m', [w2, v3], { text: 'c+w' });
  assert.equal(parseVersion(m).gen, 4);
  assert.equal(nextGen([w2, v3]), 4);
  // the order of the parents never changes the name
  assert.equal(m, await versionName('memo:m', [v3, w2], { text: 'c+w' }));
  assert.deepEqual(normParents([v3, w2, v3]), [w2, v3].sort(compareVersions));
});

test('names are compared by generation as a number ("10-…" comes after "9-…")', () => {
  const a = '9-ffffffffffffffff';
  const b = '10-0000000000000000';
  assert.ok(compareVersions(a, b) < 0);
  assert.ok(compareVersions(b, a) > 0);
  assert.equal(compareVersions(a, a), 0);
  assert.equal(parseVersion('0-0000000000000000'), null);
  assert.equal(parseVersion('3-xyz'), null);
});

test('checking a row: a name that does not match the key, the parents, the generation or the content is refused', async () => {
  const c = { text: 'メモ' };
  const v1 = await versionName('memo:m', [], c);
  const v2 = await versionName('memo:m', [v1], { text: '直した' });
  assert.equal(await checkVersion('memo:m', v1, [], c), true);
  assert.equal(await checkVersion('memo:m', v2, [v1], { text: '直した' }), true);
  assert.equal(await checkVersion('memo:m', v1, [], { text: '手で書き換えた' }), false); // J changed by hand
  assert.equal(await checkVersion('memo:x', v1, [], c), false); // G changed
  assert.equal(await checkVersion('memo:m', v2, [], { text: '直した' }), false); // I changed
  assert.equal(await checkVersion('memo:m', v2.replace(/^2-/, '3-'), [v1], { text: '直した' }), false); // generation
  assert.equal(await checkVersion('memo:m', v2, [v1, v1], { text: '直した' }), false); // the same parent twice
  assert.equal(await checkVersion('memo:m', 'abc', [], c), false);
});

// a small family tree: o -> a1 -> a2, o -> b1; m = merge(a2, b1)
function tree() {
  return {
    o: { p: [] },
    a1: { p: ['o'] },
    a2: { p: ['a1'] },
    b1: { p: ['o'] },
  };
}

test('ends (tips) and ancestors', () => {
  const v = tree();
  assert.deepEqual(tips(v).sort(), ['a2', 'b1']);
  assert.deepEqual([...ancestors(v, 'a2')].sort(), ['a1', 'o']);
  v.m = { p: ['a2', 'b1'] };
  assert.deepEqual(tips(v), ['m']);
  // a parent the device does not know (its row was removed by hand) is no obstacle
  v.x = { p: ['unknown'] };
  assert.deepEqual(tips(v).sort(), ['m', 'x']);
  assert.deepEqual([...ancestors(v, 'x')], []);
});

test('the version before both changes (common ancestor)', () => {
  const v = tree();
  assert.equal(mergeBase(v, 'a2', 'b1'), 'o');
  assert.equal(mergeBase(v, 'a2', 'a1'), 'a1');
  // no common ancestor (rows removed by hand, or both made the item on their own) -> nothing (empty)
  const w = { p1: { p: [] }, p2: { p: [] } };
  assert.equal(mergeBase(w, 'p1', 'p2'), null);
  // two devices answered the same question differently: both answers have the two ends as parents;
  // the comparison goes back to the version before the question, so the difference is asked again
  const q = { o: { p: [] }, a: { p: ['o'] }, b: { p: ['o'] }, ca: { p: ['a', 'b'] }, cb: { p: ['a', 'b'] } };
  assert.deepEqual(tips(q).sort(), ['ca', 'cb']);
  assert.equal(mergeBase(q, 'ca', 'cb'), 'o');
});
