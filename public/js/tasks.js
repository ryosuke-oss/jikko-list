// Tasks, the route of confirmations/requests, status linkage, lists and filters.

import { uid, diffDays, mondayOf, addDays, fmtMD, clampText } from './util.js';
import { xpForCompletion, XP_RULES } from './dragon.js';
import { TITLE_MAX, NOTE_MAX, ROUTE_MAX } from './parse.js';

export { TITLE_MAX, NOTE_MAX, ROUTE_MAX };
export const MEMO_MAX = 2000;
export const NEXT_MAX = 120;

export const RANKS = ['A', 'B', 'C'];
export const RANK_LABEL = { A: 'A 考える', B: 'B 調べればできる', C: 'C 作業' };
export const DURATIONS = ['1d', '3d', '1w', '1m'];
export const DURATION_LABEL = { '1d': '1日', '3d': '3日', '1w': '1週間', '1m': '1ヶ月' };
export const STATUSES = ['todo', 'doing', 'stopped', 'done'];
export const STATUS_LABEL = { todo: '未着手', doing: '進行中', stopped: '停止中', done: '完了' };
export const KINDS = ['confirm', 'request', 'reply'];
export const KIND_LABEL = { confirm: '確認', request: '依頼', reply: '返信' };
export const STEP_STATES = ['todo', 'wait', 'done'];
export const STEP_STATE_LABEL = { todo: 'まだ', wait: '待ち', done: '済' };
export const GROUPS = ['boss', 'team', 'dept', 'external'];
export const GROUP_LABEL = { boss: '上司', team: '部署内', dept: '他部署', external: '社外' };

// Departments only. Names of people are added by the user in the settings (kept on the device).
export const DEFAULT_PEOPLE = [
  { name: '上司', group: 'boss', icon: 'crown' },
  { name: '部署内', group: 'team', icon: 'users-group' },
  { name: '経理部', group: 'dept', icon: 'cash' },
  { name: '人事部', group: 'dept', icon: 'id-badge-2' },
  { name: '教育部', group: 'dept', icon: 'school' },
  { name: 'マーケ部', group: 'dept', icon: 'speakerphone' },
  { name: '情シス', group: 'dept', icon: 'device-laptop' },
  { name: '総務', group: 'dept', icon: 'building' },
  { name: '法務', group: 'dept', icon: 'scale' },
  { name: '社外（取引先）', group: 'external', icon: 'building-store' },
];

export const PERSON_ICONS = DEFAULT_PEOPLE.map((p) => p.icon);
export const PERSON_NAME_MAX = 20;

export function initialOf(name) {
  return Array.from(String(name || '').trim())[0] || '?';
}

export function newPerson(name, group, icon) {
  const n = clampText(String(name || '').trim(), PERSON_NAME_MAX);
  return { id: uid(), name: n, group: GROUPS.includes(group) ? group : 'dept', icon: icon || null, initial: initialOf(n), deletedAt: null };
}

export function defaultPeople() {
  return DEFAULT_PEOPLE.map((p) => newPerson(p.name, p.group, p.icon));
}

export function newStep(kind, whoId, note) {
  return {
    id: uid(),
    kind: KINDS.includes(kind) ? kind : 'confirm',
    whoId: String(whoId || ''),
    note: clampText(String(note || ''), NOTE_MAX),
    state: 'todo',
    waitSince: null,
    doneAt: null,
    xpGiven: false,
  };
}

export function newTask(fields, at, order) {
  const f = fields || {};
  return {
    id: uid(),
    title: clampText(String(f.title || '').trim(), TITLE_MAX),
    due: f.due || null,
    rank: RANKS.includes(f.rank) ? f.rank : null,
    duration: DURATIONS.includes(f.duration) ? f.duration : null,
    star: Boolean(f.star),
    status: 'todo',
    nextAction: '',
    memo: '',
    cOption: false,
    route: (f.steps || []).slice(0, ROUTE_MAX).map((s) => newStep(s.kind, s.whoId, s.note)),
    links: { slack: '', doc: '', web: '' },
    parked: false,
    returnOn: null,
    returnedMark: false,
    order: Number.isFinite(order) ? order : 0,
    createdAt: at,
    updatedAt: at,
    doneAt: null,
    deletedAt: null,
    xpGiven: 0,
    xpBucket: null,
    prevStatus: null,
    prevPark: null,
    xpSteps: [],
    xpStepsLegacy: 0,
    stepXpCount: 0,
    purgedAt: null,
  };
}

