// The sync (7-7 of the spec). One run:
//   1. reads this device's data and sync records from the database (one run at a time: Web Locks)
//   2. reads the new rows of every device's tab
//   3. turns what was changed on this device into new versions
//   4. finds the current end(s) of each item; two or more ends are put together (or asked)
//   5. adds this device's new versions to its own tab (never to another device's tab, never rewriting a row)
//   6. reads again to make sure they are there (and that nobody wrote meanwhile)
//   7. puts the result on the screen, except what is being edited, in one transaction with the records
// The engine never talks to the network itself. Everything outside goes through `google`:
//   findFiles()                       -> [{ id, name, trashed }]   (the files marked app=jikko-list kind=sync)
//   createFile()                      -> { id }                    (with the "説明" tab; the marks too when markFile is absent)
//   markFile(id)                      -> void                      (optional: the marks, tried again on its own)
//   addTab(fileId, title, header)     -> void                      (frozen header row, "warn when edited")
//   readTabs(fileId, [{ title, fromRow }]) -> { titles: [every tab now], data: [{ title, fromRow, rows }] }
//        rows = columns G..J from fromRow to the last row (one call; tabs that no longer exist are left out)
//   appendRows(fileId, title, rows)   -> { updatedRange }          (RAW values, new rows inserted, nothing overwritten)
// Errors carry an HTTP-like `status` (401 / 403 / 404 / 429 / 5xx); a network failure has `offline: true`
// (google.js turns the browser's "Failed to fetch" into that, so a mistake in this code is never taken for "no signal").
// Tests give it a fake Google kept in memory.

import { canonical, contentHash, versionName, checkVersion, normParents, tips, mergeBase, isVersionName } from './rev.js';
import { mergeItem, newerSide } from './merge.js';
import * as R from './records.js';
import { cleanState, countsOf, KEYS, newState, ConflictError } from '../store.js';
import { settle } from '../dragon.js';
import { todayStr } from '../util.js';

export const HEADER = ['日時', '端末', '種類', '見出し', '状態', '操作', '項目キー', '版', '元の版', '中身'];
export const CHUNK = 500; // rows per call when adding
export const CELL_MAX = 50000; // characters in one cell (Google's limit)
export const LIMITS = { minIntervalMs: 10 * 1000, perHour: 120 }; // a stop against a run-away loop
export const RETRY_WAITS = [1000, 3000, 9000]; // 429 / 5xx: wait and try again, 3 times
const MAX_ROUNDS = 3; // step 6 -> 4 again when another device wrote meanwhile
const FILE_CHECK_MS = 30 * 60 * 1000; // how often the file itself is looked at (in the trash? a second one?)
const LOCK_NAME = 'jikko-list:sync'; // one sync at a time on this device (Web Locks)

const mutexes = new Map();

/** Web Locks when the browser has them (one sync at a time across tabs); otherwise one at a time in this page. */
export function defaultLock(name, fn) {
  const locks = globalThis.navigator && globalThis.navigator.locks;
  if (locks && typeof locks.request === 'function') return locks.request(name, fn);
  return localLock(mutexes)(name, fn);
}

/** A lock kept in memory (tests give each device its own, shared by that device's tabs). */
export function localLock(map = new Map()) {
  return (name, fn) => {
    const prev = map.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    map.set(name, run.catch(() => {}));
    return run;
  };
}

function isOffline(e) {
  return Boolean(e && e.offline === true);
}

function errorKind(e) {
  if (isOffline(e)) return 'offline';
  const s = e && e.status;
  if (s === 401) return 'need-login';
  if (s === 403) return 'forbidden';
  if (s === 404) return 'not-found';
  if (s === 429 || (s >= 500 && s < 600)) return 'busy';
  if (e && e.kind) return e.kind;
  return 'failed';
}

// choices: the open questions ({ left, right, base, fields }). shown: items whose screen shows a question's content
// for the time being ({ h: hash, c: content }) instead of a version; kept until a real version is put on the screen.
// What the engine owns in the config (the app owns the rest: the client ID, the key, the account...).
const ENGINE_CONFIG = ['status', 'fileId', 'myTab', 'deviceId', 'deviceName', 'madeFile'];

