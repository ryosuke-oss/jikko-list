// Saving. Everything stays inside this browser (IndexedDB). Nothing is sent anywhere.
// Also: the JSON export / import, the automatic daily copies, and the checks that keep
// a broken or foreign file from overwriting anything.

import { isYmd, isIsoTime, clampText, cleanUrl } from './util.js';
import { newDragon, BUCKETS } from './dragon.js';
import {
  RANKS, DURATIONS, STATUSES, KINDS, STEP_STATES, GROUPS, PERSON_ICONS,
  TITLE_MAX, NOTE_MAX, ROUTE_MAX, MEMO_MAX, NEXT_MAX, PERSON_NAME_MAX,
  defaultPeople, initialOf,
} from './tasks.js';
import { newGoals, newSchedule, GOAL_KINDS, GOAL_LIMITS, SCHEDULE_LIMITS } from './plan.js';

export const DB_NAME = 'jikko-list';
export const DB_VERSION = 1;
export const APP_ID = 'jikko-list';
export const FORMAT = 1;
export const KEYS = ['tasks', 'people', 'memos', 'goals', 'goalLog', 'schedule', 'scheduleLog', 'dragon', 'settings'];
export const BACKUP_DAYS = 7;
export const MEMO_TEXT_MAX = 500;
const EPOCH = new Date(0).toISOString();

export function newState(today, at) {
  return {
    tasks: [],
    people: defaultPeople(),
    memos: [],
    goals: newGoals(today),
    goalLog: [],
    schedule: newSchedule(today),
    scheduleLog: [],
    dragon: newDragon(),
    settings: { version: 1, createdAt: at, lastExportAt: null, persisted: null, persistAsked: false },
  };
}

// ---- Checking data (used for imports, and for whatever is read back from the database) ----

export class FormatError extends Error {}

function fail(msg) {
  throw new FormatError(msg);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? clampText(v, max) : '');
const bool = (v) => v === true;
const oneOf = (v, list, fallback = null) => (list.includes(v) ? v : fallback);
const ymdOrNull = (v) => (isYmd(v) ? v : null);
const isoOrNull = (v) => (isIsoTime(v) ? v : null);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function idOf(v, what) {
  if (typeof v !== 'string' || !v || v.length > 100) fail(what + 'のIDが正しくありません');
  return v;
}

function arr(v, what) {
  if (!Array.isArray(v)) fail(what + 'の形が違います');
  return v;
}

function noDuplicates(list, what) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) fail(what + 'のIDが重複しています');
    seen.add(x.id);
  }
}

function cleanStep(s) {
  if (!isObj(s)) fail('確認ルートの段が壊れています');
  return {
    id: idOf(s.id, '段'),
    kind: oneOf(s.kind, KINDS, 'confirm'),
    whoId: str(s.whoId, 100),
    note: str(s.note, NOTE_MAX),
    state: oneOf(s.state, STEP_STATES, 'todo'),
    waitSince: ymdOrNull(s.waitSince),
    doneAt: ymdOrNull(s.doneAt),
    xpGiven: bool(s.xpGiven),
  };
}

function cleanLinks(l) {
  const o = isObj(l) ? l : {};
  return { slack: cleanUrl(o.slack) || '', doc: cleanUrl(o.doc) || '', web: cleanUrl(o.web) || '' };
}