// ---- Route and status linkage ----

/** A waiting step stops the task; with no waiting step it is in progress. Done tasks are left alone. */
export function linkStatus(task) {
  if (task.status === 'done') return task.status;
  task.status = task.route.some((s) => s.state === 'wait') ? 'stopped' : 'doing';
  return task.status;
}

export function setStepState(task, stepId, state, today) {
  const s = task.route.find((x) => x.id === stepId);
  if (!s || !STEP_STATES.includes(state) || s.state === state) return false;
  s.state = state;
  if (state === 'wait') s.waitSince = today;
  if (state === 'todo') s.waitSince = null;
  s.doneAt = state === 'done' ? today : null;
  linkStatus(task);
  return true;
}

export function addStep(task, kind, whoId, note) {
  if (task.route.length >= ROUTE_MAX) return null;
  const s = newStep(kind, whoId, note);
  task.route.push(s);
  return s;
}

export function removeStep(task, stepId) {
  const i = task.route.findIndex((x) => x.id === stepId);
  if (i < 0) return false;
  const [removed] = task.route.splice(i, 1);
  if (removed.state === 'wait') linkStatus(task);
  return true;
}

export function moveStep(task, from, to) {
  if (from === to || from < 0 || to < 0 || from >= task.route.length || to >= task.route.length) return false;
  const [s] = task.route.splice(from, 1);
  task.route.splice(to, 0, s);
  return true;
}

export function allStepsDone(task) {
  return task.route.length > 0 && task.route.every((s) => s.state === 'done');
}

/**
 * Steps that became done for the first time: flags them, records their ids and returns the points (+2 each).
 * At most ROUTE_MAX steps per task ever earn points, so adding and deleting steps cannot pad the total.
 * The ids are kept even when the step is deleted later, and the same step counts once.
 */
/**
 * Join the steps that earned points from another copy of the same task (another tab saved it meanwhile):
 * earned points never drop, a step is counted once and at most ROUTE_MAX per task.
 */
export function keepXpSteps(task, other) {
  const legacy = Math.max(task.xpStepsLegacy || 0, (other && other.xpStepsLegacy) || 0);
  const ids = [...new Set([...(task.xpSteps || []), ...((other && other.xpSteps) || [])])].slice(0, Math.max(0, ROUTE_MAX - legacy));
  task.xpSteps = ids;
  task.xpStepsLegacy = legacy;
  task.stepXpCount = Math.min(ROUTE_MAX, ids.length + legacy);
}

export function collectStepXp(task) {
  const ids = new Set(Array.isArray(task.xpSteps) ? task.xpSteps : []);
  const legacy = task.xpStepsLegacy || 0;
  let n = 0;
  for (const s of task.route) {
    if (s.state === 'done' && !s.xpGiven) {
      s.xpGiven = true;
      if (!ids.has(s.id) && ids.size + legacy < ROUTE_MAX) {
        ids.add(s.id);
        n += 1;
      }
    }
  }
  task.xpSteps = [...ids];
  task.stepXpCount = Math.min(ROUTE_MAX, ids.size + legacy); // kept for version 1.2 and older
  return n * XP_RULES.step;
}

export function personName(peopleById, id) {
  const p = peopleById.get(id);
  return p ? p.name : '（削除した相手）';
}

/**
 * What the route says right now. A waiting step comes first ("who are we waiting for"),
 * otherwise the first step that is not done yet.
 */
