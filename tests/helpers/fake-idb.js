// A small IndexedDB kept in memory, enough for public/js/store.js: open with a version (upgrades and
// "versionchange" for connections still open), object stores with in-line or out-of-line keys,
// get / put / getAll / delete / clear, and transactions that are written at the end or not at all (abort).
// Transactions of one database run one after another. Values are copied in and out (structuredClone).

const DELETED = Symbol('deleted');

function domError(name, message) {
  const e = new Error(message || name);
  e.name = name;
  return e;
}

function nextTask() {
  return new Promise((r) => setTimeout(r, 0));
}

class Request {
  constructor(tx) {
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.transaction = tx || null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

function fire(target, name, extra) {
  const fn = target && target[name];
  if (typeof fn !== 'function') return { prevented: false };
  let prevented = false;
  const ev = Object.assign({ target, type: name.slice(2), preventDefault: () => { prevented = true; } }, extra || {});
  fn.call(target, ev);
  return { prevented };
}

class StoreNames {
  constructor(file) {
    this.file = file;
  }
  contains(n) {
    return this.file.stores.has(n);
  }
  get length() {
    return this.file.stores.size;
  }
  item(i) {
    return [...this.file.stores.keys()].sort()[i] || null;
  }
}

class ObjectStore {
  constructor(tx, name) {
    this.tx = tx;
    this.name = name;
  }
  get keyPath() {
    return this.tx.file.stores.get(this.name).keyPath;
  }
  request(op, args) {
    if (this.tx.finished) throw domError('TransactionInactiveError');
    if (op !== 'get' && op !== 'getAll' && this.tx.mode === 'readonly') throw domError('ReadOnlyError');
    const req = new Request(this.tx);
    this.tx.requests.push({ store: this.name, op, args, req });
    this.tx.kick();
    return req;
  }
  get(key) { return this.request('get', [key]); }
  getAll() { return this.request('getAll', []); }
  put(value, key) { return this.request('put', [structuredClone(value), key]); }
  delete(key) { return this.request('delete', [key]); }
  clear() { return this.request('clear', []); }
  count() { return this.request('getAll', ['count']); }
}

class Transaction {
  constructor(conn, names, mode) {
    this.db = conn;
    this.file = conn.file;
    this.names = names;
    this.mode = mode;
    this.requests = [];
    this.writes = new Map(); // store -> Map(key -> value | DELETED)
    this.cleared = new Set();
    this.error = null;
    this.aborted = false;
    this.finished = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.started = false;
    this.file.queue = this.file.queue.then(() => this.run());
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw domError('NotFoundError', 'store not in transaction: ' + name);
    return new ObjectStore(this, name);
  }
  abort() {
    if (this.finished) throw domError('InvalidStateError');
    this.aborted = true;
    if (!this.error) this.error = domError('AbortError');
  }
  kick() { /* requests are picked up by run() */ }
  view(store) {
    const base = this.cleared.has(store) ? new Map() : this.file.stores.get(store).data;
    const w = this.writes.get(store) || new Map();
    const out = new Map(base);
    for (const [k, v] of w) {
      if (v === DELETED) out.delete(k);
      else out.set(k, v);
    }
    return out;
  }
  exec({ store, op, args }) {
    const def = this.file.stores.get(store);
    if (op === 'get') {
      const v = this.view(store).get(args[0]);
      return v === undefined ? undefined : structuredClone(v);
    }
    if (op === 'getAll') {
      const m = this.view(store);
      if (args[0] === 'count') return m.size;
      return [...m.keys()].sort().map((k) => structuredClone(m.get(k)));
    }
    if (!this.writes.has(store)) this.writes.set(store, new Map());
    const w = this.writes.get(store);
    if (op === 'put') {
      const fault = this.file.faults;
      if (fault.putFails > 0 && (!fault.store || fault.store === store)) {
        fault.putFails -= 1;
        throw domError('QuotaExceededError', 'the disk is full (test)');
      }
      const [value, key] = args;
      const k = def.keyPath ? value[def.keyPath] : key;
      if (k === undefined || k === null) throw domError('DataError', 'no key');
      w.set(k, value);
      return k;
    }
    if (op === 'delete') {
      w.set(args[0], DELETED);
      return undefined;
    }
    if (op === 'clear') {
      this.cleared.add(store);
      w.clear();
      return undefined;
    }
    throw new Error('unknown op ' + op);
  }
  async run() {
    await nextTask(); // the code that made the transaction adds its requests and handlers first
    if (this.db.closedHard) this.aborted = true;
    while (!this.aborted && this.requests.length) {
      const r = this.requests.shift();
      try {
        r.req.result = this.exec(r);
        r.req.readyState = 'done';
        try {
          fire(r.req, 'onsuccess');
        } catch (e) {
          this.abort();
          this.error = e;
        }
      } catch (e) {
        r.req.error = e;
        r.req.readyState = 'done';
        const { prevented } = fire(r.req, 'onerror');
        if (!prevented) {
          this.error = e;
          this.abort();
          fire(this, 'onerror');
        }
      }
    }
    this.finished = true;
    for (const r of this.requests) {
      r.req.error = domError('AbortError');
      fire(r.req, 'onerror');
    }
    if (this.aborted) {
      fire(this, 'onabort');
      return;
    }
    for (const s of this.cleared) this.file.stores.get(s).data = new Map();
    for (const [s, w] of this.writes) {
      const data = this.file.stores.get(s).data;
      for (const [k, v] of w) {
        if (v === DELETED) data.delete(k);
        else data.set(k, v);
      }
    }
    fire(this, 'oncomplete');
  }
}

class Connection {
  constructor(file, name, version) {
    this.file = file;
    this.name = name;
    this.version = version;
    this.objectStoreNames = new StoreNames(file);
    this.onversionchange = null;
    this.onclose = null;
    this.closed = false;
    this.upgrading = false;
  }
  createObjectStore(name, opts) {
    if (!this.upgrading) throw domError('InvalidStateError', 'not upgrading');
    if (this.file.stores.has(name)) throw domError('ConstraintError', 'exists: ' + name);
    this.file.stores.set(name, { keyPath: (opts && opts.keyPath) || null, data: new Map() });
    return {};
  }
  deleteObjectStore(name) {
    if (!this.upgrading) throw domError('InvalidStateError', 'not upgrading');
    this.file.stores.delete(name);
  }
  transaction(names, mode = 'readonly') {
    if (this.closed) throw domError('InvalidStateError', 'closed');
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.file.stores.has(n)) throw domError('NotFoundError', 'no store ' + n);
    return new Transaction(this, list, mode);
  }
  close() {
    this.closed = true;
    this.file.conns.delete(this);
  }
}

/** Every database of one "browser" (one device). `faults.putFails = n` makes the next n puts fail (disk full). */
export function createFakeIndexedDB() {
  const files = new Map();
  const factory = {
    files,
    open(name, version) {
      const req = new Request(null);
      req.onupgradeneeded = null;
      req.onblocked = null;
      (async () => {
        await nextTask();
        let file = files.get(name);
        if (!file) {
          file = { version: 0, stores: new Map(), conns: new Set(), queue: Promise.resolve(), faults: { putFails: 0, store: null } };
          files.set(name, file);
        }
        const want = version === undefined ? Math.max(1, file.version) : version;
        if (want < file.version) {
          req.error = domError('VersionError');
          fire(req, 'onerror');
          return;
        }
        if (want > file.version) {
          for (const c of [...file.conns]) fire(c, 'onversionchange', { oldVersion: file.version, newVersion: want });
          if (file.conns.size) {
            fire(req, 'onblocked', { oldVersion: file.version, newVersion: want });
            for (let i = 0; i < 1000 && file.conns.size; i += 1) await nextTask();
            if (file.conns.size) {
              req.error = domError('AbortError', 'blocked');
              fire(req, 'onerror');
              return;
            }
          }
          await file.queue;
          const oldVersion = file.version;
          const backup = new Map([...file.stores].map(([k, v]) => [k, { keyPath: v.keyPath, data: new Map(v.data) }]));
          const conn = new Connection(file, name, want);
          conn.upgrading = true;
          file.version = want;
          req.result = conn;
          try {
            fire(req, 'onupgradeneeded', { oldVersion, newVersion: want });
          } catch (e) {
            file.stores = backup;
            file.version = oldVersion;
            req.error = e;
            fire(req, 'onerror');
            return;
          }
          conn.upgrading = false;
          file.conns.add(conn);
          req.readyState = 'done';
          fire(req, 'onsuccess');
          return;
        }
        const conn = new Connection(file, name, file.version);
        file.conns.add(conn);
        req.result = conn;
        req.readyState = 'done';
        fire(req, 'onsuccess');
      })();
      return req;
    },
    /** Test helper: make the next n puts fail (optionally only in one store). */
    failPuts(name, n, store) {
      const f = files.get(name);
      f.faults.putFails = n;
      f.faults.store = store || null;
    },
    /** Test helper: a copy of every store's content. */
    dump(name) {
      const f = files.get(name);
      const out = { version: f.version, stores: {} };
      for (const [s, def] of f.stores) out.stores[s] = Object.fromEntries([...def.data].map(([k, v]) => [k, structuredClone(v)]));
      return out;
    },
  };
  return factory;
}
