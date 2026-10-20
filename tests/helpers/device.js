// One "device" for the sync tests: its own IndexedDB (in memory), the app's data saved the way app.js saves it,
// and a sync engine talking to the shared fake Google. A second engine on the same database is a second tab.

import { createFakeIndexedDB } from './fake-idb.js';
import * as ST from '../../public/js/store.js';
import { createSyncEngine, localLock } from '../../public/js/sync/engine.js';
import { itemsOf } from '../../public/js/sync/records.js';
import { canonical } from '../../public/js/sync/rev.js';
import { settle } from '../../public/js/dragon.js';
import { ymd } from '../../public/js/util.js';

export function makeClock(startIso) {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    today: () => ymd(new Date(t)),
    tick(ms) { t += ms; },
    set(iso) { t = Date.parse(iso); },
    ms: () => t,
  };
}

function fill(raw, today, at) {
  const base = ST.newState(today, at);
  const out = {};
  for (const k of ST.KEYS) out[k] = raw[k] === undefined ? base[k] : raw[k];
  return out;
}

export async function makeDevice(sheets, name, opts = {}) {
  const factory = opts.idb || createFakeIndexedDB();
  const db = await ST.openDb(factory);
  const clock = opts.clock || makeClock('2026-10-20T01:00:00.000Z');
  const dev = {
    name,
    factory,
    db,
    clock,
    online: true,
    editing: new Set(),
    lockMap: new Map(),
    storage: ST.syncStorage(db),
    google: sheets.client(name),
    applied: [],
  };
  dev.newEngine = (extra = {}) => createSyncEngine(Object.assign({
    storage: dev.storage,
    google: dev.google,
    clock: dev.clock,
    lock: localLock(dev.lockMap),
    sleep: async () => {},
    online: () => dev.online,
    limits: { minIntervalMs: 0, perHour: 1e9 },
    hooks: { isEditing: (k) => dev.editing.has(k), onApplied: (data, rev) => dev.applied.push(rev) },
  }, extra));
  dev.engine = dev.newEngine();
  /** The app's first start: a new, empty data set (or the given one). */
  dev.init = async (state) => {
    const s = state || ST.newState(clock.today(), clock.now());
    const { rev } = await ST.loadState(db);
    await ST.saveKeys(db, s, ST.KEYS, rev);
    return s;
  };
  dev.load = async () => {
    const l = await ST.loadState(db);
    return { data: ST.cleanState(fill(l.data, clock.today(), clock.now())), rev: l.rev };
  };
  dev.data = async () => (await dev.load()).data;
  /** Change the data the way the app does (one save of every key, refused when another tab saved first). */
  dev.edit = async (fn) => {
    const { data, rev } = await dev.load();
    const out = await fn(data);
    settle(data.dragon, data.tasks, null, clock.now());
    await ST.saveKeys(db, data, ST.KEYS, rev);
    return out;
  };
  dev.sync = () => dev.engine.sync();
  dev.connect = (ask, deviceName) => dev.engine.connect(ask || { create: async () => true, receive: async () => true }, deviceName || name);
  /** The items of the data as canonical text, to compare two devices. */
  dev.items = async () => {
    const m = itemsOf(await dev.data());
    return Object.fromEntries([...m.keys()].sort().map((k) => [k, canonical(m.get(k))]));
  };
  dev.syncRecords = () => ST.loadSync(db);
  return dev;
}

/** Two devices on one fake Google: A makes the sync file, B receives it. */
export async function connectedPair(sheets, opts = {}) {
  const clock = opts.clock || makeClock('2026-10-20T01:00:00.000Z');
  const A = await makeDevice(sheets, opts.aName || 'Mac', { clock });
  const B = await makeDevice(sheets, opts.bName || 'iPhone', { clock });
  await A.init(opts.aState);
  await B.init(opts.bState);
  const ra = await A.connect();
  const rb = await B.connect();
  return { A, B, clock, ra, rb };
}
