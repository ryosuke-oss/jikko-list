import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGoals, rolloverGoals, periodLabel, periodKey, historyLabel, newSchedule, rolloverSchedule, addScheduleText, splitTime,
} from '../public/js/plan.js';

const AT = '2026-10-19T09:00:00.000Z';

test('period keys and labels (weeks start on Monday)', () => {
  assert.equal(periodKey('week', '2026-10-19'), '2026-10-19');
  assert.equal(periodKey('week', '2026-10-25'), '2026-10-19');
  assert.equal(periodKey('week', '2026-10-26'), '2026-10-26');
  assert.equal(periodLabel('week', '2026-10-19'), '10/19(月)〜10/25(日)');
  assert.equal(periodLabel('month', '2026-10'), '10月');
  assert.equal(periodLabel('year', '2026'), '2026年');
  assert.equal(historyLabel('week', '2026-10-12'), '2026年 10/12〜10/18');
});

test('goals stay inside the same period', () => {
  const g = newGoals('2026-10-19');
  g.week.lines = ['週の目標'];
  const log = [];
  assert.deepEqual(rolloverGoals(g, log, '2026-10-25', AT), []);
  assert.deepEqual(g.week.lines, ['週の目標']);
  assert.equal(log.length, 0);
});

test('next week / month / year: old lines move to the history, nothing is lost', () => {
  const g = newGoals('2026-10-19');
  g.week.lines = ['週1', '週2'];
  g.month.lines = ['月1'];
  g.year.lines = ['年1'];
  const log = [];
  assert.deepEqual(rolloverGoals(g, log, '2026-10-26', AT), ['week']);
  assert.deepEqual(g.week, { start: '2026-10-26', lines: [] });
  assert.deepEqual(log[0], { kind: 'week', key: '2026-10-19', lines: ['週1', '週2'], closedAt: AT });
  assert.deepEqual(rolloverGoals(g, log, '2026-11-02', AT), ['week', 'month']);
  assert.deepEqual(log[1], { kind: 'month', key: '2026-10', lines: ['月1'], closedAt: AT });
  assert.deepEqual(g.month, { key: '2026-11', lines: [] });
  assert.deepEqual(rolloverGoals(g, log, '2027-01-04', AT), ['week', 'month', 'year']);
  assert.deepEqual(log[2], { kind: 'year', key: '2026', lines: ['年1'], closedAt: AT });
  assert.deepEqual(g.year, { key: '2027', lines: [] });
  // Empty periods do not create history entries.
  assert.equal(log.length, 3);
});

test('schedule: the day changes, yesterday moves to the history', () => {
  const state = { schedule: newSchedule('2026-10-19'), scheduleLog: [] };
  assert.equal(addScheduleText(state.schedule, '9:00 朝の準備'), 1);
  assert.equal(rolloverSchedule(state, '2026-10-19'), false);
  assert.equal(rolloverSchedule(state, '2026-10-20'), true);
  assert.equal(state.schedule.date, '2026-10-20');
  assert.equal(state.schedule.lines.length, 0);
  assert.equal(state.scheduleLog.length, 1);
  assert.equal(state.scheduleLog[0].date, '2026-10-19');
  assert.equal(state.scheduleLog[0].lines[0].text, '9:00 朝の準備');
});

test('schedule paste: 5 lines with bullets become 5 items; limit 30', () => {
  const s = newSchedule('2026-10-19');
  assert.equal(addScheduleText(s, '- 9:00 一つ目\n- 10:00 二つ目\n\n・13:00 三つ目\n・四つ目\n- 15:30 五つ目'), 5);
  assert.equal(s.lines[0].text, '9:00 一つ目');
  assert.equal(s.lines[3].text, '四つ目');
  assert.equal(addScheduleText(s, Array.from({ length: 40 }, (_, i) => '行' + i).join('\n')), 25);
  assert.equal(s.lines.length, 30);
});

test('time at the start of a schedule line', () => {
  assert.deepEqual(splitTime('15:00 研修'), { time: '15:00', rest: '研修' });
  assert.deepEqual(splitTime('9:00 朝'), { time: '9:00', rest: '朝' });
  assert.deepEqual(splitTime('9:00-10:30 打ち合わせ'), { time: '9:00-10:30', rest: '打ち合わせ' });
  assert.deepEqual(splitTime('１５：００ 研修'), { time: '１５：００', rest: '研修' });
  assert.deepEqual(splitTime('15:00研修'), { time: '15:00', rest: '研修' });
  assert.deepEqual(splitTime('研修 15:00'), { time: '', rest: '研修 15:00' });
  assert.deepEqual(splitTime('25:99 x'), { time: '', rest: '25:99 x' });
});