export function cleanTask(t) {
  if (!isObj(t)) fail('タスクが壊れています');
  const title = typeof t.title === 'string' ? clampText(t.title.trim(), TITLE_MAX) : '';
  if (!title) fail('タスク名のないタスクがあります');
  const route = t.route == null ? [] : arr(t.route, '確認ルート');
  return {
    id: idOf(t.id, 'タスク'),
    title,
    due: ymdOrNull(t.due),
    rank: oneOf(t.rank, RANKS),
    duration: oneOf(t.duration, DURATIONS),
    star: bool(t.star),
    status: oneOf(t.status, STATUSES, 'todo'),
    nextAction: str(t.nextAction, NEXT_MAX),
    memo: str(t.memo, MEMO_MAX),
    cOption: bool(t.cOption),
    route: route.slice(0, ROUTE_MAX).map(cleanStep),
    links: cleanLinks(t.links),
    parked: bool(t.parked),
    returnOn: ymdOrNull(t.returnOn),
    returnedMark: bool(t.returnedMark),
    order: num(t.order),
    createdAt: isoOrNull(t.createdAt) || EPOCH,
    updatedAt: isoOrNull(t.updatedAt) || EPOCH,
    doneAt: isoOrNull(t.doneAt),
    deletedAt: isoOrNull(t.deletedAt),
    xpGiven: Math.max(0, num(t.xpGiven)),
    xpBucket: oneOf(t.xpBucket, BUCKETS),
    prevStatus: oneOf(t.prevStatus, STATUSES),
    prevPark: isObj(t.prevPark) ? { returnOn: ymdOrNull(t.prevPark.returnOn) } : null,
    stepXpCount: Math.min(ROUTE_MAX, Math.max(0, Math.floor(num(t.stepXpCount)))),
  };
}

export function cleanPerson(p) {
  if (!isObj(p)) fail('相手の登録が壊れています');
  const name = str(p.name, PERSON_NAME_MAX).trim();
  if (!name) fail('名前のない相手があります');
  return {
    id: idOf(p.id, '相手'),
    name,
    group: oneOf(p.group, GROUPS, 'dept'),
    icon: oneOf(p.icon, PERSON_ICONS),
    initial: initialOf(name),
    deletedAt: isoOrNull(p.deletedAt),
  };
}

export function cleanMemo(m) {
  if (!isObj(m)) fail('メモが壊れています');
  const text = str(m.text, MEMO_TEXT_MAX).trim();
  if (!text) fail('空のメモがあります');
  return {
    id: idOf(m.id, 'メモ'),
    text,
    createdAt: isoOrNull(m.createdAt) || EPOCH,
    taskId: typeof m.taskId === 'string' && m.taskId ? m.taskId.slice(0, 100) : null,
    deletedAt: isoOrNull(m.deletedAt),
  };
}

function cleanTextLines(v, max, chars, what) {
  return arr(v, what).slice(0, max).map((s) => {
    if (typeof s !== 'string') fail(what + 'の行が壊れています');
    return clampText(s, chars);
  });
}

function cleanGoals(g) {
  if (!isObj(g) || !isObj(g.week) || !isObj(g.month) || !isObj(g.year)) fail('目標が壊れています');
  if (!isYmd(g.week.start)) fail('週の目標の日付が正しくありません');
  if (typeof g.month.key !== 'string' || !/^\d{4}-\d{2}$/.test(g.month.key)) fail('月の目標の日付が正しくありません');
  if (typeof g.year.key !== 'string' || !/^\d{4}$/.test(g.year.key)) fail('年の目標の日付が正しくありません');
  const lines = (p, w) => cleanTextLines(p.lines, GOAL_LIMITS.lines, GOAL_LIMITS.chars, w);
  return {
    week: { start: g.week.start, lines: lines(g.week, '週の目標') },
    month: { key: g.month.key, lines: lines(g.month, '月の目標') },
    year: { key: g.year.key, lines: lines(g.year, '年の目標') },
  };
}

function cleanGoalLog(list) {
  return arr(list, '目標の履歴').map((e) => {
    if (!isObj(e) || !GOAL_KINDS.includes(e.kind) || typeof e.key !== 'string' || e.key.length > 20) fail('目標の履歴が壊れています');
    return { kind: e.kind, key: e.key, lines: cleanTextLines(e.lines, GOAL_LIMITS.lines, GOAL_LIMITS.chars, '目標の履歴'), closedAt: isoOrNull(e.closedAt) || EPOCH };
  });
}

