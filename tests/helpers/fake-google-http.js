// "偽のGoogle" that answers like the real web addresses (Drive v3, Sheets v4 and the sign-in screen), on top of
// FakeSheets (the spreadsheet kept in memory). Used by the unit tests of google.js (as a fetch) and by the browser
// checks (Playwright answers the page's requests to Google with it). Only what the app calls is answered.

import { FakeSheets } from './fake-google.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_GRID = 1000; // a new sheet has 1000 rows; rows inserted by "append" make it longer

function json(status, body) {
  return { status, body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=UTF-8' } };
}

function gErr(status, message) {
  return json(status, { error: { code: status, message, status: { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED' }[status] || 'INTERNAL' } });
}

/** "'tab ''x'''!G2:J" -> { title, col, row } */
export function parseA1(range) {
  const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range) || /^([^!']+)!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!m) return null;
  return { title: m[1].replace(/''/g, "'"), col: m[2], row: Number(m[3]), endCol: m[4] || m[2] };
}

export class FakeGoogleHttp {
  constructor(sheets) {
    this.sheets = sheets || new FakeSheets();
    this.tokens = new Map(); // token -> { email, expiresAt }
    this.grid = new Map(); // fileId + '\n' + title -> rows in the grid
    this.requests = []; // { method, url, status }
    this.account = { email: 'someone@example.com', name: 'テスト' };
    this.signedIn = true; // the browser has a Google session (prompt=none can come back without a screen)
    this.faults = []; // { match: RegExp, status, times }
    this.seq = 0;
    this.now = () => Date.now();
  }

  issueToken(ms = 3600 * 1000) {
    this.seq += 1;
    const t = 'ya29.fake-' + this.seq + '-' + Math.random().toString(36).slice(2, 10);
    this.tokens.set(t, { email: this.account.email, name: this.account.name, expiresAt: this.now() + ms });
    return t;
  }

  expireAll() {
    for (const v of this.tokens.values()) v.expiresAt = 0;
  }

  gridRows(fileId, title, tab) {
    const k = fileId + '\n' + title;
    if (!this.grid.has(k)) this.grid.set(k, Math.max(DEFAULT_GRID, tab ? tab.length : 0));
    return this.grid.get(k);
  }

  inject(match, status, times = 1) {
    this.faults.push({ match, status, times });
  }

  /** The sign-in screen: the page comes back to redirect_uri with the key after '#' (or an error). */
  signIn(url) {
    const u = new URL(url);
    const p = u.searchParams;
    const back = new URL(p.get('redirect_uri'));
    const out = new URLSearchParams();
    if (p.get('prompt') === 'none' && !this.signedIn) {
      out.set('error', 'login_required');
    } else {
      out.set('access_token', this.issueToken());
      out.set('token_type', 'Bearer');
      out.set('expires_in', '3599');
      out.set('scope', p.get('scope'));
    }
    out.set('state', p.get('state') || '');
    back.hash = out.toString();
    return back.toString();
  }

  /** Answer one request: { method, url, headers, body } -> { status, body, headers }. */
  handle({ method, url, headers, body }) {
    const res = this.route(method, url, headers || {}, body);
    this.requests.push({ method, url, status: res.status });
    return res;
  }

  route(method, url, headers, body) {
    for (const f of this.faults) {
      if (f.times > 0 && f.match.test(method + ' ' + url)) {
        f.times -= 1;
        return gErr(f.status, 'injected');
      }
    }
    const auth = String(headers.authorization || headers.Authorization || '');
    const tok = this.tokens.get(auth.replace(/^Bearer /, ''));
    if (!tok || tok.expiresAt <= this.now()) return gErr(401, 'Request had invalid authentication credentials.');
    const u = new URL(url);
    const data = body ? JSON.parse(body) : null;
    const S = this.sheets;
    // a key belongs to one account; a file made with one account cannot be seen with another (drive.file)
    const mine = (f) => !f.owner || f.owner === tok.email;
    if (url.startsWith(DRIVE + '/about')) return json(200, { user: { displayName: tok.name, emailAddress: tok.email } });
    if (method === 'GET' && u.origin + u.pathname === DRIVE + '/files') {
      const q = u.searchParams.get('q') || '';
      const want = [...q.matchAll(/key='([^']+)' and value='([^']+)'/g)].map((m) => [m[1], m[2]]);
      const files = S.files.filter((f) => !f.deleted && mine(f) && !S.hidden.has(f.id) && want.every(([k, v]) => f.props[k] === v));
      return json(200, { files: files.map((f) => ({ id: f.id, name: f.name, trashed: f.trashed })) });
    }
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (method === 'PATCH' && m) {
      const f = S.files.find((x) => x.id === decodeURIComponent(m[1]) && !x.deleted && mine(x));
      if (!f) return gErr(404, 'File not found');
      Object.assign(f.props, data.appProperties || {});
      return json(200, { id: f.id });
    }
    if (method === 'POST' && u.origin + u.pathname === SHEETS) {
      S.seq += 1;
      const id = 'sheet-' + S.seq + '-' + Math.random().toString(36).slice(2, 8);
      const tabs = new Map();
      for (const sh of data.sheets || []) {
        const rows = [];
        for (const d of sh.data || []) for (const r of d.rowData || []) rows.push((r.values || []).map((v) => (v.userEnteredValue ? String(v.userEnteredValue.stringValue) : '')));
        tabs.set(sh.properties.title, rows);
      }
      S.files.push({ id, name: data.properties.title, props: {}, trashed: false, deleted: false, tabs, owner: tok.email });
      return json(200, { spreadsheetId: id });
    }
    m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
    if (!m) return gErr(404, 'unknown address ' + url);
    const file = S.files.find((x) => x.id === decodeURIComponent(m[1]) && !x.deleted && mine(x));
    if (!file) return gErr(404, 'Requested entity was not found.');
    const tail = m[2];
    if (method === 'GET' && tail === '') {
      return json(200, { sheets: [...file.tabs.entries()].map(([title, rows]) => ({ properties: { title, gridProperties: { rowCount: this.gridRows(file.id, title, rows) } } })) });
    }
    if (method === 'POST' && tail === ':batchUpdate') {
      let sheetTitle = null;
      const ids = new Map();
      for (const r of data.requests || []) {
        if (r.addSheet) {
          const t = r.addSheet.properties.title;
          if (file.tabs.has(t)) return gErr(400, 'A sheet with the name "' + t + '" already exists.');
          file.tabs.set(t, []);
          ids.set(r.addSheet.properties.sheetId, t);
          sheetTitle = t;
        } else if (r.updateCells) {
          const t = ids.get(r.updateCells.start.sheetId) || sheetTitle;
          const rows = file.tabs.get(t);
          const vals = r.updateCells.rows.map((row) => row.values.map((v) => String(v.userEnteredValue.stringValue)));
          vals.forEach((v, i) => { rows[r.updateCells.start.rowIndex + i] = v.slice(); });
        }
      }
      return json(200, { replies: [] });
    }
    if (method === 'GET' && tail === '/values:batchGet') {
      const ranges = u.searchParams.getAll('ranges');
      const valueRanges = [];
      for (const r of ranges) {
        const a = parseA1(r);
        if (!a || !file.tabs.has(a.title)) return gErr(400, 'Unable to parse range: ' + r);
        const tab = file.tabs.get(a.title);
        if (a.row > this.gridRows(file.id, a.title, tab)) return gErr(400, 'Range (' + r + ') exceeds grid limits.');
        valueRanges.push({ range: r, majorDimension: 'ROWS', values: S.slice(tab, a.row) });
      }
      return json(200, { spreadsheetId: file.id, valueRanges });
    }
    m = /^\/values\/(.+):append$/.exec(tail);
    if (method === 'POST' && m) {
      if (u.searchParams.get('valueInputOption') !== 'RAW' || u.searchParams.get('insertDataOption') !== 'INSERT_ROWS') return gErr(400, 'the app must append RAW values with INSERT_ROWS');
      const a = parseA1(decodeURIComponent(m[1]));
      if (!a || !file.tabs.has(a.title)) return gErr(400, 'Unable to parse range');
      const tab = file.tabs.get(a.title);
      let last = tab.length - 1;
      while (last >= 0 && !(tab[last] || []).some((x) => x !== '' && x != null)) last -= 1;
      const rows = data.values.map((r) => r.map((x) => (x == null ? '' : String(x))));
      tab.splice(last + 1, 0, ...rows);
      this.grid.set(file.id + '\n' + a.title, this.gridRows(file.id, a.title, tab) + rows.length);
      const start = last + 2;
      return json(200, { spreadsheetId: file.id, updates: { updatedRange: "'" + a.title.replace(/'/g, "''") + "'!A" + start + ':J' + (start + rows.length - 1), updatedRows: rows.length } });
    }
    return gErr(404, 'unknown address ' + url);
  }

  /** A fetch for Node tests (same shape as the browser's). Requests nobody answers fail like "no signal". */
  fetch() {
    return async (url, init = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const r = this.handle({ method: init.method || 'GET', url, headers: init.headers || {}, body: init.body });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
    };
  }
}
