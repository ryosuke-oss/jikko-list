// Everything that talks to Google, and the only part of the app that does.
// - Logging in: the whole page moves to Google's sign-in screen and comes back with a key (token flow).
//   No program of Google's is loaded (the page's Content-Security-Policy stays closed to other sites).
// - Drive (www.googleapis.com): find the sync file by its marks, mark it, see who is logged in.
// - Sheets (sheets.googleapis.com): make the file, add this device's tab, read new rows, add rows.
// The permission is drive.file: only files this app made can be seen or changed.
// The client ID, the file ID and the account are never written in the code: they are kept on the device.

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const REDIRECT_PATH = '/'; // must match the redirect URI registered for the client exactly
export const FILE_NAME = '実行リスト_同期データ（手で直さない）';
export const APP_PROPS = Object.freeze({ app: 'jikko-list', kind: 'sync', v: '1' });
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // a key with less than 5 minutes left counts as run out

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// The "説明" tab: what the file is, written once when the file is made.
export const EXPLANATION = Object.freeze([
  'このファイルは「実行リスト」の同期データです（PC とスマホの中身をそろえるために、アプリが自動で書き込みます）。',
  '手で直さないでください。行を消したり書き換えたりすると、その行は使われなくなります（アプリは読み直して続けます）。',
  '端末ごとのタブ（記録_端末名_…）に、変更が1回ごとに1行ずつ下に足されます。前の行は書き換えません。',
  '困ったときは、このスプレッドシートの「ファイル → 変更履歴」で前の状態に戻せます。',
  '「完全に消す」をしたタスクやメモも、過去の行には消す前の中身が残ります。',
]);

/** The client ID is not a secret, but it stays out of the code. Only a light shape check. */
export function cleanClientId(input) {
  const v = String(input == null ? '' : input).trim();
  return /^[A-Za-z0-9._-]{20,200}$/.test(v) ? v : null;
}

/**
 * The address of Google's sign-in screen (token flow). silent: come back without any screen (prompt=none,
 * with the last account as a hint); otherwise the account chooser is shown.
 */
export function buildAuthUrl({ clientId, origin, state, loginHint, silent }) {
  const p = new URLSearchParams();
  p.set('client_id', clientId);
  p.set('redirect_uri', origin + REDIRECT_PATH);
  p.set('response_type', 'token');
  p.set('scope', SCOPE);
  p.set('state', state);
  if (loginHint) p.set('login_hint', loginHint);
  p.set('prompt', silent && loginHint ? 'none' : 'select_account');
  return AUTH_ENDPOINT + '?' + p.toString();
}

/** What Google put after '#' (errors may also come after '?'). null when the address carries no login result. */
export function parseAuthReturn(hash, search) {
  const read = (s) => new URLSearchParams(String(s || '').replace(/^[#?]/, ''));
  const h = read(hash);
  const q = read(search);
  const get = (k) => (h.has(k) ? h.get(k) : q.get(k));
  const token = get('access_token');
  const error = get('error');
  if (!token && !error) return null;
  const expiresIn = Number(get('expires_in'));
  return {
    token: token || null,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
    scope: get('scope') || '',
    state: get('state') || '',
    error: error || null,
  };
}

/** 32 random bytes as hex (the "state" that ties Google's answer to our own departure). */
export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A key that can still be used (more than 5 minutes left). */
export function tokenUsable(token, now = Date.now()) {
  return Boolean(token && typeof token.value === 'string' && token.value && typeof token.expiresAt === 'number' && token.expiresAt - EXPIRY_MARGIN_MS > now);
}

/** 'k•••@e•••.com': enough to tell accounts apart on the screen. */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? s[0] + '•••' : '';
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return s[0] + '•••@' + (domain[0] || '') + '•••' + (dot > 0 ? domain.slice(dot) : '');
}

/** A short device name from the browser (Mac / iPhone / ...), used for the tab name and "Mac のほうを残す". */
export function defaultDeviceName(ua, maxTouchPoints) {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s) || (/Macintosh/.test(s) && Number(maxTouchPoints) > 1)) return 'iPad';
  if (/Macintosh/.test(s)) return 'Mac';
  if (/Windows/.test(s)) return 'Windows';
  if (/Android/.test(s)) return 'Android';
  return 'ブラウザ';
}

/** "'tab name'!G2:J" with quotes doubled. */
export function a1(tab, cells) {
  return "'" + String(tab).replace(/'/g, "''") + "'!" + cells;
}

/** files.list query: the marks, not the name (a renamed or moved file is still found; trashed ones too, to tell). */
export function markQuery(props = APP_PROPS) {
  return Object.keys(props).map((k) => "appProperties has { key='" + k + "' and value='" + props[k] + "' }").join(' and ');
}

function randomSheetId() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return 1 + (a[0] % 2000000000);
}

/**
 * The window the sync engine uses (see engine.js). getToken() gives the key now (or null).
 * Errors: an HTTP-like `status` (401 / 403 / 404 / 429 / 5xx), or `offline: true` when the request could not be
 * made at all (no signal, or the browser stopped it).
 */