export function routeNow(task, peopleById, today) {
  if (!task.route.length) return null;
  const w = task.route.findIndex((s) => s.state === 'wait');
  if (w >= 0) {
    const s = task.route[w];
    const who = personName(peopleById, s.whoId);
    const days = s.waitSince ? Math.max(0, diffDays(s.waitSince, today)) : 0;
    return { type: 'wait', index: w, who, days, text: who + 'の返事待ち ' + days + '日' };
  }
  const i = task.route.findIndex((s) => s.state !== 'done');
  if (i < 0) return { type: 'done', index: -1, text: '確認ルートは全部済' };
  const s = task.route[i];
  const who = personName(peopleById, s.whoId);
  return { type: 'next', index: i, who, text: '次: ' + who + 'に' + KIND_LABEL[s.kind] };
}

// ---- Due dates ----

export function dueInfo(due, today) {
  if (!due) return null;
  const d = diffDays(today, due);
  const baseYear = Number(today.slice(0, 4));
  if (d < 0) return { text: d === -1 ? '昨日' : fmtMD(due, baseYear), tone: 'red', days: d };
  if (d === 0) return { text: '今日', tone: 'red', days: 0 };
  if (d === 1) return { text: '明日', tone: 'orange', days: 1 };
  if (d <= 3) return { text: 'あと' + d + '日', tone: 'orange', days: d };
  return { text: fmtMD(due, baseYear), tone: 'gray', days: d };
}

/** Second line of a row: [{text, tone}] */
export function rowMeta(task, peopleById, today) {
  const out = [];
  const now = routeNow(task, peopleById, today);
  if (task.parked) out.push({ text: task.returnOn ? '戻す日 ' + fmtMD(task.returnOn, Number(today.slice(0, 4))) : '戻す日なし', tone: 'brown' });
  if (now && now.type === 'wait') out.push({ text: now.text, tone: 'orange' });
  const di = dueInfo(task.due, today);
  if (di) out.push({ text: di.text, tone: di.tone });
  if (task.status === 'stopped' && !(now && now.type === 'wait')) out.push({ text: '停止中', tone: 'orange' });
  if (task.status === 'doing') out.push({ text: '進行中', tone: 'blue' });
  if (now && now.type === 'next') out.push({ text: now.text, tone: 'gray' });
  if (task.duration) out.push({ text: '所要' + DURATION_LABEL[task.duration], tone: 'gray' });
  if (task.rank === 'C' && task.cOption) out.push({ text: '振れる？', tone: 'gray' });
  return out;
}

// ---- Lists ----

export const SMART_LISTS = [
  { key: 'today', label: '今日', icon: 'calendar', color: 'blue' },
  { key: 'overdue', label: '期限切れ', icon: 'alert-circle', color: 'red' },
  { key: 'all', label: 'すべて', icon: 'inbox', color: 'gray' },
  { key: 'star', label: '重要', icon: 'star', color: 'orange' },
  { key: 'stopped', label: '停止中', icon: 'hourglass', color: 'orange' },
  { key: 'parked', label: 'あとで箱', icon: 'archive', color: 'brown' },
];

/** Not deleted (nor completely deleted) and not done. */
export function isLive(t) {
  return !t.deletedAt && !t.purgedAt && t.status !== 'done';
}

export function inSmart(key, t, today) {
  if (!isLive(t)) return false;
  if (key === 'parked') return t.parked;
  if (t.parked) return false;
  switch (key) {
    case 'today': return t.due === today;
    case 'overdue': return Boolean(t.due) && t.due < today;
    case 'all': return true;
    case 'star': return t.star;
    case 'stopped': return t.status === 'stopped';
    default: return false;
  }
}

export function smartCounts(tasks, today) {
  const c = {};
  for (const s of SMART_LISTS) c[s.key] = 0;
  for (const t of tasks) for (const s of SMART_LISTS) if (inSmart(s.key, t, today)) c[s.key] += 1;
  return c;
}

export function emptyFilters() {
  return { rank: null, status: null, due: null, duration: null, cOption: false };
}

