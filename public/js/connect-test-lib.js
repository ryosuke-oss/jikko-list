// Pure helpers for the connection test page (/connect-test.html).
// No DOM access here, so `node --test` can check them.
// The client ID, the account and the file ID are never written in the code:
// the page keeps them in this browser only.

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
// Must match the redirect URI registered for the client exactly.
export const REDIRECT_PATH = '/connect-test.html';

export const TEST_FILE_NAME = '実行リスト_接続テスト（消してよい）';
// Marks for files.list. kind=sync is kept for the real sync file and never used here.
export const APP_PROPS = Object.freeze({ app: 'jikko-list', kind: 'connect-test' });
export const HEADER_ROW = Object.freeze(['日時', '端末', '種類', '見出し', '状態', '操作', '項目キー', '版', '元の版', '中身']);
export const BIG_ROWS = 500;
export const BIG_CHARS = 10000;
// A token with less than 5 minutes left counts as expired.
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** The client ID is not a secret, but it stays out of the code. Only a light shape check. */
export function cleanClientId(input) {
  const v = String(input == null ? '' : input).trim();
  return /^[A-Za-z0-9._-]{20,200}$/.test(v) ? v : null;
}

/**
 * Login URL for the token flow (response_type=token), opened by moving the whole page.
 * Without a hint the account chooser is shown; with the last account as a hint
 * Google is asked to come back without any screen (prompt=none).
 */
export function buildAuthUrl({ clientId, origin, state, loginHint }) {
  const p = new URLSearchParams();
  p.set('client_id', clientId);
  p.set('redirect_uri', origin + REDIRECT_PATH);
  p.set('response_type', 'token');
  p.set('scope', SCOPE);
  p.set('state', state);
  if (loginHint) {
    p.set('prompt', 'none');
    p.set('login_hint', loginHint);
  } else {
    p.set('prompt', 'select_account');
  }
  return AUTH_ENDPOINT + '?' + p.toString();
}

/**
 * What Google put after '#' (errors may also come after '?').
 * Returns null when the URL carries no login result.
 */
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

/** 32 random bytes as hex (the "state" that ties the answer to our own departure). */
export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 'k•••@e•••.com' — enough to tell accounts apart in a copied log. */
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? s[0] + '•••' : '';
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return s[0] + '•••@' + (domain[0] || '') + '•••' + tld;
}

/** First 6 characters and the length only. */
export function maskId(id) {
  const s = String(id || '');
  if (!s) return '';
  return s.slice(0, 6) + '…（' + s.length + '字）';
}

export function utf8Bytes(s) {
  return new TextEncoder().encode(String(s)).length;
}

/** "'tab name'!A1" with quotes doubled, ready for encodeURIComponent. */
export function a1Range(tab, cells) {
  return "'" + String(tab).replace(/'/g, "''") + "'!" + cells;
}

/** Short device name from the user agent (used for tab names and logs). */
export function deviceName(ua, maxTouchPoints) {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s) || (/Macintosh/.test(s) && Number(maxTouchPoints) > 1)) return 'iPad';
  if (/Macintosh/.test(s)) return 'Mac';
  if (/Windows/.test(s)) return 'Windows';
  if (/Android/.test(s)) return 'Android';
  return 'ブラウザ';
}

