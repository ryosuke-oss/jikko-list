import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine, parseDateWord, withTokenAsTitle, withSuggestedStep, lineError, parseBulk, stripBullet, pastedLines,
  signatures, missingFields, dueWord, withFieldWord, placeFieldWord, DURATION_WORD, REQUIRED,
} from '../public/js/parse.js';
import { addDays } from '../public/js/util.js';

// 2026-10-19 is a Monday.
const TODAY = '2026-10-19';
const PEOPLE = [
  { id: 'boss', name: '上司' },
  { id: 'team', name: '部署内' },
  { id: 'acc', name: '経理部' },
  { id: 'edu', name: '教育部' },
  { id: 'ext', name: '社外（取引先）' },
];
const opts = { today: TODAY, people: PEOPLE };

test('example 1: title, nearest Friday, rank B, one request step', () => {
  const r = parseLine('案内文の作成 金曜 B 経理部に依頼', opts);
  assert.equal(r.title, '案内文の作成');
  assert.equal(r.due, '2026-10-23');
  assert.equal(r.rank, 'B');
  assert.deepEqual(r.steps, [{ kind: 'request', whoId: 'acc', note: '' }]);
  assert.equal(r.duration, null);
  assert.equal(r.star, false);
});

test('punctuation from voice input splits words the same way', () => {
  const a = parseLine('案内文の作成 金曜 B 経理部に依頼', opts);
  const b = parseLine('案内文の作成、金曜、B、経理部に依頼。', opts);
  for (const k of ['title', 'due', 'rank', 'duration', 'star']) assert.equal(b[k], a[k], k);
  assert.deepEqual(b.steps, a.steps);
});

test('example 2: duration 3日 and a confirm step', () => {
  const r = parseLine('研修資料の改訂 木曜 B 3日 教育部に確認', opts);
  assert.equal(r.title, '研修資料の改訂');
  assert.equal(r.due, '2026-10-22');
  assert.equal(r.rank, 'B');
  assert.equal(r.duration, '3d');
  assert.deepEqual(r.steps, [{ kind: 'confirm', whoId: 'edu', note: '' }]);
});

test('full-width and lower-case ranks, full-width spaces', () => {
  assert.equal(parseLine('資料　Ａ', opts).rank, 'A');
  assert.equal(parseLine('資料 c', opts).rank, 'C');
  assert.equal(parseLine('資料　ｂ', opts).rank, 'B');
});

test('star words', () => {
  assert.equal(parseLine('資料 ★', opts).star, true);
  assert.equal(parseLine('資料 ☆', opts).star, true);
  assert.equal(parseLine('資料 重要', opts).star, true);
  assert.equal(parseLine('重要な資料', opts).star, false);
});

test('duration words', () => {
  const d = (w) => parseLine('資料 ' + w, opts).duration;
  assert.equal(d('1日'), '1d');
  assert.equal(d('3日'), '3d');
  assert.equal(d('1週間'), '1w');
  assert.equal(d('一週間'), '1w');
  assert.equal(d('1週'), '1w');
  assert.equal(d('1ヶ月'), '1m');
  assert.equal(d('1か月'), '1m');
  assert.equal(d('1カ月'), '1m');
  assert.equal(d('ひと月'), '1m');
  assert.equal(d('１週間'), '1w');
});

test('relative dates and weekdays (today counts as the nearest)', () => {
  assert.equal(parseDateWord('今日', TODAY), '2026-10-19');
  assert.equal(parseDateWord('明日', TODAY), '2026-10-20');
  assert.equal(parseDateWord('明後日', TODAY), '2026-10-21');
  assert.equal(parseDateWord('あさって', TODAY), '2026-10-21');
  assert.equal(parseDateWord('月曜', TODAY), '2026-10-19');
  assert.equal(parseDateWord('金曜日', TODAY), '2026-10-23');
  assert.equal(parseDateWord('金', TODAY), '2026-10-23');
  assert.equal(parseDateWord('日曜', TODAY), '2026-10-25');
  assert.equal(parseDateWord('来週月曜', TODAY), '2026-10-26');
  assert.equal(parseDateWord('来週金曜', TODAY), '2026-10-30');
  // On a Friday, "金曜" is that same day.
  assert.equal(parseDateWord('金曜', '2026-10-23'), '2026-10-23');
  // On a Saturday, "金曜" is the next Friday.
  assert.equal(parseDateWord('金曜', '2026-10-24'), '2026-10-30');
});

test('M/D and M月D日; a date that already passed means next year', () => {
  assert.equal(parseDateWord('10/23', TODAY), '2026-10-23');
  assert.equal(parseDateWord('10月23日', TODAY), '2026-10-23');
  assert.equal(parseDateWord('１０／２３', TODAY), '2026-10-23');
  assert.equal(parseDateWord('10/19', TODAY), '2026-10-19');
  assert.equal(parseDateWord('1/5', TODAY), '2027-01-05');
  assert.equal(parseDateWord('2/30', TODAY), null);
  const r = parseLine('棚の整理 1/5', opts);
  assert.equal(r.due, '2027-01-05');
  assert.equal(r.dueOtherYear, true);
  assert.equal(parseLine('棚の整理 10/23', opts).dueOtherYear, false);
});

