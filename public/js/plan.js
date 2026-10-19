// Goals (week / month / year) and today's schedule.
// When a period or a day is over, its lines move to the history. Nothing is deleted.

import { mondayOf, addDays, fmtMD, uid, clampText } from './util.js';
import { pastedLines } from './parse.js';

export const GOAL_KINDS = ['week', 'month', 'year'];
export const GOAL_KIND_LABEL = { week: '週', month: '月', year: '年' };
export const GOAL_LIMITS = { lines: 10, chars: 100 };
export const SCHEDULE_LIMITS = { lines: 30, chars: 200 };

export function periodKey(kind, today) {
  if (kind === 'week') return mondayOf(today);
  if (kind === 'month') return today.slice(0, 7);
  return today.slice(0, 4);
}

/** "10/19(月)〜10/25(日)" / "10月" / "2026年" */
export function periodLabel(kind, key) {
  if (kind === 'week') return fmtMD(key) + '〜' + fmtMD(addDays(key, 6));
  if (kind === 'month') return Number(key.slice(5, 7)) + '月';
  return key + '年';
}

/** Label used in the history: "10/12〜10/18" / "2026年9月" / "2025年" */
export function historyLabel(kind, key) {
  if (kind === 'week') {
    const end = addDays(key, 6);
    const md = (s) => Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10));
    return key.slice(0, 4) + '年 ' + md(key) + '〜' + md(end);
  }
  if (kind === 'month') return key.slice(0, 4) + '年' + Number(key.slice(5, 7)) + '月';
  return key + '年';
}

export function storedKey(goals, kind) {
  return kind === 'week' ? goals.week.start : goals[kind].key;
}

export function emptyPeriod(kind, today) {
  const key = periodKey(kind, today);
  return kind === 'week' ? { start: key, lines: [] } : { key, lines: [] };
}

export function newGoals(today) {
  return { week: emptyPeriod('week', today), month: emptyPeriod('month', today), year: emptyPeriod('year', today) };
}

export function cleanGoalLines(lines) {
  return (lines || [])
    .map((s) => clampText(String(s == null ? '' : s).trim(), GOAL_LIMITS.chars))
    .filter((s) => s.length > 0)
    .slice(0, GOAL_LIMITS.lines);
}

/** Move finished periods into goalLog. Returns the kinds that rolled over. */
export function rolloverGoals(goals, goalLog, today, at) {
  const moved = [];
  for (const kind of GOAL_KINDS) {
    const key = periodKey(kind, today);
    const old = storedKey(goals, kind);
    if (old === key) continue;
    const lines = cleanGoalLines(goals[kind].lines);
    if (lines.length) goalLog.push({ kind, key: old, lines, closedAt: at });
    goals[kind] = emptyPeriod(kind, today);
    moved.push(kind);
  }
  return moved;
}

export function newSchedule(today) {
  return { date: today, lines: [] };
}

/** Yesterday's (or older) schedule moves into scheduleLog. Returns true when it rolled over. */
export function rolloverSchedule(state, today) {
  const s = state.schedule;
  if (s.date === today) return false;
  const lines = s.lines.filter((l) => l.text && l.text.trim());
  if (lines.length) state.scheduleLog.push({ date: s.date, lines: lines.map((l) => ({ id: l.id, text: l.text })) });
  state.schedule = newSchedule(today);
  return true;
}

export function newLine(text) {
  return { id: uid(), text: clampText(String(text).trim(), SCHEDULE_LIMITS.chars) };
}

/** Add pasted or typed lines to today's schedule (bullets removed). Returns how many were added. */
export function addScheduleText(schedule, text) {
  const room = SCHEDULE_LIMITS.lines - schedule.lines.length;
  const lines = pastedLines(text).slice(0, Math.max(0, room));
  for (const l of lines) schedule.lines.push(newLine(l));
  return lines.length;
}

// "9:00", "15:30", "9:00-10:30" at the start of a line (matched on the NFKC form, so "１５：００" works too).
const TIME_RE = /^((?:[01]?\d|2\d):[0-5]\d(?:\s*[-~〜]\s*(?:[01]?\d|2\d):[0-5]\d)?)(?!\d)\s*/;

/** Split "15:00 研修" into { time: "15:00", rest: "研修" }. time is '' when the line has none. */
export function splitTime(text) {
  const s = String(text || '');
  const m = TIME_RE.exec(s.normalize('NFKC'));
  if (!m) return { time: '', rest: s };
  const k = m[0].length;
  // Digits, colons and spaces map one-to-one under NFKC; check before cutting the original text.
  if (s.slice(0, k).normalize('NFKC') !== m[0]) return { time: '', rest: s };
  return { time: s.slice(0, m[1].length), rest: s.slice(k) };
}