function pickConfig(c) {
  const out = {};
  for (const k of ENGINE_CONFIG) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

function freshProgress() {
  return { tabs: {}, pending: [], choices: {}, shown: {}, dirty: [], runs: [], lastSyncAt: null, lastError: null, fileCheckedAt: null };
}

function normProgress(p) {
  const out = Object.assign(freshProgress(), p ? structuredClone(p) : {});
  for (const t of Object.values(out.tabs)) {
    t.read = Math.max(0, Math.floor(t.read || 0));
    t.last = t.last || '';
    t.bad = t.bad || 0;
  }
  return out;
}

function stateFromLoaded(loaded, today, at) {
  const base = newState(today, at);
  if (loaded.empty) return base;
  const raw = {};
  for (const k of KEYS) raw[k] = loaded.data[k] === undefined ? base[k] : loaded.data[k];
  return cleanState(raw);
}

/** Items of the data with the hash of each content: Map key -> { c, h }. */
function hashedItems(state) {
  const out = new Map();
  for (const [k, c] of R.itemsOf(state)) out.set(k, { c, h: contentHash(c) });
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Column A: the device's own clock, for people reading the sheet ("2026-10-19 15:02:11"). */
export function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** First row number of "'tab'!A12:J13" (or of "tab!A12"), or null. */
export function startRowOf(range) {
  const m = /!\$?[A-Z]+\$?(\d+)/.exec(String(range || ''));
  return m ? Number(m[1]) : null;
}

function rowHash(row) {
  return contentHash((row || []).slice(0, 4).map((x) => (x == null ? '' : String(x))));
}

function isBlank(row) {
  return !row || row.every((x) => x == null || String(x) === '');
}

/** A row (columns G..J) checked: the key, the name, the parents and the content must agree. null = unreadable. */
export async function parseRow(row) {
  if (!Array.isArray(row) || row.length < 4) return null;
  const [key, name, ps, cj] = row.map((x) => (x == null ? '' : String(x)));
  if (!R.parseKey(key) || !isVersionName(name)) return null;
  if (cj.length > CELL_MAX || ps.length > 4000) return null;
  let parents;
  let raw;
  try {
    parents = JSON.parse(ps);
    raw = JSON.parse(cj);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(parents) || parents.length > 50 || !parents.every(isVersionName)) return null;
  if (!(await checkVersion(key, name, parents, raw))) return null;
  let content;
  try {
    content = R.cleanContent(key, raw);
  } catch (e) {
    return null;
  }
  return { key, name, parents: normParents(parents), content };
}

/** The 10 columns of a row (A..F for people reading the sheet, G..J for the app). */
export function buildRow(key, name, rec, deviceName) {
  const L = R.rowLabels(key, rec.c, rec.o);
  return [localTime(rec.t), deviceName, L.type, L.head, L.state, L.op, key, name, JSON.stringify(normParents(rec.p)), canonical(rec.c)];
}

/** The clock used when none is given: the time now, and today's date on this device (never the UTC date). */
export function defaultClock() {
  return { now: () => new Date().toISOString(), today: () => todayStr() };
}

export function createSyncEngine(opts) {
  const { storage, google } = opts;
  // "today" must be the app's own date (the date check runs first); the device's local date by default, never UTC
  const clock = opts.clock || defaultClock();
  const hooks = opts.hooks || {};
  const lock = opts.lock || defaultLock;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const online = opts.online || (() => !(globalThis.navigator && globalThis.navigator.onLine === false));
  const limits = Object.assign({}, LIMITS, opts.limits);
  const runExclusive = hooks.runExclusive || ((fn) => fn());

  /**
   * Data and records in one transaction; the app takes the new data before any other save of its own runs.
   * hooks.commit(data, expectedRev, write): the app runs write() in its own save queue (it may refuse with a
   * ConflictError when the person's own changes are waiting: they go first, and this run tries again).
   */
  function commitAndAdopt(data, expectedRev, parts, records) {
    const write = () => storage.commit(data, KEYS, expectedRev, parts, records);
    if (hooks.commit) return hooks.commit(data, expectedRev, write);
    return runExclusive(async () => {
      const rev = await write();
      if (hooks.onApplied) hooks.onApplied(data, rev);
      return rev;
    });
  }

  async function call(fn) {
    for (let i = 0; ; i += 1) {
      try {
        return await fn();
      } catch (e) {
        const s = e && e.status;
        if ((s === 429 || (s >= 500 && s < 600)) && i < RETRY_WAITS.length) {
          await sleep(RETRY_WAITS[i]);
          continue;
        }
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------- one run's working set

  function newRun(config, progress, applied) {
    return {
      config,
      progress,
      applied,
      revs: new Map(), // key -> { key, v: { name: rec } }  (loaded on demand)
      changedRevs: new Set(),
      touched: new Set(),
      // keys whose versions changed and are not on the screen yet: kept in the records until they are,
      // so a run that fails half-way never forgets them
      dirty: new Set(progress.dirty || []),
      pendingSet: new Set(progress.pending.map((x) => x[1])),
      stats: { sent: 0, received: 0, merged: 0, mergedFrom: new Set(), unreadable: 0, applied: 0, deferred: 0, choices: 0 },
      myNames: null, // names found in this device's tab during a read from the top
      resendMine: false,
    };
  }

  async function loadRevs(run, keys) {
    const want = [...new Set(keys)].filter((k) => !run.revs.has(k));
    if (!want.length) return;
    const got = await storage.getRevs(want);
    for (const k of want) run.revs.set(k, got.get(k) || { key: k, v: {} });
  }

  function addVersion(run, key, name, rec) {
    const doc = run.revs.get(key);
    if (doc.v[name]) return false;
    doc.v[name] = rec;
    run.changedRevs.add(key);
    run.touched.add(key);
    run.dirty.add(key);
    return true;
  }

  function addPending(run, key, name) {
    if (run.pendingSet.has(name)) return;
    run.pendingSet.add(name);
    run.progress.pending.push([key, name]);
  }

  function changedRevRecords(run) {
    const out = [...run.changedRevs].map((k) => run.revs.get(k));
    run.changedRevs.clear();
    return out;
  }

  async function saveRun(run) {
    run.progress.dirty = [...run.dirty].sort();
    await storage.saveSync({ progress: run.progress, applied: run.applied }, changedRevRecords(run));
  }

  // ---------------------------------------------------------------- step 3: this device's changes

  /**
   * New versions for the items changed on this device since they were last shown.
   * An item whose screen shows a question's content for the time being: that content is never sent as this
   * device's; only what the person changed on top of it is, put onto this device's own version (rebased).
   */
  async function localVersions(run, items, only = null) {
    const { applied, progress } = run;
    const at = clock.now();
    const made = [];
    const rebase = [];
    const consider = (key, content, h) => {
      const sh = progress.shown[key];
      if (sh) {
        if (sh.h !== h) rebase.push({ key, content, h, sh });
        return;
      }
      const ap = applied[key];
      if (ap && ap[1] === h) return;
      if (!ap && R.isEmptyContent(key, content)) return;
      made.push({ key, content, h, parents: ap ? [ap[0]] : [] });
    };
    for (const [key, it] of items) consider(key, it.c, it.h);
    // a period or a day that is no longer in the data counts as empty; nothing else is ever sent as removed
    // (`only`: just these keys were read from the data; every other key is left alone)
    for (const key of Object.keys(applied)) {
      if (items.has(key) || (only && !only.has(key))) continue;
      const t = R.typeOf(key);
      if (t === 'goal' || t === 'schedule') {
        const c = { lines: [] };
        consider(key, c, contentHash(c));
      }
    }
    if (!made.length && !rebase.length) return 0;
    await loadRevs(run, made.concat(rebase).map((m) => m.key));
    for (const x of rebase) {
      // what the person changed on top of the question's content, put onto this device's own version
      const vs = run.revs.get(x.key).v;
      const ap = applied[x.key];
      let parent = ap && vs[ap[0]] ? ap[0] : null;
      if (!parent) {
        const ch = progress.choices[x.key];
        if (ch && vs[ch.left] && vs[ch.right]) parent = newerSide(x.key, vs[ch.left].c, vs[ch.right].c, ch.left, ch.right) === 'a' ? ch.left : ch.right;
        else parent = tips(vs).pop() || null;
      }
      const own = parent ? vs[parent].c : x.sh.c;
      const content = R.cleanContent(x.key, mergeItem(x.key, x.sh.c, x.content, own, { aName: '1-0000000000000000', bName: '1-0000000000000001', prefer: 'a' }).content);
      progress.shown[x.key] = { h: x.h, c: x.content }; // what the screen shows now is accounted for
      const h = contentHash(content);
      if (parent && h === contentHash(own)) continue; // nothing of its own left after all
      made.push({ key: x.key, content, h, parents: parent ? [parent] : [] });
    }
    for (const m of made) {
      const name = await versionName(m.key, m.parents, m.content);
      addVersion(run, m.key, name, { p: normParents(m.parents), c: m.content, d: run.config.deviceName, t: at, o: m.parents.length ? 'edit' : 'add', m: 1 });
      applied[m.key] = [name, m.h];
      addPending(run, m.key, name);
    }
    return made.length;
  }

  /** How many items were changed on this device and not made into versions yet (for "未送信 N件"). */
  function countChanges(applied, progress, items) {
    let n = 0;
    for (const [key, it] of items) {
      const sh = progress.shown[key];
      const ap = applied[key];
      if (sh ? sh.h !== it.h : ap ? ap[1] !== it.h : !R.isEmptyContent(key, it.c)) n += 1;
    }
    return n;
  }

  // ---------------------------------------------------------------- steps 2 and 6: reading

  async function processRows(run, title, fromRow, rows) {
    const tp = run.progress.tabs[title];
    const device = R.deviceOfTab(title);
    const parsed = [];
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      parsed.push(...(await Promise.all(part.map((row) => (isBlank(row) ? null : parseRow(row))))));
    }
    await loadRevs(run, parsed.filter(Boolean).map((v) => v.key));
    const at = clock.now();
    const mine = title === run.config.myTab;
    let others = 0;
    const confirmed = new Set();
    rows.forEach((row, i) => {
      tp.read = fromRow + i - 1;
      tp.last = rowHash(row);
      if (isBlank(row)) return;
      const v = parsed[i];
      if (!v) {
        tp.bad += 1;
        run.stats.unreadable += 1;
        return;
      }
      if (mine && run.myNames) run.myNames.add(v.name);
      if (run.pendingSet.has(v.name)) {
        // a version of this device is in the sheet: no need to send it again
        run.pendingSet.delete(v.name);
        confirmed.add(v.name);
      }
      if (addVersion(run, v.key, v.name, { p: v.parents, c: v.content, d: device, t: at, o: '' })) {
        if (!mine) {
          others += 1;
          run.stats.received += 1;
        }
      }
    });
    if (confirmed.size) run.progress.pending = run.progress.pending.filter((x) => !confirmed.has(x[1]));
    return others;
  }

  /**
   * New rows of every tab (one call; a tab seen for the first time, or changed by hand, is read again from the top).
   * Returns how many versions of other devices were new.
   */
  async function readNew(run, fullTabs, createMine = true) {
    const { config, progress } = run;
    const full = new Set(fullTabs || []);
    const ranges = Object.keys(progress.tabs).map((title) => {
      const tp = progress.tabs[title];
      if (full.has(title)) Object.assign(tp, { read: 0, last: '', bad: 0 });
      return { title, fromRow: tp.read > 0 ? tp.read + 1 : 2 };
    });
    const res = await call(() => google.readTabs(config.fileId, ranges));
    const titles = (res.titles || []).filter((t) => t.startsWith('記録_'));
    let others = 0;
    const again = [];
    for (const d of res.data || []) {
      const tp = progress.tabs[d.title];
      if (!tp) continue;
      let rows = d.rows || [];
      let from = d.fromRow;
      if (tp.read > 0) {
        // the row read last time must still be there; otherwise rows were removed or moved by hand
        if (!rows.length || rowHash(rows[0]) !== tp.last) {
          again.push(d.title);
          continue;
        }
        rows = rows.slice(1);
        from += 1;
      } else if (d.title === config.myTab) {
        run.myNames = new Set();
      }
      others += await processRows(run, d.title, from, rows);
    }
    // tabs that appeared (a new device) and tabs to read again from the top
    for (const t of titles) if (!progress.tabs[t]) { progress.tabs[t] = { read: 0, last: '', bad: 0 }; again.push(t); }
    for (const t of Object.keys(progress.tabs)) {
      if (!titles.includes(t)) {
        // the tab was removed by hand: what this device knows stays; its own tab is made again below
        delete progress.tabs[t];
        if (t === config.myTab) run.resendMine = true;
      }
    }
    if (again.length) {
      for (const t of again) {
        const tp = progress.tabs[t];
        if (tp && tp.read > 0) tp.bad = 0;
        if (t === config.myTab) {
          run.myNames = new Set();
          if (tp && tp.read > 0) run.resendMine = true;
        }
      }
      const res2 = await call(() => google.readTabs(config.fileId, again.map((title) => ({ title, fromRow: 2 }))));
      for (const d of res2.data || []) {
        const tp = progress.tabs[d.title];
        if (!tp) continue;
        Object.assign(tp, { read: 0, last: '', bad: 0 });
        others += await processRows(run, d.title, 2, d.rows || []);
      }
    }
    if (!progress.tabs[config.myTab] && createMine) {
      await call(() => google.addTab(config.fileId, config.myTab, HEADER));
      progress.tabs[config.myTab] = { read: 0, last: '', bad: 0 };
      run.myNames = new Set();
      run.resendMine = true;
    }
    if (run.resendMine && run.myNames) await resendMissingMine(run);
    await saveRun(run);
    return others;
  }

  /** Rows of this device's tab were removed by hand: its own versions that are gone are sent again. */
  async function resendMissingMine(run) {
    run.resendMine = false;
    const found = run.myNames;
    run.myNames = null;
    const all = await storage.getAllRevs();
    for (const doc of all) {
      for (const [name, rec] of Object.entries(doc.v)) {
        if (!rec.m || found.has(name)) continue;
        if (!run.revs.has(doc.key)) run.revs.set(doc.key, doc);
        addPending(run, doc.key, name);
      }
    }
  }

  // ---------------------------------------------------------------- step 4: ends and merges

  /**
   * For each key: the version to show, or a question. Two or more ends are put together two at a time, in
   * the order of their names (the same on every device); an automatic merge becomes a new version.
   */
  async function resolve(run, keys) {
    await loadRevs(run, keys);
    const at = clock.now();
    const out = new Map(); // key -> { tip } | { choice, content }
    for (const key of [...new Set(keys)].sort()) {
      const doc = run.revs.get(key);
      const vs = doc.v;
      const ts = tips(vs);
      if (!ts.length) continue;
      let left = ts[0];
      let question = null;
      for (let i = 1; i < ts.length && !question; i += 1) {
        const right = ts[i];
        const baseName = mergeBase(vs, left, right);
        const m = mergeItem(key, baseName ? vs[baseName].c : null, vs[left].c, vs[right].c, { aName: left, bName: right });
        const content = R.cleanContent(key, m.content);
        if (m.conflicts.length) {
          question = { left, right, base: baseName, fields: m.conflicts.map((f) => f.field), content };
          break;
        }
        const name = await versionName(key, [left, right], content);
        if (addVersion(run, key, name, { p: normParents([left, right]), c: content, d: run.config.deviceName, t: at, o: 'merge', m: 1 })) {
          addPending(run, key, name);
          run.stats.merged += 1;
          for (const n of [left, right]) if (vs[n].d && vs[n].d !== run.config.deviceName) run.stats.mergedFrom.add(vs[n].d);
        }
        left = name;
      }
      if (question) {
        run.progress.choices[key] = { left: question.left, right: question.right, base: question.base, fields: question.fields };
        out.set(key, { choice: true, content: question.content });
      } else {
        delete run.progress.choices[key];
        out.set(key, { tip: left, content: vs[left].c });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- step 5: adding rows

  async function sendPending(run) {
    const { config, progress } = run;
    if (!progress.pending.length) return 0;
    await loadRevs(run, progress.pending.map((x) => x[0]));
    progress.pending = progress.pending.filter(([k, n]) => run.revs.get(k).v[n]);
    run.pendingSet = new Set(progress.pending.map((x) => x[1]));
    const list = progress.pending.slice();
    const rows = list.map(([k, n]) => buildRow(k, n, run.revs.get(k).v[n], config.deviceName));
    const tp = progress.tabs[config.myTab];
    let expected = 2 + tp.read;
    let sent = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const res = await call(() => google.appendRows(config.fileId, config.myTab, part));
      const start = startRowOf(res && res.updatedRange);
      // the rows must land right after the rows already read; otherwise rows were added or removed by hand
      if (start !== expected) {
        run.checkMine = true;
        run.resendMine = true;
      }
      expected = (start || expected) + part.length;
      sent += part.length;
    }
    run.stats.sent += sent;
    return sent;
  }

  // ---------------------------------------------------------------- step 7: the screen

  /**
   * Put the resolved versions into the data, in one transaction with the records. Items being edited, items
   * changed after the run started, and periods / days not shown yet wait for a later run.
   */
  async function applyToData(run, resolved, snap) {
    const today = clock.today();
    const keepDirty = [...run.dirty].filter((k) => !resolved.has(k));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await storage.loadState();
      const at = clock.now();
      const cur = stateFromLoaded(loaded, today, at);
      const curItems = hashedItems(cur);
      const applied = Object.assign({}, run.applied);
      const shown = Object.assign({}, run.progress.shown);
      const dirty = new Set(keepDirty);
      let changed = 0;
      for (const [key, r] of resolved) {
        const sh = shown[key];
        const h = contentHash(r.content);
        const now = curItems.get(key);
        if (r.tip && !sh && applied[key] && applied[key][0] === r.tip) continue; // already on the screen
        if (!r.tip && sh && sh.h === h && now && now.h === h) continue; // the question's content is shown
        if (hooks.isEditing && hooks.isEditing(key)) { dirty.add(key); continue; }
        const before = snap.get(key);
        if ((before ? before.h : null) !== (now ? now.h : null)) { dirty.add(key); continue; } // changed meanwhile
        if (!(now && now.h === h)) {
          if (R.applyItem(cur, key, r.content, { today, at }) !== 'ok') { dirty.add(key); continue; }
          changed += 1;
        }
        if (r.tip) {
          applied[key] = [r.tip, h];
          delete shown[key];
        } else {
          shown[key] = { h, c: r.content };
        }
      }
      const progress = Object.assign({}, run.progress, { shown, dirty: [...dirty].sort(), lastSyncAt: at });
      const records = changedRevRecords(run);
      try {
        let rev = loaded.rev;
        let data = null;
        if (changed) {
          settle(cur.dragon, cur.tasks, '同期', at);
          data = cleanState(cur);
          rev = await commitAndAdopt(data, loaded.rev, { progress, applied }, records);
        } else {
          await storage.saveSync({ progress, applied }, records);
        }
        run.applied = applied;
        run.progress = progress;
        run.dirty = dirty;
        run.stats.applied += changed;
        run.stats.deferred = dirty.size;
        return { rev, state: data };
      } catch (e) {
        for (const r of records) run.changedRevs.add(r.key); // the versions are saved with the next try
        if (!(e instanceof ConflictError)) throw e;
        // another tab saved first: read again and try again (the version shown never moves without the data)
      }
    }
    // three times in a row: leave the screen as it is and try again next time
    for (const k of resolved.keys()) run.dirty.add(k);
    await saveRun(run);
    run.stats.deferred = run.dirty.size;
    return { rev: null, state: null, gaveUp: true };
  }

  // ---------------------------------------------------------------- one run

  function summary(status, run, extra) {
    const p = run ? run.progress : null;
    return Object.assign({
      status,
      ok: status === 'synced',
      pending: p ? p.pending.length : 0,
      choices: p ? Object.keys(p.choices).length : 0,
      stats: run ? Object.assign({}, run.stats, { mergedFrom: [...run.stats.mergedFrom] }) : null,
    }, extra || {});
  }

  async function stillOn() {
    const sy = await storage.loadSync();
    return sy.config && sy.config.status === 'on';
  }

  async function runSync() {
    const sy = await storage.loadSync();
    const config = sy.config;
    if (!config || config.status === 'off' || !config.fileId) return summary('off', null);
    if (config.status === 'paused') return summary('paused', null);
    if (config.status !== 'on') return summary('need-connect', null);
    const progress = normProgress(sy.progress);
    const applied = Object.assign({}, sy.applied || {});
    const today = clock.today();
    const loaded = await storage.loadState();
    const state = stateFromLoaded(loaded, today, clock.now());
    const snap = hashedItems(state);
    if (!online()) return summary('offline', null, { pending: progress.pending.length + countChanges(applied, progress, snap) });
    if (google.hasToken && !google.hasToken()) return summary('need-login', null, { pending: progress.pending.length + countChanges(applied, progress, snap) });
    const nowMs = Date.parse(clock.now());
    progress.runs = (progress.runs || []).filter((t) => nowMs - Date.parse(t) < 3600 * 1000);
    const last = progress.runs.length ? Date.parse(progress.runs[progress.runs.length - 1]) : null;
    if (progress.runs.length >= limits.perHour || (last !== null && nowMs - last < limits.minIntervalMs)) {
      const retryAt = progress.runs.length >= limits.perHour ? Date.parse(progress.runs[0]) + 3600 * 1000 : last + limits.minIntervalMs;
      return summary('later', null, { retryAt: new Date(retryAt).toISOString() });
    }
    progress.runs.push(clock.now());
    const run = newRun(config, progress, applied);
    try {
      // 3. this device's changes become versions (saved before anything is sent)
      await localVersions(run, snap);
      await saveRun(run);
      if (!(await stillOn())) return summary('paused', run); // paused meanwhile: no call from here on
      // the file itself, once in a while: in the trash or a second one -> stop (never make one silently).
      // Not found by the search (it can lag just after the file was made): the read below answers 404 if it is gone.
      if (!progress.fileCheckedAt || nowMs - Date.parse(progress.fileCheckedAt) >= FILE_CHECK_MS) {
        const files = await call(() => google.findFiles());
        const mine = files.find((f) => f.id === config.fileId);
        const stop = (kind) => Object.assign(new Error('the sync file: ' + kind), { kind });
        if (mine && mine.trashed) throw stop('file-trashed');
        if (files.filter((f) => !f.trashed).length > 1) throw stop('two-files');
        if (mine) progress.fileCheckedAt = clock.now();
      }
      // 2. new rows of every tab
      await readNew(run);
      let rounds = 0;
      let resolved = new Map();
      for (;;) {
        // 4. ends and merges of everything new, of the open questions and of what waited last time
        const keys = new Set([...run.touched, ...Object.keys(run.progress.choices), ...run.dirty]);
        for (const [k, r] of await resolve(run, [...keys])) resolved.set(k, r);
        run.touched.clear();
        await saveRun(run);
        if (!(await stillOn())) return summary('paused', run);
        // 5. send this device's versions to its own tab
        const sent = await sendPending(run);
        if (!(await stillOn())) { await saveRun(run); return summary('paused', run); } // our rows are confirmed next time
        // 6. read again: our rows must be there; when another device wrote meanwhile, go round again
        const others = sent || run.checkMine ? await readNew(run, run.checkMine ? [config.myTab] : []) : 0;
        run.checkMine = false;
        rounds += 1;
        if ((!others && !run.progress.pending.length) || rounds >= MAX_ROUNDS) break;
      }
      // what the last read brought in is looked at again now (merges made here are sent by the next run)
      if (run.touched.size) {
        for (const [k, r] of await resolve(run, [...run.touched])) resolved.set(k, r);
        run.touched.clear();
        await saveRun(run);
      }
      // 7. put the result on the screen (and 8. the rows read, the time) in one transaction
      run.stats.choices = Object.keys(progress.choices).length;
      progress.lastError = null;
      const res = await applyToData(run, resolved, snap);
      return summary(res.gaveUp ? 'retry' : 'synced', run, { rev: res.rev });
    } catch (e) {
      const kind = errorKind(e);
      progress.lastError = { kind, at: clock.now(), message: String((e && e.message) || e).slice(0, 200) };
      try { await saveRun(run); } catch (e2) { /* keep the first error */ }
      if (kind === 'offline' || kind === 'need-login') return summary(kind, run);
      return summary('error', run, { error: kind });
    }
  }

  function sync() {
    return lock(LOCK_NAME, runSync);
  }

  // ---------------------------------------------------------------- connecting (7-12 "つなぐときの決まり")

  /** Every tab read from the top and every item resolved: the content of the sync data. */
  async function readEverything(run) {
    await readNew(run, [], false);
    const keys = [];
    const all = await storage.getAllRevs();
    for (const doc of all) {
      if (!run.revs.has(doc.key)) run.revs.set(doc.key, doc);
      keys.push(doc.key);
    }
    return resolve(run, [...new Set([...keys, ...run.touched])]);
  }

  function itemsFrom(resolved) {
    const items = new Map();
    for (const [k, r] of resolved) items.set(k, r.content);
    return items;
  }

  /**
   * Connect this device. ask.create() is called before a new sync file is made (only when none exists and this
   * device never had one); ask.receive(counts) before this device's data is replaced by the sync data (only
   * when this device has something). Returns { status: 'connected' | 'cancelled' | 'error', how, error }.
   */
  async function connect(ask = {}, deviceName) {
    return lock(LOCK_NAME, async () => {
      const sy = await storage.loadSync();
      const config = Object.assign({ status: 'off' }, sy.config || {});
      if ((config.status === 'on' || config.status === 'paused') && config.fileId) return { status: 'connected', how: 'already' };
      if (!config.deviceId) config.deviceId = R.newDeviceId();
      config.deviceName = String(deviceName || config.deviceName || '端末').slice(0, 20);
      const freshTab = !config.myTab;
      config.myTab = config.myTab || R.tabTitle(config.deviceName, config.deviceId);
      const today = clock.today();
      try {
        const files = await call(() => google.findFiles());
        let live = files.filter((f) => !f.trashed);
        // a file made here before whose marks could not be added. Another sync file found by the search (made on
        // another device meanwhile): that one is used, and the one made here stays unmarked (never two marked
        // files). Nothing found: the one made here gets its marks now and is used as it is (the search may lag).
        if (config.madeFile && google.markFile) {
          if (!live.length) {
            try {
              await call(() => google.markFile(config.madeFile));
              live = [{ id: config.madeFile, name: '', trashed: false }];
            } catch (e) {
              if (!(e && e.status === 404)) throw e; // 404: the file is gone; forgotten
            }
          }
          config.madeFile = null;
          const cur = (await storage.loadSync()).config || {};
          await storage.saveSync({ config: Object.assign({}, cur, { madeFile: null }) }, []);
        }
        if (live.length > 1) return { status: 'error', error: 'two-files' };
        if (!live.length) {
          if (config.fileId) return { status: 'error', error: files.length ? 'file-trashed' : 'file-missing' };
          // nothing to use (or only a file in the trash): a new file only when the person says so
          if (!(ask.create && (await ask.create({ trashed: files.length > 0 })))) return { status: 'cancelled' };
          const f = await call(() => google.createFile()); // made once: a lost answer is not made again here
          if (google.markFile) {
            // kept until the marks are on: a marking that fails is finished next time
            const cur = (await storage.loadSync()).config || {};
            await storage.saveSync({ config: Object.assign({}, cur, { madeFile: f.id }) }, []);
            await call(() => google.markFile(f.id));
          }
          config.fileId = f.id;
          config.madeFile = null;
          config.status = 'on';
          await call(() => google.addTab(config.fileId, config.myTab, HEADER));
          const progress = freshProgress();
          progress.tabs[config.myTab] = { read: 0, last: '', bad: 0 };
          progress.fileCheckedAt = clock.now(); // just made: the search may not list it yet
          const fresh = (await storage.loadSync()).config || {};
          await storage.saveSync({ config: Object.assign({}, fresh, pickConfig(config)), progress, applied: {} }, []);
          const first = await runSync();
          return { status: 'connected', how: 'created', sync: first };
        }
        config.fileId = live[0].id;
        const progress = freshProgress();
        progress.fileCheckedAt = clock.now();
        const run = newRun(config, progress, {});
        const resolved = await readEverything(run);
        // another device already has a tab of this name (same device name, same first characters of the id):
        // take a longer name, so that a device never writes into a tab that is not its own
        if (freshTab) {
          for (let n = 6; progress.tabs[config.myTab] && n <= 16; n += 2) config.myTab = R.tabTitle(config.deviceName, config.deviceId, n);
          if (progress.tabs[config.myTab]) return { status: 'error', error: 'tab-taken' };
        }
        const items = itemsFrom(resolved);
        const at = clock.now();
        const syncState = R.stateFromItems(items, { today, at, keep: null }).state;
        let agreed = false; // "受け取る" is asked once, even when another tab's save makes this go round again
        for (let attempt = 0; ; attempt += 1) {
          if (attempt >= 5) return { status: 'error', error: 'failed' };
          const loaded = await storage.loadState();
          const local = stateFromLoaded(loaded, today, at);
          let next;
          let how;
          let kept = false; // a copy of this device's data was kept ("同期を始める前の控え")
          if (R.isEmptyState(syncState)) {
            // the sync data is still empty: this device's data goes up; same-name people join the ones there
            how = 'sent';
            next = structuredClone(local);
            const syncPeople = [...resolved].filter(([k]) => R.typeOf(k) === 'person').map(([, r]) => r.content);
            R.adoptPeople(next, syncPeople);
            for (const [k, r] of resolved) {
              const has = R.itemOf(next, k);
              if (has && !R.isEmptyContent(k, has)) {
                // this device has its own content here: it goes up as a change on top of the version there
                if (r.tip) run.applied[k] = [r.tip, contentHash(r.content)];
                continue;
              }
              if (R.applyItem(next, k, r.content, { today, at }) === 'ok' && r.tip) run.applied[k] = [r.tip, contentHash(r.content)];
            }
          } else {
            how = 'received';
            if (!R.isEmptyState(local)) {
              if (!agreed && !(ask.receive && (await ask.receive(countsOf(syncState), countsOf(local))))) return { status: 'cancelled' };
              agreed = true;
              // an empty device has nothing to keep: the copy of an earlier connection is not overwritten by nothing
              await storage.savePreSync(local, at);
              kept = true;
            }
            const built = R.stateFromItems(items, { today, at, keep: local });
            next = built.state;
            for (const [k, r] of resolved) {
              if (built.notShown.includes(k)) continue;
              if (r.tip) run.applied[k] = [r.tip, contentHash(r.content)];
              else progress.shown[k] = { h: contentHash(r.content), c: r.content };
            }
            progress.dirty = built.notShown.slice().sort();
          }
          settle(next.dragon, next.tasks, null, at);
          const data = cleanState(next);
          config.status = 'on';
          if (!progress.tabs[config.myTab]) {
            await call(() => google.addTab(config.fileId, config.myTab, HEADER));
            progress.tabs[config.myTab] = { read: 0, last: '', bad: 0 };
          }
          const records = changedRevRecords(run);
          try {
            const fresh = (await storage.loadSync()).config || {};
            const cfg = Object.assign({}, fresh, pickConfig(config));
            await commitAndAdopt(data, loaded.rev, { config: cfg, progress, applied: run.applied }, records);
          } catch (e) {
            for (const r of records) run.changedRevs.add(r.key); // the versions made here go with the next try
            if (e instanceof ConflictError) continue; // another tab saved first: decide again with its data
            throw e;
          }
          const first = await runSync();
          return { status: 'connected', how, kept, sync: first };
        }
      } catch (e) {
        return { status: 'error', error: errorKind(e) };
      }
    });
  }

  // ---------------------------------------------------------------- questions ("どちらを残す？")

  /** The open questions with what differs: [{ key, labels, fields: [{ field, label, a, b }], a: {...}, b: {...} }]. */
  async function questions() {
    const sy = await storage.loadSync();
    const progress = normProgress(sy.progress);
    const keys = Object.keys(progress.choices).sort();
    if (!keys.length) return [];
    const docs = await storage.getRevs(keys);
    const out = [];
    for (const key of keys) {
      const ch = progress.choices[key];
      const doc = docs.get(key);
      if (!doc || !doc.v[ch.left] || !doc.v[ch.right]) continue;
      const vs = doc.v;
      const m = mergeItem(key, ch.base && vs[ch.base] ? vs[ch.base].c : null, vs[ch.left].c, vs[ch.right].c, { aName: ch.left, bName: ch.right });
      const side = (n) => ({ version: n, device: vs[n].d || '', at: vs[n].c.updatedAt || vs[n].t || null, content: vs[n].c });
      out.push({ key, labels: R.rowLabels(key, m.content, ''), fields: m.conflicts, newer: m.newer, a: side(ch.left), b: side(ch.right) });
    }
    return out;
  }

  /**
   * The answer to a question: side 'a' or 'b' (of questions()). Becomes a "選んだ結果" version whose parents are
   * the two versions that disagreed (sent by the next run), and is put on the screen.
   */
  async function choose(key, side) {
    return lock(LOCK_NAME, async () => {
      const sy = await storage.loadSync();
      const progress = normProgress(sy.progress);
      const ch = progress.choices[key];
      if (!ch || (side !== 'a' && side !== 'b')) return { ok: false, reason: 'gone' };
      const run = newRun(sy.config, progress, Object.assign({}, sy.applied || {}));
      const at = clock.now();
      const snapLoaded = await storage.loadState();
      const snap = hashedItems(stateFromLoaded(snapLoaded, clock.today(), at));
      // something changed on this device that is not a version yet: it becomes one first (never lost), and the
      // question is asked again with it
      const mineNow = snap.has(key) ? new Map([[key, snap.get(key)]]) : new Map();
      if (await localVersions(run, mineNow, new Set([key]))) {
        await resolve(run, [key]);
        await saveRun(run);
        return { ok: false, reason: 'changed' };
      }
      await loadRevs(run, [key]);
      const vs = run.revs.get(key).v;
      const ts = tips(vs);
      if (!vs[ch.left] || !vs[ch.right] || !ts.includes(ch.left) || !ts.includes(ch.right)) return { ok: false, reason: 'changed' };
      const m = mergeItem(key, ch.base && vs[ch.base] ? vs[ch.base].c : null, vs[ch.left].c, vs[ch.right].c, { aName: ch.left, bName: ch.right, prefer: side });
      const content = R.cleanContent(key, m.content);
      const name = await versionName(key, [ch.left, ch.right], content);
      if (addVersion(run, key, name, { p: normParents([ch.left, ch.right]), c: content, d: run.config.deviceName, t: at, o: 'choice', m: 1 })) addPending(run, key, name);
      delete progress.choices[key];
      // more ends remain (three devices): the next run puts them together (the key stays to be looked at)
      const others = ts.filter((t) => t !== ch.left && t !== ch.right);
      if (others.length) {
        run.dirty.add(key);
        await saveRun(run);
        return { ok: true, version: name, applied: false };
      }
      const res = await applyToData(run, new Map([[key, { tip: name, content }]]), snap);
      return { ok: true, version: name, applied: !res.gaveUp && !run.dirty.has(key) };
    });
  }

  // ---------------------------------------------------------------- pause / resume / status

  async function setStatus(status) {
    const sy = await storage.loadSync();
    if (!sy.config || !sy.config.fileId) return false;
    await storage.saveSync({ config: Object.assign({}, sy.config, { status }) }, []);
    return true;
  }

  /**
   * "この端末を外す": this device's sync records (versions read, progress, the key) are removed. The app's data and the
   * sync file stay. The client ID and the device name are kept; next time this device connects as a new one.
   */
  async function detach() {
    return lock(LOCK_NAME, async () => {
      const sy = await storage.loadSync();
      const c = sy.config || {};
      const keep = { status: 'off' };
      if (c.clientId) keep.clientId = c.clientId;
      if (c.deviceName) keep.deviceName = c.deviceName;
      if (c.madeFile) keep.madeFile = c.madeFile; // made here and not marked yet: finished at the next connect
      await storage.reset(keep);
      return true;
    });
  }

  /** What waits to be sent: versions not confirmed yet + changes not made into versions yet. No call to Google. */
  async function unsentCount() {
    const sy = await storage.loadSync();
    if (!sy.config || !sy.config.fileId) return 0;
    const progress = normProgress(sy.progress);
    const snap = hashedItems(stateFromLoaded(await storage.loadState(), clock.today(), clock.now()));
    return progress.pending.length + countChanges(Object.assign({}, sy.applied || {}), progress, snap);
  }

  async function status() {
    const sy = await storage.loadSync();
    const p = normProgress(sy.progress);
    const tabs = Object.values(p.tabs);
    return {
      status: (sy.config && sy.config.status) || 'off',
      deviceName: sy.config ? sy.config.deviceName : '',
      pending: p.pending.length,
      choices: Object.keys(p.choices).length,
      rows: tabs.reduce((s, t) => s + t.read, 0),
      unreadable: tabs.reduce((s, t) => s + t.bad, 0),
      lastSyncAt: p.lastSyncAt,
      lastError: p.lastError,
      waiting: p.dirty.length,
    };
  }

  return {
    sync,
    connect,
    questions,
    choose,
    pause: () => setStatus('paused'),
    resume: () => setStatus('on'),
    detach,
    status,
    unsentCount,
    isQuestion: async (key) => Boolean(normProgress((await storage.loadSync()).progress).choices[key]),
    questionKeys: async () => Object.keys(normProgress((await storage.loadSync()).progress).choices),
  };
}