test('several people become steps in order; kinds from the words', () => {
  const r = parseLine('見積の確認 部署内に確認 上司に方向性確認 社外に連絡', opts);
  assert.equal(r.title, '見積の確認');
  assert.deepEqual(r.steps, [
    { kind: 'confirm', whoId: 'team', note: '' },
    { kind: 'confirm', whoId: 'boss', note: '方向性確認' },
    { kind: 'reply', whoId: 'ext', note: '' },
  ]);
  assert.equal(parseLine('案内 取引先に返信', opts).steps[0].whoId, 'ext');
});

test('at most 5 steps; the rest stays in the title', () => {
  const r = parseLine('件名 上司 上司 上司 上司 上司 上司', opts);
  assert.equal(r.steps.length, 5);
  assert.equal(r.title, '件名 上司');
});

test('only the first rank / date / duration counts, later ones stay in the title', () => {
  const r = parseLine('件名 A B 金曜 月曜 1日 3日', opts);
  assert.equal(r.rank, 'A');
  assert.equal(r.due, '2026-10-23');
  assert.equal(r.duration, '1d');
  assert.equal(r.title, '件名 B 月曜 3日');
});

test('removing a chip puts the word back into the title', () => {
  const r = parseLine('B 案内文', opts);
  assert.equal(r.rank, 'B');
  const i = r.tokens.findIndex((t) => t.type === 'rank');
  const r2 = withTokenAsTitle(r, i, TODAY);
  assert.equal(r2.rank, null);
  assert.equal(r2.title, 'B 案内文');
});

test('suggested step can be added and removed without touching the title', () => {
  const r = parseLine('方針案 A', opts);
  const r2 = withSuggestedStep(r, { kind: 'confirm', whoId: 'boss', note: '方向性確認' }, TODAY);
  assert.equal(r2.steps.length, 1);
  assert.equal(r2.title, '方針案');
  const i = r2.tokens.findIndex((t) => t.synthetic);
  const r3 = withTokenAsTitle(r2, i, TODAY);
  assert.equal(r3.steps.length, 0);
  assert.equal(r3.title, '方針案');
});

test('errors: empty title and too long title', () => {
  assert.match(lineError(parseLine('B 金曜', opts)), /タスク名がありません/);
  assert.equal(lineError(parseLine('ok', opts)), '');
  assert.match(lineError(parseLine('あ'.repeat(121), opts)), /120字/);
  assert.equal(lineError(parseLine('あ'.repeat(120), opts)), '');
});

test('bullets are removed from pasted lines; blank lines are skipped', () => {
  assert.equal(stripBullet('- 資料の作成'), '資料の作成');
  assert.equal(stripBullet('・資料の作成'), '資料の作成');
  assert.equal(stripBullet('□ 資料の作成'), '資料の作成');
  assert.equal(stripBullet('1. 資料の作成'), '資料の作成');
  assert.equal(stripBullet('- [ ] 資料の作成'), '資料の作成');
  assert.equal(stripBullet('10/23 資料'), '10/23 資料');
  assert.equal(stripBullet('3.5時間の作業'), '3.5時間の作業');
  const text = '・一つ目 A\n\n・二つ目 金曜\n・三つ目\n  \n・四つ目 C\n・五つ目 経理部に依頼\n';
  assert.equal(pastedLines(text).length, 5);
  const rows = parseBulk(text, opts);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].parsed.rank, 'A');
  assert.equal(rows[4].parsed.steps[0].kind, 'request');
  assert.ok(rows.every((r) => r.error === ''));
});

test('"来週 月曜" / "来週、月曜" / "来週の金曜" are one due date; "総務部に確認" is a step without a stray note', () => {
  const people = PEOPLE.concat([{ id: 'ga', name: '総務' }]);
  const o = { today: TODAY, people };
  for (const s of ['資料 来週 月曜', '資料、来週、月曜', '資料 来週月曜']) {
    const r = parseLine(s, o);
    assert.equal(r.due, '2026-10-26', s);
    assert.equal(r.title, '資料', s);
  }
  assert.equal(parseLine('資料 来週の金曜', o).due, '2026-10-30');
  assert.deepEqual(parseLine('備品 総務部に確認', o).steps, [{ kind: 'confirm', whoId: 'ga', note: '' }]);
  // removing the joined date chip gives both words back to the title
  const r = parseLine('資料 来週 月曜', o);
  const i = r.tokens.findIndex((t) => t.type === 'due');
  assert.equal(withTokenAsTitle(r, i, TODAY).title, '資料 来週 月曜');
});

// ---------------------------------------------------------------- 2026-10-27: 期日・ランク・所要期間 are needed to add