function cleanScheduleLines(v, what) {
  return arr(v, what).slice(0, SCHEDULE_LIMITS.lines).map((l) => {
    if (!isObj(l) || typeof l.text !== 'string') fail(what + 'の行が壊れています');
    return { id: idOf(l.id, '予定'), text: clampText(l.text, SCHEDULE_LIMITS.chars) };
  });
}

function cleanSchedule(s) {
  if (!isObj(s) || !isYmd(s.date)) fail('今日の予定が壊れています');
  return { date: s.date, lines: cleanScheduleLines(s.lines, '今日の予定') };
}

function cleanScheduleLog(list) {
  return arr(list, '過去の予定').map((e) => {
    if (!isObj(e) || !isYmd(e.date)) fail('過去の予定が壊れています');
    return { date: e.date, lines: cleanScheduleLines(e.lines, '過去の予定') };
  });
}

function cleanDragon(d) {
  if (!isObj(d) || !isObj(d.xp)) fail('竜のデータが壊れています');
  const base = newDragon();
  const xp = {};
  for (const k of BUCKETS) xp[k] = Math.max(0, Math.floor(num(d.xp[k])));
  const ac = isObj(d.addCount) ? d.addCount : {};
  return {
    name: str(d.name, 20).trim() || base.name,
    xp,
    total: BUCKETS.reduce((s, k) => s + xp[k], 0),
    addCount: { date: isYmd(ac.date) ? ac.date : '', count: Math.max(0, Math.floor(num(ac.count))) },
    log: (Array.isArray(d.log) ? d.log : []).slice(-300).filter(isObj).map((e) => ({
      at: isoOrNull(e.at) || EPOCH,
      delta: Math.trunc(num(e.delta)),
      reason: str(e.reason, 40),
      bucket: oneOf(e.bucket, BUCKETS, 'other'),
    })),
  };
}

function cleanSettings(s) {
  const o = isObj(s) ? s : {};
  return {
    version: 1,
    createdAt: isoOrNull(o.createdAt) || EPOCH,
    lastExportAt: isoOrNull(o.lastExportAt),
    persisted: typeof o.persisted === 'boolean' ? o.persisted : null,
    persistAsked: bool(o.persistAsked),
  };
}

/** Throws FormatError when anything is broken; returns a fully checked copy otherwise. */
export function cleanState(d) {
  if (!isObj(d)) fail('中身がありません');
  const tasks = arr(d.tasks, 'タスク').map(cleanTask);
  const people = arr(d.people, '相手').map(cleanPerson);
  const memos = arr(d.memos, 'メモ').map(cleanMemo);
  noDuplicates(tasks, 'タスク');
  noDuplicates(people, '相手');
  noDuplicates(memos, 'メモ');
  return {
    tasks,
    people,
    memos,
    goals: cleanGoals(d.goals),
    goalLog: cleanGoalLog(d.goalLog),
    schedule: cleanSchedule(d.schedule),
    scheduleLog: cleanScheduleLog(d.scheduleLog),
    dragon: cleanDragon(d.dragon),
    settings: cleanSettings(d.settings),
  };
}

export function countsOf(data) {
  const live = data.tasks.filter((t) => !t.deletedAt);
  return {
    tasks: live.filter((t) => t.status !== 'done').length,
    done: live.filter((t) => t.status === 'done').length,
    trash: data.tasks.length - live.length,
    memos: data.memos.filter((m) => !m.deletedAt).length,
    people: data.people.filter((p) => !p.deletedAt).length,
    goals: data.goals.week.lines.length + data.goals.month.lines.length + data.goals.year.lines.length,
    schedule: data.schedule.lines.length,
    history: data.goalLog.length + data.scheduleLog.length,
    xp: data.dragon.total,
  };
}

export function snapshot(data) {
  const out = {};
  for (const k of KEYS) out[k] = structuredClone(data[k]);
  return out;
}

export function buildExport(data, at) {
  return { app: APP_ID, format: FORMAT, exportedAt: at, data: snapshot(data) };
}