/** Repeat a phrase until it is exactly n characters long. */
export function fillTo(phrase, n) {
  let out = '';
  while (out.length < n) out += phrase;
  return out.slice(0, n);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD HH:MM:SS' in local time (column A is for people, the app never trusts it). */
export function stamp(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * The one-row test. Column D starts with '=' on purpose: written as RAW it must come back
 * as the same text, not as a formula.
 */
export function smallRow({ at, device, runId }) {
  const body = JSON.stringify({ id: 'small-' + runId, title: '1行のテスト', note: '改行も\n入る・"引用符"・\\記号' });
  return [at, device, 'テスト', '=1+1（数式にならない確認）', '試し', '追加', 'test:small-' + runId, '1-' + runId.slice(0, 16), '[]', body];
}

/**
 * One big row shaped like the largest task the app can hold
 * (3 links of 2,000 characters, a 2,000-character memo, 5 route notes …),
 * padded so that column J is exactly `chars` characters.
 */
export function bigRow(runId, i, at, device, chars = BIG_CHARS) {
  const link = (name) => fillTo('https://example.com/' + name + '/' + i + '/', 2000);
  const task = {
    id: 'big-' + runId + '-' + i,
    title: fillTo('長いタスク名の試し' + i + '・', 120),
    status: 'doing',
    rank: 'A',
    star: true,
    due: '2026-10-23',
    size: '3d',
    nextAction: fillTo('次にやることの試し・', 120),
    memo: fillTo('これは接続テスト用の文章です。消してかまいません。', 2000),
    links: { slack: link('slack'), doc: link('doc'), web: link('web') },
    route: [0, 1, 2, 3, 4].map((k) => ({ id: 's' + k, kind: 'confirm', who: 'p' + k, state: 'wait', note: fillTo('段のメモの試し・', 60), at: '2026-10-19' })),
    createdAt: '2026-10-19T12:00:00.000Z',
    updatedAt: '2026-10-19T12:00:00.000Z',
    pad: '',
  };
  const base = JSON.stringify(task).length;
  task.pad = 'x'.repeat(Math.max(0, chars - base));
  const body = JSON.stringify(task);
  return [at, device, 'テスト', '大きい行 ' + (i + 1), '試し', '追加', 'test:big-' + runId + '-' + i, '1-' + runId.slice(0, 12) + String(i).padStart(4, '0'), '[]', body];
}

export function bigRows(runId, at, device, count = BIG_ROWS, chars = BIG_CHARS) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(bigRow(runId, i, at, device, chars));
  return rows;
}

/** Split rows so that each request body stays under maxBytes (UTF-8). Every chunk has at least one row. */
export function chunkRows(rows, maxBytes) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const r of rows) {
    const n = utf8Bytes(JSON.stringify(r)) + 1;
    if (cur.length && size + n > maxBytes) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Compare what was sent with what came back (rows of strings).
 * Sheets leaves out trailing empty cells, so a missing cell counts as ''.
 */
export function compareRows(sent, got) {
  const rows = Math.max(sent.length, got.length);
  let same = 0;
  let chars = 0;
  let firstDiff = null;
  for (let r = 0; r < rows; r += 1) {
    const a = sent[r] || [];
    const b = got[r] || [];
    const cols = Math.max(a.length, b.length);
    let ok = r < sent.length && r < got.length;
    for (let c = 0; c < cols; c += 1) {
      const x = a[c] == null ? '' : String(a[c]);
      const y = b[c] == null ? '' : String(b[c]);
      chars += y.length;
      if (x !== y) {
        ok = false;
        if (!firstDiff) firstDiff = { row: r + 1, col: String.fromCharCode(65 + c), sentLength: x.length, gotLength: y.length };
      }
    }
    if (ok) same += 1;
    else if (!firstDiff) firstDiff = { row: r + 1, col: '-', sentLength: a.length, gotLength: b.length };
  }
  return { rows, same, diff: rows - same, chars, firstDiff };
}

/** files.list query for the test files (the mark, not the name). */
export function markQuery(props = APP_PROPS) {
  const parts = Object.keys(props).map((k) => "appProperties has { key='" + k + "' and value='" + props[k] + "' }");
  parts.push('trashed = false');
  return parts.join(' and ');
}

/** "A3:J502" from an updatedRange like "'tab'!A3:J502". */
export function rangeCells(updatedRange) {
  const s = String(updatedRange || '');
  const i = s.lastIndexOf('!');
  return i >= 0 ? s.slice(i + 1) : s;
}