test('a new task needs 期日・ランク・所要期間 besides its name (what is missing, in that order)', () => {
  assert.deepEqual(REQUIRED.map((f) => f.key), ['due', 'rank', 'duration']);
  assert.deepEqual(missingFields(parseLine('研修資料の改訂', opts)), ['期日', 'ランク', '所要期間']);
  assert.deepEqual(missingFields(parseLine('研修資料の改訂 木曜 B', opts)), ['所要期間']);
  assert.deepEqual(missingFields(parseLine('研修資料の改訂 木曜 B 3日 教育部に確認', opts)), []);
  assert.deepEqual(missingFields(null), ['期日', 'ランク', '所要期間']);
  // the line itself is still fine without them (the bulk sheet fills them from its own buttons)
  assert.equal(lineError(parseLine('研修資料の改訂', opts)), '');
});

test('the word a button writes for a due date is the date itself, read back as the same day (a year around today)', () => {
  assert.equal(dueWord(TODAY, TODAY), '10/19'); // not 今日: a line left past midnight keeps the chosen day
  assert.equal(dueWord('2026-10-20', TODAY), '10/20');
  assert.equal(dueWord('2026-10-30', TODAY), '10/30');
  assert.equal(dueWord('0202-11-06', TODAY), null); // a year typed halfway: nothing is written
  assert.equal(dueWord('2026-02-30', TODAY), null);
  assert.equal(dueWord('2026-10-18', TODAY), '2026/10/18'); // yesterday: M/D would mean next year
  assert.equal(dueWord('2027-10-19', TODAY), '2027/10/19'); // a year ahead: M/D would mean today
  for (let i = -400; i <= 400; i += 1) {
    const d = addDays(TODAY, i);
    assert.equal(parseDateWord(dueWord(d, TODAY), TODAY), d, d);
  }
  for (const [value, word] of Object.entries(DURATION_WORD)) assert.equal(parseLine('資料 ' + word, opts).duration, value, word);
});

test('a button replaces the word read for that field, or adds its word at the end', () => {
  assert.equal(withFieldWord('研修資料の改訂', 'due', '明日', opts), '研修資料の改訂 明日');
  assert.equal(withFieldWord('資料 木曜 B', 'rank', 'A', opts), '資料 木曜 A');
  assert.equal(withFieldWord('資料 木曜 B', 'duration', '1週間', opts), '資料 木曜 B 1週間');
  assert.equal(withFieldWord('資料、来週、月曜', 'due', '金曜', opts), '資料 金曜'); // the joined date words go together
  // the three buttons one after the other: the task can be added, the name is untouched
  let line = '見積の確認 経理部に依頼';
  line = withFieldWord(line, 'due', dueWord('2026-10-23', TODAY), opts);
  line = withFieldWord(line, 'rank', 'C', opts);
  line = withFieldWord(line, 'duration', DURATION_WORD['3d'], opts);
  const r = parseLine(line, opts);
  assert.deepEqual([r.title, r.due, r.rank, r.duration, r.steps.length], ['見積の確認', '2026-10-23', 'C', '3d', 1]);
  assert.deepEqual(missingFields(r), []);
  // choosing again replaces (never two date words in the line)
  assert.equal(withFieldWord(line, 'due', '明日', opts), '見積の確認 経理部に依頼 明日 C 3日');
  // where the word went, and where every other word came from (the app keeps the marks on the same words)
  assert.deepEqual(placeFieldWord(parseLine('B 資料 B', opts).tokens, 'rank', 'C'), { raws: ['C', '資料', 'B'], from: [-1, 1, 2], index: 0 });
  assert.deepEqual(placeFieldWord(parseLine('資料', opts).tokens, 'duration', '1日'), { raws: ['資料', '1日'], from: [0, -1], index: 1 });
});

test('a word turned back into the title stays there, and a later word (or a button) can still set that field', () => {
  assert.deepEqual(signatures(['B', '案内', 'B']), ['B#1', '案内#1', 'B#2']);
  // "B" at the start is part of the name; the B at the end is the rank
  const o = Object.assign({}, opts, { removed: new Set(['B#1']) });
  const r = parseLine('B 案内 B', o);
  assert.deepEqual([r.title, r.rank], ['B 案内', 'B']);
  // "明日" is part of the name ("明日の準備" typed with a space): the button adds its own date word
  const o2 = Object.assign({}, opts, { removed: new Set(['明日#1']) });
  const line = withFieldWord('明日 準備', 'due', '金曜', o2);
  assert.equal(line, '明日 準備 金曜');
  const r2 = parseLine(line, o2);
  assert.deepEqual([r2.title, r2.due], ['明日 準備', '2026-10-23']);
  // without anything removed, nothing changes from before
  assert.deepEqual(parseLine('件名 A B 金曜 月曜 1日 3日', opts), parseLine('件名 A B 金曜 月曜 1日 3日', Object.assign({}, opts, { removed: new Set() })));
});