/** Checks a file the user picked. Nothing is written here. */
export function validateImport(obj) {
  try {
    if (!isObj(obj)) fail('JSONの形が違います');
    if (obj.app !== APP_ID) fail('実行リストの書き出しファイルではありません');
    if (obj.format !== FORMAT) fail('対応していない版のファイルです（版: ' + String(obj.format).slice(0, 10) + '）');
    const data = cleanState(obj.data);
    return { ok: true, data, counts: countsOf(data) };
  } catch (e) {
    if (e instanceof FormatError) return { ok: false, error: e.message };
    return { ok: false, error: '読み込めませんでした' };
  }
}

export function parseImportText(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'JSONとして読めません（ファイルが壊れているか、別のファイルです）' };
  }
  return validateImport(obj);
}

export function exportFileName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return 'jikko-list_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
}

// ---- IndexedDB ----

export class ConflictError extends Error {}

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB を開けませんでした'));
    req.onblocked = () => reject(new Error('別のタブがデータベースを使っています'));
  });
}

export function loadState(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['state'], 'readonly');
    const st = t.objectStore('state');
    const data = {};
    let rev = 0;
    for (const k of KEYS) {
      const r = st.get(k);
      r.onsuccess = () => { if (r.result !== undefined) data[k] = r.result; };
    }
    const rr = st.get('rev');
    rr.onsuccess = () => { rev = rr.result || 0; };
    t.oncomplete = () => resolve({ data, rev, empty: Object.keys(data).length === 0 });
    t.onerror = () => reject(t.error);
  });
}

/**
 * Writes the given keys in one transaction. When another tab saved in between
 * (the revision moved on), nothing is written and ConflictError is raised.
 */
export function saveKeys(db, data, keys, expectedRev) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['state'], 'readwrite');
    const st = t.objectStore('state');
    let newRev = null;
    let conflict = false;
    const r = st.get('rev');
    r.onsuccess = () => {
      const cur = r.result || 0;
      if (cur !== expectedRev) {
        conflict = true;
        t.abort();
        return;
      }
      newRev = cur + 1;
      for (const k of keys) st.put(data[k], k);
      st.put(newRev, 'rev');
    };
    t.oncomplete = () => resolve(newRev);
    t.onabort = () => reject(conflict ? new ConflictError('conflict') : (t.error || new Error('保存できませんでした')));
  });
}

function backupsTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['backups'], mode);
    let out;
    fn(t.objectStore('backups'), (v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  });
}

export function listBackups(db) {
  return backupsTx(db, 'readonly', (st, set) => {
    const r = st.getAll();
    r.onsuccess = () => set(r.result || []);
  });
}

export function putBackup(db, record) {
  return backupsTx(db, 'readwrite', (st) => { st.put(record); });
}

export function deleteBackup(db, id) {
  return backupsTx(db, 'readwrite', (st) => { st.delete(id); });
}

/** One automatic copy a day, the newest BACKUP_DAYS kept. Returns true when a copy was made. */
export async function autoBackup(db, data, today, at) {
  const all = await listBackups(db);
  const autos = all.filter((b) => b.kind === 'auto').sort((a, b) => b.date.localeCompare(a.date));
  let made = false;
  if (!autos.some((b) => b.date === today)) {
    const rec = { id: 'auto-' + today, kind: 'auto', date: today, at, counts: countsOf(data), data: snapshot(data) };
    await putBackup(db, rec);
    autos.unshift(rec);
    made = true;
  }
  for (const old of autos.slice(BACKUP_DAYS)) await deleteBackup(db, old.id);
  return made;
}

/** The copy taken right before an import or a restore (only one is kept). */
export function savePreImport(db, data, at) {
  return putBackup(db, { id: 'pre-import', kind: 'pre', date: at.slice(0, 10), at, counts: countsOf(data), data: snapshot(data) });
}

// ---- Storage protection ----

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* not available */ }
  return null;
}

export async function isPersisted() {
  try {
    if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted();
  } catch (e) { /* not available */ }
  return null;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (e) { /* not available */ }
  return null;
}