export const FILTER_GROUPS = [
  { label: 'ランク', items: [
    { key: 'rank', value: 'A', label: 'A 考える' },
    { key: 'rank', value: 'B', label: 'B 調べればできる' },
    { key: 'rank', value: 'C', label: 'C 作業（まとめて片付け）' },
  ] },
  { label: '状態', items: [
    { key: 'status', value: 'todo', label: '未着手' },
    { key: 'status', value: 'doing', label: '進行中' },
    { key: 'status', value: 'stopped', label: '停止中' },
  ] },
  { label: '期日', items: [{ key: 'due', value: 'week', label: '今週' }] },
  { label: '所要期間', items: DURATIONS.map((d) => ({ key: 'duration', value: d, label: DURATION_LABEL[d] })) },
  { label: 'C の候補', items: [{ key: 'cOption', value: true, label: '振れる？自動化できる？' }] },
];

export function optionMatch(key, value, t, today) {
  switch (key) {
    case 'rank': return t.rank === value;
    case 'status': return t.status === value;
    case 'due': {
      if (!t.due) return false;
      const mon = mondayOf(today);
      return t.due >= mon && t.due <= addDays(mon, 6);
    }
    case 'duration': return t.duration === value;
    case 'cOption': return t.rank === 'C' && t.cOption === true;
    default: return true;
  }
}

export function matchFilters(f, t, today) {
  for (const key of ['rank', 'status', 'due', 'duration']) {
    if (f[key] != null && !optionMatch(key, f[key], t, today)) return false;
  }
  if (f.cOption && !optionMatch('cOption', true, t, today)) return false;
  return true;
}

export function activeFilterCount(f) {
  return ['rank', 'status', 'due', 'duration'].filter((k) => f[k] != null).length + (f.cOption ? 1 : 0);
}

// ---- Manual order ----

export function byOrder(a, b) {
  return (a.order - b.order) || String(a.createdAt).localeCompare(String(b.createdAt));
}

export function nextOrder(tasks) {
  let m = -Infinity;
  for (const t of tasks) if (t.order > m) m = t.order;
  return Number.isFinite(m) ? m + 1 : 0;
}

export function topOrder(tasks) {
  let m = Infinity;
  for (const t of tasks) if (t.order < m) m = t.order;
  return Number.isFinite(m) ? m - 1 : 0;
}

export function renumber(tasks) {
  tasks.slice().sort(byOrder).forEach((t, i) => { t.order = i; });
}

const ORDER_GAP_MIN = 0.000001;

/**
 * The user dragged one row (movedId) to a new place (ids = the visible rows, top to bottom, after the drag).
 * Only the moved row gets a new number: halfway between the visible rows right above and below it,
 * or one less than the top / one more than the bottom. Only when the two numbers are too close
 * are all tasks numbered again first (rare). Returns the ids of the tasks whose number changed.
 */
export function applyReorder(tasks, ids, movedId, at) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const k = ids.indexOf(movedId);
  const moved = byId.get(movedId);
  if (k < 0 || !moved) return [];
  const above = k > 0 ? byId.get(ids[k - 1]) : null;
  const below = k < ids.length - 1 ? byId.get(ids[k + 1]) : null;
  if (!above && !below) return [];
  const changed = new Set([moved.id]);
  if (above && below && !(below.order - above.order >= ORDER_GAP_MIN)) {
    const before = new Map(tasks.map((t) => [t.id, t.order]));
    renumber(tasks);
    for (const t of tasks) if (t.order !== before.get(t.id)) changed.add(t.id);
  }
  if (above && below) moved.order = (above.order + below.order) / 2;
  else if (above) moved.order = above.order + 1;
  else moved.order = below.order - 1;
  if (at) moved.updatedAt = at;
  return [...changed];
}

// ---- Done / undo ----
// The task records what its completion is worth; the dragon counts it (dragon.js settle).

