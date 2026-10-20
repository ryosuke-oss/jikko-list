// "偽のGoogle": the sync file (a spreadsheet with tabs and rows) kept in memory, with the same answers the
// engine expects from google.js: files found by their marks, tabs, rows read from a row to the end
// (columns G..J, trailing empty cells and rows left out, like the Sheets API), rows added after the last row
// with nothing overwritten, and the range where they landed. Faults can be injected (no signal, a lost answer,
// 429 / 5xx / 401 / 403 / 404), the rows can be changed "by hand", and every call is logged per device.

const COLS = 10;
const G = 6; // column G (0-based)

function httpError(status, message) {
  return Object.assign(new Error(message || 'HTTP ' + status), { status });
}

function offlineError() {
  return Object.assign(new Error('Failed to fetch'), { offline: true });
}

function lastNonEmpty(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].some((x) => x !== '' && x != null)) return i;
  }
  return -1;
}

function trimRow(cells) {
  const out = cells.map((x) => (x == null ? '' : String(x)));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export class FakeSheets {
  constructor() {
    this.files = [];
    this.log = [];
    this.faults = [];
    this.latency = 0; // ms: answers come back after a random wait up to this (to interleave devices)
    this.seq = 0;
    this.random = mulberry32(12345);
    this.during = null; // async (device, method) => {}: runs inside a call, before Google does anything (a person acting meanwhile)
    this.hidden = new Set(); // ids the file search does not list yet (Drive's search can lag behind)
  }

  file(id) {
    const f = this.files.find((x) => x.id === id);
    if (!f || f.deleted) throw httpError(404, 'File not found');
    return f;
  }

  /** Inject a fault: { device?, method, error: 'offline' | 'lost' | <HTTP status>, times = 1 }. */
  inject(fault) {
    this.faults.push(Object.assign({ times: 1 }, fault));
  }

  takeFault(device, method) {
    const i = this.faults.findIndex((f) => f.method === method && (!f.device || f.device === device) && f.times > 0);
    if (i < 0) return null;
    const f = this.faults[i];
    f.times -= 1;
    if (f.times <= 0) this.faults.splice(i, 1);
    return f;
  }

  async wait() {
    if (this.latency) await new Promise((r) => setTimeout(r, Math.floor(this.random() * this.latency)));
  }

  /** The google window of one device (what public/js/sync/google.js will provide in 3-3). */
  client(device) {
    const self = this;
    const wrap = (method, fn) => async (...args) => {
      self.log.push({ device, method, title: typeof args[1] === 'string' ? args[1] : null, rows: method === 'appendRows' ? args[2].length : 0 });
      await self.wait();
      if (self.during) await self.during(device, method);
      const f = self.takeFault(device, method);
      if (f && f.error === 'offline') throw offlineError();
      if (f && typeof f.error === 'number') throw httpError(f.error);
      const out = fn(...args);
      await self.wait();
      if (f && f.error === 'lost') throw offlineError(); // done on the server, the answer never arrived
      return out === undefined ? undefined : structuredClone(out);
    };
    return {
      findFiles: wrap('findFiles', () => self.files.filter((f) => !f.deleted && !self.hidden.has(f.id) && f.props.app === 'jikko-list' && f.props.kind === 'sync').map((f) => ({ id: f.id, name: f.name, trashed: f.trashed }))),
      createFile: wrap('createFile', () => {
        self.seq += 1;
        const f = { id: 'file-' + self.seq, name: '実行リスト_同期データ（手で直さない）', props: { app: 'jikko-list', kind: 'sync', v: '1' }, trashed: false, deleted: false, tabs: new Map([['説明', [['このファイルは実行リストの同期データです。手で直さないでください。']]]]) };
        self.files.push(f);
        return { id: f.id };
      }),
      addTab: wrap('addTab', (id, title, header) => {
        const f = self.file(id);
        if (f.tabs.has(title)) throw httpError(400, 'A sheet with the name already exists');
        f.tabs.set(title, [header.slice(0, COLS)]);
      }),
      readTabs: wrap('readTabs', (id, ranges) => {
        const f = self.file(id);
        const data = ranges.filter((r) => f.tabs.has(r.title)).map((r) => ({ title: r.title, fromRow: r.fromRow, rows: self.slice(f.tabs.get(r.title), r.fromRow) }));
        return { titles: [...f.tabs.keys()], data };
      }),
      appendRows: wrap('appendRows', (id, title, rows) => {
        const f = self.file(id);
        const tab = f.tabs.get(title);
        if (!tab) throw httpError(400, 'Unable to parse range');
        const at = lastNonEmpty(tab) + 1; // 0-based index of the first new row
        const add = rows.map((r) => {
          const cells = r.map((x) => (x == null ? '' : String(x)));
          while (cells.length < COLS) cells.push('');
          return cells.slice(0, COLS);
        });
        tab.splice(at, 0, ...add);
        return { updatedRange: "'" + title + "'!A" + (at + 1) + ':J' + (at + add.length) };
      }),
    };
  }

  /** Columns G..J from fromRow (1-based) to the last row with something in it. */
  slice(tab, fromRow) {
    const end = lastNonEmpty(tab);
    const out = [];
    for (let i = fromRow - 1; i <= end; i += 1) out.push(trimRow((tab[i] || []).slice(G, COLS)));
    return out;
  }

  // ---- what a person could do in the spreadsheet ----

  only() {
    const live = this.files.filter((f) => !f.deleted);
    if (live.length !== 1) throw new Error('expected one file, found ' + live.length);
    return live[0];
  }

  tab(title, fileId) {
    const f = fileId ? this.file(fileId) : this.only();
    return f.tabs.get(title);
  }

  /** Remove one row (1-based row number) of a tab, the way a person would. */
  deleteRow(title, row, fileId) {
    this.tab(title, fileId).splice(row - 1, 1);
  }

  /** Overwrite one cell (column letter, 1-based row). */
  setCell(title, row, col, value, fileId) {
    const tab = this.tab(title, fileId);
    tab[row - 1][col.charCodeAt(0) - 65] = value;
  }

  appendRaw(title, cells, fileId) {
    const tab = this.tab(title, fileId);
    const row = cells.slice();
    while (row.length < COLS) row.push('');
    tab.splice(lastNonEmpty(tab) + 1, 0, row);
  }

  trash(fileId) {
    this.file(fileId).trashed = true;
  }

  /** Every tab: rows A..J (copies). */
  snapshot(fileId) {
    const f = fileId ? this.file(fileId) : this.only();
    const out = {};
    for (const [t, rows] of f.tabs) out[t] = rows.map((r) => r.slice());
    return out;
  }

  calls(device, method) {
    return this.log.filter((l) => (!device || l.device === device) && (!method || l.method === method)).length;
  }
}

/** A small seeded random generator (the same numbers every run). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
