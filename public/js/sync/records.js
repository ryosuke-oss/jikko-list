// The app's data seen as separate items, each with a key:
//   task:<id> / memo:<id> / person:<id> / goal:week:<monday> / goal:month:<YYYY-MM> / goal:year:<YYYY>
//   / schedule:<date> / dragon:name
// A period of goals and a day of the schedule use the same key while they are "now" and after they move to
// the history, and their content is only the lines (the time the period was closed stays on each device).
// No network here.

import { isYmd, clampText, uid } from '../util.js';
import { cleanTask, cleanMemo, cleanPerson, newState, FormatError } from '../store.js';
import { GOAL_KINDS, SCHEDULE_LIMITS, cleanGoalLines, periodKey, storedKey } from '../plan.js';
import { DEFAULT_PEOPLE, STATUS_LABEL, defaultPeople, initialOf } from '../tasks.js';
import { newDragon, settle } from '../dragon.js';

export const DRAGON_KEY = 'dragon:name';
export const DEFAULT_DRAGON_NAME = newDragon().name;

export const taskKey = (id) => 'task:' + id;
export const memoKey = (id) => 'memo:' + id;
export const personKey = (id) => 'person:' + id;
export const goalKey = (kind, period) => 'goal:' + kind + ':' + period;
export const scheduleKey = (date) => 'schedule:' + date;