export function completeTask(task, today, at) {
  if (task.status === 'done') return null;
  task.prevStatus = task.status;
  task.prevPark = task.parked ? { returnOn: task.returnOn || null } : null;
  task.status = 'done';
  task.doneAt = at;
  task.parked = false;
  task.returnOn = null;
  task.returnedMark = false;
  const x = xpForCompletion(task, today);
  task.xpGiven = x.amount;
  task.xpBucket = x.bucket;
  task.updatedAt = at;
  return { amount: x.amount, bucket: x.bucket, onTime: x.onTime };
}

/** Undo a completion: the points it was worth are no longer counted. */
export function uncompleteTask(task, at) {
  if (task.status !== 'done') return null;
  const amount = task.xpGiven || 0;
  task.status = task.prevStatus && task.prevStatus !== 'done' ? task.prevStatus : 'todo';
  task.prevStatus = null;
  if (task.prevPark) {
    // it was in the later box when it was completed: put it back there
    task.parked = true;
    task.returnOn = task.prevPark.returnOn || null;
  }
  task.prevPark = null;
  task.doneAt = null;
  task.xpGiven = 0;
  task.xpBucket = null;
  task.updatedAt = at;
  return { amount: -amount };
}

// ---- The "later" box ----

export function returnChoices(today) {
  return [
    { key: 'none', label: 'なし', date: null },
    { key: 'tomorrow', label: '明日', date: addDays(today, 1) },
    { key: 'nextMonday', label: '来週月曜', date: addDays(mondayOf(today), 7) },
  ];
}

export function parkTask(task, returnOn, at) {
  task.parked = true;
  task.returnOn = returnOn || null;
  task.returnedMark = false;
  task.updatedAt = at;
}

export function unparkTask(task, tasks, mark, at) {
  task.parked = false;
  task.returnOn = null;
  task.returnedMark = Boolean(mark);
  task.order = topOrder(tasks);
  task.updatedAt = at;
}

/** Tasks whose return date has come go back to the top of the list, marked. Returns their ids. */
export function returnDueParked(tasks, today, at) {
  const due = tasks
    .filter((t) => isLive(t) && t.parked && t.returnOn && t.returnOn <= today)
    .sort((a, b) => a.returnOn.localeCompare(b.returnOn) || byOrder(a, b));
  for (let i = due.length - 1; i >= 0; i -= 1) unparkTask(due[i], tasks, true, at);
  return due.map((t) => t.id);
}

// ---- Trash ----

export function trashTask(task, at) {
  task.deletedAt = at;
  task.updatedAt = at;
}

/** Back from the trash. A completely deleted task (a mark) never comes back. */
export function restoreTask(task, at) {
  if (task.purgedAt) return false;
  task.deletedAt = null;
  task.updatedAt = at;
  return true;
}

export const PURGED_TASK_TITLE = '（消したタスク）';
export const PURGED_MEMO_TEXT = '（消したメモ）';

export function isPurged(x) {
  return Boolean(x && x.purgedAt);
}

/**
 * "完全に消す": the task stays as a small mark so that other devices learn it is gone and the
 * dragon's points do not drop. Only the id, the dates, the status and the points-related fields are kept;
 * the name, memo, links and route are cleared. It is never shown in any list, count or search.
 */
export function purgeTask(task, at) {
  Object.assign(task, {
    title: PURGED_TASK_TITLE,
    due: null,
    duration: null,
    star: false,
    nextAction: '',
    memo: '',
    cOption: false,
    route: [],
    links: { slack: '', doc: '', web: '' },
    parked: false,
    returnOn: null,
    returnedMark: false,
    doneAt: null,
    prevStatus: null,
    prevPark: null,
    deletedAt: task.deletedAt || at,
    purgedAt: at,
    updatedAt: at,
  });
}

/** The same for a memo: only the id and the dates are kept. */
export function purgeMemo(memo, at) {
  Object.assign(memo, { text: PURGED_MEMO_TEXT, taskId: null, deletedAt: memo.deletedAt || at, purgedAt: at });
}

/** The boss to suggest for an A task without a route ("①確認・上司（方向性確認）"). */
export function bossFor(people) {
  return people.find((p) => !p.deletedAt && p.group === 'boss') || null;
}