export function createGoogle({ getToken, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));

  async function api(method, url, body) {
    const token = getToken();
    if (!token) throw Object.assign(new Error('Googleにログインしていません'), { status: 401 });
    const init = {
      method,
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      throw Object.assign(new Error('通信できませんでした'), { offline: true });
    }
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      throw Object.assign(new Error('返事を受け取れませんでした'), { offline: true });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const g = json && json.error;
      const msg = g ? [g.status, g.message].filter(Boolean).join(' ') : text.replace(/\s+/g, ' ').slice(0, 200);
      throw Object.assign(new Error('Google HTTP ' + res.status + (msg ? ' ' + msg.slice(0, 200) : '')), { status: res.status });
    }
    return json || {};
  }

  const sheet = (id, tail) => SHEETS + '/' + encodeURIComponent(id) + (tail || '');

  return {
    hasToken: () => Boolean(getToken()),

    /** The account logged in (for the screen and the next login hint). */
    async whoAmI() {
      const r = await api('GET', DRIVE + '/about?fields=' + encodeURIComponent('user(displayName,emailAddress)'));
      const u = r.user || {};
      return { email: u.emailAddress || '', name: u.displayName || '' };
    },

    /** The files with the sync marks (in the trash too, so that a trashed file can be told apart). */
    async findFiles() {
      const url = DRIVE + '/files?q=' + encodeURIComponent(markQuery()) +
        '&fields=' + encodeURIComponent('files(id,name,trashed)') + '&pageSize=20&spaces=drive';
      const r = await api('GET', url);
      return (r.files || []).map((f) => ({ id: f.id, name: f.name || '', trashed: f.trashed === true }));
    },

    /** A new sync file with the "説明" tab (the marks come next, with markFile: each is tried again on its own). */
    async createFile() {
      const r = await api('POST', SHEETS + '?fields=spreadsheetId', {
        properties: { title: FILE_NAME, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
        sheets: [{
          properties: { title: '説明', sheetId: 0 },
          data: [{ startRow: 0, startColumn: 0, rowData: EXPLANATION.map((t) => ({ values: [{ userEnteredValue: { stringValue: t } }] })) }],
        }],
      });
      const id = r.spreadsheetId;
      if (!id) throw Object.assign(new Error('ファイルのIDが返ってきませんでした'), { status: 500 });
      return { id };
    },

    /** The marks that let every device find the file (searched by these, not by the name). */
    async markFile(id) {
      await api('PATCH', DRIVE + '/files/' + encodeURIComponent(id) + '?fields=id', { appProperties: APP_PROPS });
    },

    /** This device's tab: the header row (frozen) and a "warn before editing" protection, in one call. */
    async addTab(fileId, title, header) {
      const sheetId = randomSheetId();
      await api('POST', sheet(fileId, ':batchUpdate'), {
        requests: [
          { addSheet: { properties: { sheetId, title, gridProperties: { frozenRowCount: 1, columnCount: 10 } } } },
          { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: header.map((v) => ({ userEnteredValue: { stringValue: String(v) } })) }], fields: 'userEnteredValue' } },
          { addProtectedRange: { protectedRange: { range: { sheetId }, description: '実行リストが書き込む記録です。手で直さないでください。', warningOnly: true } } },
        ],
      });
    },

    /**
     * New rows (columns G..J) of the asked tabs. The tab list and sizes come first, so a tab that no longer exists
     * is left out and a start below the last row gives no rows (Google would refuse those ranges).
     */
    async readTabs(fileId, ranges) {
      const meta = await api('GET', sheet(fileId, '?fields=' + encodeURIComponent('sheets.properties(title,gridProperties.rowCount)')));
      const props = (meta.sheets || []).map((s) => s.properties || {});
      const titles = props.map((p) => p.title);
      const rowCount = new Map(props.map((p) => [p.title, (p.gridProperties && p.gridProperties.rowCount) || 0]));
      const ask = ranges.filter((r) => rowCount.has(r.title) && r.fromRow <= rowCount.get(r.title));
      const data = [];
      if (ask.length) {
        const qs = ask.map((r) => 'ranges=' + encodeURIComponent(a1(r.title, 'G' + r.fromRow + ':J'))).join('&');
        const res = await api('GET', sheet(fileId, '/values:batchGet?' + qs + '&majorDimension=ROWS'));
        const vr = res.valueRanges || [];
        ask.forEach((r, i) => data.push({ title: r.title, fromRow: r.fromRow, rows: (vr[i] && vr[i].values) || [] }));
      }
      for (const r of ranges) {
        if (rowCount.has(r.title) && !ask.includes(r)) data.push({ title: r.title, fromRow: r.fromRow, rows: [] });
      }
      return { titles, data };
    },

    /** Rows added under the last row of the tab: values kept as typed (RAW), new rows inserted, nothing overwritten. */
    async appendRows(fileId, title, rows) {
      const url = sheet(fileId, '/values/' + encodeURIComponent(a1(title, 'A1')) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false');
      const r = await api('POST', url, { majorDimension: 'ROWS', values: rows });
      return { updatedRange: (r.updates && r.updates.updatedRange) || '' };
    },
  };
}