export function typeOf(key) {
  const i = String(key).indexOf(':');
  return i > 0 ? key.slice(0, i) : '';
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** What a key stands for, or null when it is not a key of this app. */
export function parseKey(key) {
  if (typeof key !== 'string' || key.length > 130) return null;
  let m = /^(task|memo|person):([\s\S]{1,100})$/.exec(key);
  if (m) return CONTROL_RE.test(m[2]) ? null : { type: m[1], id: m[2] };
  m = /^goal:(week|month|year):(.+)$/.exec(key);
  if (m) {
    const [, kind, period] = m;
    const ok = kind === 'week' ? isYmd(period)
      : kind === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
        : /^\d{4}$/.test(period);
    return ok ? { type: 'goal', kind, period } : null;
  }
  m = /^schedule:(.+)$/.exec(key);
  if (m) return isYmd(m[1]) ? { type: 'schedule', date: m[1] } : null;
  if (key === DRAGON_KEY) return { type: 'dragon' };
  return null;
}

function fail(msg) {
  throw new FormatError(msg);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function strictGoalLines(lines) {
  if (!Array.isArray(lines) || lines.some((s) => typeof s !== 'string')) fail('目標の行が壊れています');
  return cleanGoalLines(lines);
}

function strictScheduleLines(lines) {
  if (!Array.isArray(lines)) fail('予定の行が壊れています');
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    if (!isObj(l) || typeof l.id !== 'string' || !l.id || l.id.length > 100 || typeof l.text !== 'string') fail('予定の行が壊れています');
    const text = clampText(l.text.trim(), SCHEDULE_LIMITS.chars);
    if (!text || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({ id: l.id, text });
  }
  return out.slice(0, SCHEDULE_LIMITS.lines);
}

/**
 * The checked, canonical content of an item (the same checks as the app's own data: cleanTask and so on).
 * Throws FormatError when the content does not belong to the key or is broken.
 */
export function cleanContent(key, content) {
  const k = parseKey(key);
  if (!k) fail('項目キーが正しくありません');
  if (!isObj(content)) fail('中身がありません');
  switch (k.type) {
    case 'task': {
      const t = cleanTask(content);
      if (t.id !== k.id) fail('項目キーと中身が合いません');
      return t;
    }
    case 'memo': {
      const m = cleanMemo(content);
      if (m.id !== k.id) fail('項目キーと中身が合いません');
      return m;
    }
    case 'person': {
      const p = cleanPerson(content);
      if (p.id !== k.id) fail('項目キーと中身が合いません');
      return p;
    }
    case 'goal':
      return { lines: strictGoalLines(content.lines) };
    case 'schedule':
      return { lines: strictScheduleLines(content.lines) };
    default: {
      const name = typeof content.name === 'string' ? clampText(content.name.trim(), 20) : '';
      if (!name) fail('竜の名前がありません');
      return { name };
    }
  }
}

/** A period without lines, a day without lines and the first name of the dragon count as "nothing yet". */
export function isEmptyContent(key, content) {
  const t = typeOf(key);
  if (t === 'goal' || t === 'schedule') return !content || !content.lines || content.lines.length === 0;
  if (t === 'dragon') return !content || content.name === DEFAULT_DRAGON_NAME;
  return !content;
}

function pushTo(map, key, list) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(list);
}

/** The lines of one period; the same period found twice gives its lines once each. */
function joinGoalLines(lists) {
  if (lists.length === 1) return lists[0];
  return [...new Set(lists.flat().map((s) => String(s).trim()))];
}

/**
 * Every item of the app's data: Map key -> checked content.
 * The same period (or day) found twice (the clock was put back) becomes one item with the lines put together.
 */
export function itemsOf(state) {
  const out = new Map();
  for (const t of state.tasks) out.set(taskKey(t.id), cleanContent(taskKey(t.id), t));
  for (const m of state.memos) out.set(memoKey(m.id), cleanContent(memoKey(m.id), m));
  for (const p of state.people) out.set(personKey(p.id), cleanContent(personKey(p.id), p));
  const goals = new Map();
  for (const e of state.goalLog) pushTo(goals, goalKey(e.kind, e.key), e.lines);
  for (const kind of GOAL_KINDS) pushTo(goals, goalKey(kind, storedKey(state.goals, kind)), state.goals[kind].lines);
  for (const [key, lists] of goals) out.set(key, cleanContent(key, { lines: joinGoalLines(lists) }));
  const days = new Map();
  for (const e of state.scheduleLog) pushTo(days, scheduleKey(e.date), e.lines);
  pushTo(days, scheduleKey(state.schedule.date), state.schedule.lines);
  for (const [key, lists] of days) out.set(key, cleanContent(key, { lines: lists.flat() }));
  out.set(DRAGON_KEY, cleanContent(DRAGON_KEY, { name: state.dragon.name }));
  return out;
}

/** The checked content of one item of the app's data, or null when the data has no such item. */
export function itemOf(state, key) {
  const k = parseKey(key);
  if (!k) return null;
  if (k.type === 'task' || k.type === 'memo' || k.type === 'person') {
    const list = k.type === 'task' ? state.tasks : k.type === 'memo' ? state.memos : state.people;
    const x = list.find((y) => y.id === k.id);
    return x ? cleanContent(key, x) : null;
  }
  if (k.type === 'dragon') return cleanContent(key, { name: state.dragon.name });
  const all = itemsOf(state);
  return all.has(key) ? all.get(key) : null;
}

function insertMemo(memos, m) {
  const i = memos.findIndex((x) => x.createdAt > m.createdAt);
  if (i < 0) memos.push(m);
  else memos.splice(i, 0, m);
}

/**
 * Put one item into the app's data (the data is changed in place).
 * Returns 'ok', or for a period / day that is not shown yet: 'future' (after today) or 'wait'
 * (the app has not moved on to that period yet; the date check runs first).
 */
export function applyItem(state, key, content, { today, at }) {
  const k = parseKey(key);
  if (!k) fail('項目キーが正しくありません');
  const c = cleanContent(key, content);
  if (k.type === 'task' || k.type === 'memo' || k.type === 'person') {
    const list = k.type === 'task' ? state.tasks : k.type === 'memo' ? state.memos : state.people;
    const i = list.findIndex((x) => x.id === k.id);
    if (i >= 0) list[i] = c;
    else if (k.type === 'memo') insertMemo(list, c);
    else list.push(c);
    return 'ok';
  }
  if (k.type === 'dragon') {
    state.dragon.name = c.name;
    return 'ok';
  }
  if (k.type === 'goal') {
    const cur = storedKey(state.goals, k.kind);
    const others = (e) => !(e.kind === k.kind && e.key === k.period);
    if (k.period === cur) {
      state.goals[k.kind].lines = c.lines.slice();
      state.goalLog = state.goalLog.filter(others);
      return 'ok';
    }
    if (k.period > periodKey(k.kind, today)) return 'future';
    if (k.period > cur) return 'wait';
    const first = state.goalLog.find((e) => !others(e));
    if (!c.lines.length) {
      state.goalLog = state.goalLog.filter(others);
    } else if (first) {
      first.lines = c.lines.slice();
      state.goalLog = state.goalLog.filter((e) => e === first || others(e));
    } else {
      state.goalLog.push({ kind: k.kind, key: k.period, lines: c.lines.slice(), closedAt: at });
    }
    return 'ok';
  }
  // schedule
  const cur = state.schedule.date;
  const others = (e) => e.date !== k.date;
  if (k.date === cur) {
    state.schedule.lines = c.lines.map((l) => ({ id: l.id, text: l.text }));
    state.scheduleLog = state.scheduleLog.filter(others);
    return 'ok';
  }
  if (k.date > today) return 'future';
  if (k.date > cur) return 'wait';
  const first = state.scheduleLog.find((e) => !others(e));
  if (!c.lines.length) {
    state.scheduleLog = state.scheduleLog.filter(others);
  } else if (first) {
    first.lines = c.lines.map((l) => ({ id: l.id, text: l.text }));
    state.scheduleLog = state.scheduleLog.filter((e) => e === first || others(e));
  } else {
    state.scheduleLog.push({ date: k.date, lines: c.lines.map((l) => ({ id: l.id, text: l.text })) });
  }
  return 'ok';
}

const personSig = (p) => p.name + '\u0000' + p.group + '\u0000' + (p.icon || '');

/**
 * "Empty" device (12-7 of the spec): no task (trash and marks included), no memo, no line of goals or
 * schedule (history included), the dragon's first name, and exactly the 10 first people (same name, group
 * and icon, none deleted).
 */
export function isEmptyState(state) {
  if (state.tasks.length || state.memos.length) return false;
  if (GOAL_KINDS.some((k) => cleanGoalLines(state.goals[k].lines).length)) return false;
  if (state.goalLog.some((e) => cleanGoalLines(e.lines).length)) return false;
  if (state.schedule.lines.some((l) => String(l.text).trim())) return false;
  if (state.scheduleLog.some((e) => e.lines.some((l) => String(l.text).trim()))) return false;
  if (state.dragon.name !== DEFAULT_DRAGON_NAME) return false;
  if (state.people.length !== DEFAULT_PEOPLE.length || state.people.some((p) => p.deletedAt)) return false;
  const want = DEFAULT_PEOPLE.map(personSig).sort();
  const have = state.people.map(personSig).sort();
  return have.every((x, i) => x === want[i]);
}

const DEFAULT_ORDER = new Map(DEFAULT_PEOPLE.map((p, i) => [p.name, i]));

function peopleOrder(a, b) {
  const da = DEFAULT_ORDER.has(a.name) ? DEFAULT_ORDER.get(a.name) : 99;
  const db = DEFAULT_ORDER.has(b.name) ? DEFAULT_ORDER.get(b.name) : 99;
  return (da - db) || a.name.localeCompare(b.name, 'ja') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The app's data rebuilt from the items of the sync data ("receive"). What belongs to this device only
 * (settings, the dragon's recent points, the daily counter) is taken from `keep`.
 * Returns { state, notShown: [keys of periods / days that are not shown yet] }.
 */
export function stateFromItems(items, { today, at, keep }) {
  const s = newState(today, at);
  s.people = [];
  const notShown = [];
  const keys = [...items.keys()].sort();
  for (const key of keys) {
    const r = applyItem(s, key, items.get(key), { today, at });
    if (r !== 'ok') notShown.push(key);
  }
  if (!s.people.length) s.people = defaultPeople();
  s.people.sort(peopleOrder);
  if (keep) {
    s.settings = structuredClone(keep.settings);
    s.dragon.log = structuredClone(keep.dragon.log || []);
    s.dragon.addCount = structuredClone(keep.dragon.addCount || { date: '', count: 0 });
  }
  settle(s.dragon, s.tasks, null, at);
  return { state: s, notShown };
}

/**
 * Reading a file (or a copy) while syncing: "overwrite and add". Items in the file replace or join the ones
 * on the device; nothing that is missing from the file is removed (0-2 p). Empty periods in the file do not
 * erase lines on the device. Settings and other device-only things stay.
 */
export function mergeImport(current, incoming, { today, at }) {
  const s = structuredClone(current);
  const items = itemsOf(joinPeopleByName(incoming, current));
  const notShown = [];
  for (const key of [...items.keys()].sort()) {
    const c = items.get(key);
    if (isEmptyContent(key, c)) continue;
    if (applyItem(s, key, c, { today, at }) !== 'ok') notShown.push(key);
  }
  settle(s.dragon, s.tasks, null, at);
  return { state: s, notShown };
}

/**
 * People in a file whose id is not on this device but whose name is (the first 10 people get their own ids on every
 * device): they take the id of the one here, and route steps follow, so reading a file never doubles them.
 */
export function joinPeopleByName(incoming, current) {
  const here = new Set(current.people.map((p) => p.id));
  const coming = new Set((incoming.people || []).map((p) => p.id));
  const free = current.people.filter((p) => !p.deletedAt && !coming.has(p.id));
  const map = new Map();
  for (const p of incoming.people || []) {
    if (here.has(p.id) || p.deletedAt) continue;
    const i = free.findIndex((x) => x.name === p.name);
    if (i < 0) continue;
    map.set(p.id, free[i].id);
    free.splice(i, 1);
  }
  if (!map.size) return incoming;
  const out = structuredClone(incoming);
  out.people = out.people.map((p) => (map.has(p.id) ? Object.assign({}, p, { id: map.get(p.id) }) : p));
  for (const t of out.tasks || []) for (const st of t.route || []) if (map.has(st.whoId)) st.whoId = map.get(st.whoId);
  return out;
}

/** "Same name" people of the sync data take the place of this device's ones; route steps follow them. */
export function adoptPeople(state, syncPeople) {
  const free = syncPeople.filter((p) => !p.deletedAt).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const map = new Map();
  for (const p of state.people) {
    const i = free.findIndex((x) => x.name === p.name);
    if (i < 0) continue;
    map.set(p.id, free[i].id);
    free.splice(i, 1);
  }
  const seen = new Set();
  const people = [];
  for (const p of state.people) {
    const id = map.get(p.id) || p.id;
    if (seen.has(id)) continue;
    seen.add(id);
    people.push(Object.assign({}, p, { id, initial: initialOf(p.name) }));
  }
  for (const t of state.tasks) for (const st of t.route) if (map.has(st.whoId)) st.whoId = map.get(st.whoId);
  state.people = people;
  return map;
}

// ---- the readable columns of a row (A to F are for people only; the app never reads them back) ----

const TYPE_LABEL = { task: 'タスク', memo: 'メモ', person: '相手', goal: '目標', schedule: '予定', dragon: '竜' };
const OP_LABEL = { add: '追加', edit: '変更', merge: '自動でまとめた', choice: '選んだ結果' };
const KIND_HEAD = { week: '週', month: '月', year: '年' };

function md(ymd) {
  return Number(ymd.slice(5, 7)) + '/' + Number(ymd.slice(8, 10));
}

function addDaysYmd(ymd, n) {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}

/** Columns C to F: kind, heading, state, operation. */
export function rowLabels(key, content, op) {
  const k = parseKey(key) || { type: '' };
  let head = '';
  let st = '';
  if (k.type === 'task') {
    head = content.purgedAt ? '（消した）' : content.title;
    st = content.purgedAt ? '消した' : content.deletedAt ? 'ゴミ箱' : content.parked && content.status !== 'done' ? 'あとで箱' : STATUS_LABEL[content.status] || '';
  } else if (k.type === 'memo') {
    head = content.purgedAt ? '（消した）' : clampText(content.text, 40);
    st = content.purgedAt ? '消した' : content.deletedAt ? 'ゴミ箱' : '';
  } else if (k.type === 'person') {
    head = content.name;
    st = content.deletedAt ? '消した' : '';
  } else if (k.type === 'goal') {
    head = KIND_HEAD[k.kind] + ' ' + (k.kind === 'week' ? md(k.period) + '〜' + md(addDaysYmd(k.period, 6)) : k.period);
  } else if (k.type === 'schedule') {
    head = '予定 ' + md(k.date);
  } else if (k.type === 'dragon') {
    head = '竜の名前';
  }
  return { type: TYPE_LABEL[k.type] || '', head, state: st, op: OP_LABEL[op] || '' };
}

/** A new device id (random). The first 4 characters go into the name of the device's tab. */
export function newDeviceId() {
  return uid().replace(/[^0-9a-z]/gi, '').toLowerCase().slice(0, 16).padEnd(16, '0');
}

/**
 * "記録_<device name>_<first characters of the device id>" (4 normally; more when that name is taken),
 * with characters that would confuse a sheet name replaced.
 */
export function tabTitle(deviceName, deviceId, idChars = 4) {
  const name = clampText(String(deviceName || '端末').replace(/[\s'"!:/\\?*[\]]+/g, '_'), 20) || '端末';
  return '記録_' + name + '_' + String(deviceId).slice(0, idChars);
}

/** The device name of a tab ("記録_Mac_3f9a" -> "Mac"), for "Mac のほうを残す". */
export function deviceOfTab(title) {
  const m = /^記録_(.+)_[0-9a-z]{4,16}$/.exec(String(title || ''));
  return m ? m[1] : '';
}
