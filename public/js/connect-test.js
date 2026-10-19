// Connection test for the planned PC <-> phone sync (/connect-test.html).
// Checks that this site can log in to Google by moving the page (token flow),
// come back with a key, and use a spreadsheet that it created itself (drive.file only).
// Nothing from the task list is sent: only the test rows built in connect-test-lib.js.
// The key (access token) is never shown, and the address that carries it is cleaned at once.

import { h, fill } from './dom.js';
import * as L from './connect-test-lib.js';

// ---------------------------------------------------------------- 1. clean the address bar first

const RETURNED = L.parseAuthReturn(location.hash, location.search);
if (RETURNED || location.hash) history.replaceState(null, '', location.pathname);

// ---------------------------------------------------------------- storage (this browser only)

const PREFIX = 'jikko-list.connect-test.';
const K = {
  clientId: PREFIX + 'clientId',
  account: PREFIX + 'account',
  token: PREFIX + 'token',
  pending: PREFIX + 'pending',
  returns: PREFIX + 'returns',
  log: PREFIX + 'log',
  file: PREFIX + 'file',
};
const LOG_MAX = 300;
const RETURNS_MAX = 20;
const CHUNK_BYTES = 2 * 1024 * 1024;

function storage(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch (e) {
    return null;
  }
}
const LS = storage('local');
const SS = storage('session');

function getJson(store, key) {
  if (!store) return null;
  try {
    const v = store.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function setJson(store, key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function drop(store, key) {
  if (!store) return;
  try { store.removeItem(key); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- state

const DEVICE = L.deviceName(navigator.userAgent, navigator.maxTouchPoints);

function displayMode() {
  const standalone = navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return standalone ? 'ホーム画面版' : 'ブラウザ';
}

const S = {
  clientId: null,
  account: null,   // { email, name }
  token: null,     // { value, expiresAt, receivedAt, display, scope }
  file: null,      // { id, url } of the file made on this device
  tab: null,       // the tab this page added last
  busy: false,
  banner: null,    // { kind: 'ok' | 'ng' | 'warn', text }
  editingId: false,
  moreOpen: false,
  logs: [],
  returns: [],
};

function loadToken() {
  const t = getJson(LS, K.token);
  if (t && typeof t.value === 'string' && typeof t.expiresAt === 'number' && t.expiresAt > Date.now()) return t;
  return null;
}

function tokenUsable(t) {
  return !!t && t.expiresAt - L.EXPIRY_MARGIN_MS > Date.now();
}

function minutesLeft(t) {
  return Math.max(0, Math.floor((t.expiresAt - Date.now()) / 60000));
}

// ---------------------------------------------------------------- log (kept so it survives the trip to Google)

function log(text, kind) {
  S.logs.push({ at: new Date().toISOString(), text: String(text), kind: kind || 'info' });
  if (S.logs.length > LOG_MAX) S.logs = S.logs.slice(-LOG_MAX);
  setJson(LS, K.log, S.logs);
  renderLog();
}

function hhmmss(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + '秒';
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + 'MB';
}

// ---------------------------------------------------------------- login

function login(force, via) {
  if (!S.clientId) {
    log('✗ 先にクライアントIDを保存してください', 'ng');
    return;
  }
  const hint = !force && S.account && S.account.email ? S.account.email : '';
  const state = L.randomHex(32);
  const pending = { state, mode: hint ? 'none' : 'select', via: via || 'same', startedAt: Date.now(), display: displayMode() };
  const savedS = setJson(SS, K.pending, pending);
  const savedL = setJson(LS, K.pending, pending);
  if (!savedS && !savedL) {
    log('✗ この画面に保存できないので、ログインに出かけられません（ブラウザの保存が止められている可能性）', 'ng');
    return;
  }
  const url = L.buildAuthUrl({ clientId: S.clientId, origin: location.origin, state, loginHint: hint });
  log('→ Googleへ移動（' + (hint ? '画面なしで戻る試し prompt=none・' + L.maskEmail(hint) : 'アカウントを選ぶ prompt=select_account') +
    '・' + (via === 'window' ? '別の窓' : '同じ画面') + '・開き方: ' + pending.display + '）');
  if (via === 'window') {
    const w = window.open(url, '_blank');
    log(w ? '別の窓を開きました。ログインが済んだら、この画面に戻ってください' : '✗ 別の窓を開けませんでした（ポップアップが止められた可能性）', w ? 'info' : 'ng');
    return;
  }
  location.assign(url);
}

/** Returns true when a new key was accepted. */
function handleReturn(r) {
  const now = Date.now();
  let accepted = false;
  const fromSession = getJson(SS, K.pending);
  const fromLocal = getJson(LS, K.pending);
  let pending = null;
  let where = '見つからない';
  if (r.state && fromSession && fromSession.state === r.state) {
    pending = fromSession;
    where = 'この画面（sessionStorage）';
  } else if (r.state && fromLocal && fromLocal.state === r.state) {
    pending = fromLocal;
    where = '同じ保存場所の別の画面（localStorage）';
  }
  const rec = {
    at: new Date(now).toISOString(),
    display: displayMode(),
    startDisplay: pending ? pending.display : null,
    mode: pending ? pending.mode : null,
    via: pending ? pending.via : null,
    stateWhere: where,
    gotToken: !!r.token,
    error: r.error,
    elapsedMs: pending ? now - pending.startedAt : null,
    path: location.pathname,
    ok: false,
  };

  if (!pending) {
    rec.result = r.token ? '鍵は届いたが、出かける前の乱数が無い → 使わずに捨てた' : 'エラー ' + r.error + '（出かける前の乱数も無い）';
    S.banner = { kind: 'warn', text: '△ Googleから戻ってきましたが、出かける前に保存した乱数（state）がこの画面の保存場所に見つかりません。別の保存場所で開いている可能性があります。安全のため、届いた鍵は使わずに捨てました。（開き方: ' + rec.display + '）' };
    log('△ 戻ってきたが乱数が見つからない（' + rec.result + '・開き方: ' + rec.display + '・場所: ' + rec.path + '）', 'warn');
  } else {
    drop(SS, K.pending);
    drop(LS, K.pending);
    const how = (pending.mode === 'none' ? '画面なし（prompt=none）' : 'アカウントを選ぶ') + '・' + seconds(rec.elapsedMs);
    const moved = pending.display + ' → ' + rec.display;
    if (r.error) {
      rec.result = 'エラー: ' + r.error;
      S.banner = { kind: 'ng', text: '✗ Googleから戻ってきましたが、エラーでした: ' + r.error + '（' + how + '・' + moved + '）' +
        (pending.mode === 'none' ? '。画面なしでは通れなかったので、［アカウントを選び直す］で画面ありのログインを試してください。' : '') };
      log('✗ 戻ってきたがエラー: ' + r.error + '（' + how + '・' + moved + '・乱数: ' + where + '）', 'ng');
    } else {
      const expiresIn = r.expiresIn || 3600;
      S.token = { value: r.token, expiresAt: now + expiresIn * 1000, receivedAt: now, display: rec.display, scope: r.scope };
      setJson(LS, K.token, S.token);
      rec.ok = true;
      accepted = true;
      rec.result = '鍵を受け取った';
      const scopes = r.scope.split(' ').filter(Boolean);
      const onlyFile = scopes.length === 1 && scopes[0] === L.SCOPE;
      S.banner = { kind: 'ok', text: '✓ Googleから戻ってきて、鍵を受け取りました（' + how + '・' + moved + '）' +
        (pending.display === 'ホーム画面版' && rec.display !== 'ホーム画面版' ? '。ホーム画面版から出かけましたが、戻った先はブラウザの画面です。左上の［完了］などでアプリに戻り、アプリ側で鍵を読めるか確かめてください。' : '') };
      log('✓ 戻ってきて鍵を受け取った（' + how + '・' + moved + '・乱数: ' + where + '・有効 ' + expiresIn + '秒・長さ ' + r.token.length + '字）', 'ok');
      log(onlyFile ? '✓ 許可された権限は drive.file だけ' : '△ 許可された権限: ' + (scopes.join(' ') || '（返事に無し）') +
        (scopes.includes(L.SCOPE) ? '' : '（drive.file が無い。許可の画面でチェックが外れていた可能性）'), onlyFile ? 'ok' : 'warn');
    }
  }
  S.returns.push(rec);
  if (S.returns.length > RETURNS_MAX) S.returns = S.returns.slice(-RETURNS_MAX);
  setJson(LS, K.returns, S.returns);
  return accepted;
}

/** A key saved by another window or the in-app browser (the "save on the return page" fallback). */
function adoptStoredToken(why) {
  const t = loadToken();
  S.returns = getJson(LS, K.returns) || S.returns;
  if (!t || (S.token && t.receivedAt <= S.token.receivedAt)) {
    render();
    return;
  }
  S.token = t;
  S.returns.push({ at: new Date().toISOString(), display: displayMode(), startDisplay: t.display, mode: 'adopt', via: null, stateWhere: '-',
    gotToken: true, error: null, elapsedMs: null, path: location.pathname, ok: true, result: 'ほかの画面で受け取った鍵を読めた（' + why + '）' });
  if (S.returns.length > RETURNS_MAX) S.returns = S.returns.slice(-RETURNS_MAX);
  setJson(LS, K.returns, S.returns);
  S.banner = { kind: 'ok', text: '✓ ほかの画面（' + t.display + '）で受け取った鍵を、この画面（' + displayMode() + '）で読めました' };
  log('✓ ほかの画面で受け取った鍵を読めた（' + why + '・受け取った画面: ' + t.display + '・この画面: ' + displayMode() + '）', 'ok');
  render();
  if (!S.account) run(checkAccount);
}

// ---------------------------------------------------------------- Google API calls

async function api(method, url, body) {
  if (!tokenUsable(S.token)) throw new Error('鍵がありません（先にログインしてください）');
  const init = {
    method,
    headers: { Authorization: 'Bearer ' + S.token.value },
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error('通信できませんでした（' + ((e && e.message) || e) + '）');
    err.network = true;
    throw err;
  }
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const g = json && json.error;
    const msg = g ? [g.status, g.message].filter(Boolean).join(' ') : text.replace(/\s+/g, ' ').slice(0, 200);
    const err = new Error('HTTP ' + res.status + (msg ? ' ' + msg : '') + '（' + ms + 'ms）');
    err.status = res.status;
    throw err;
  }
  return { json: json || {}, ms };
}

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

function sheetUrl(id, tail) {
  return SHEETS + '/' + encodeURIComponent(id) + (tail || '');
}

async function whoAmI() {
  const r = await api('GET', DRIVE + '/about?fields=' + encodeURIComponent('user(displayName,emailAddress)'));
  const u = r.json.user || {};
  S.account = { email: u.emailAddress || '', name: u.displayName || '' };
  setJson(LS, K.account, S.account);
  return L.maskEmail(S.account.email) + '（' + r.ms + 'ms）';
}

function checkAccount() {
  return step('ログイン中のアカウントを確かめる（about.get）', whoAmI);
}

async function append(id, tab, rows) {
  const url = sheetUrl(id, '/values/' + encodeURIComponent(L.a1Range(tab, 'A1')) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false');
  const body = JSON.stringify({ majorDimension: 'ROWS', values: rows });
  const bytes = L.utf8Bytes(body);
  const r = await api('POST', url, body);
  const u = r.json.updates || {};
  return { cells: L.rangeCells(u.updatedRange), rows: u.updatedRows || 0, ms: r.ms, bytes };
}

function expectRange(res, cells, rows) {
  if (res.cells !== cells || res.rows !== rows) {
    throw new Error('書き込み先が想定と違う（想定 ' + cells + '・' + rows + '行 → 実際 ' + res.cells + '・' + res.rows + '行）');
  }
}

async function addTab(id) {
  const title = '試し_' + DEVICE + '_' + L.randomHex(2);
  const r = await api('POST', sheetUrl(id, ':batchUpdate'), {
    requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }],
  });
  const reply = r.json.replies && r.json.replies[0] && r.json.replies[0].addSheet;
  if (!reply || reply.properties.title !== title) throw new Error('タブを足した返事が想定と違う');
  S.tab = title;
  return { title, ms: r.ms };
}

async function readRows(id, tab) {
  const r = await api('GET', sheetUrl(id, '/values/' + encodeURIComponent(L.a1Range(tab, 'A1:J')) + '?majorDimension=ROWS'));
  return { rows: r.json.values || [], ms: r.ms };
}

async function findByMark() {
  const url = DRIVE + '/files?q=' + encodeURIComponent(L.markQuery()) +
    '&fields=' + encodeURIComponent('files(id,name,createdTime,appProperties)') +
    '&orderBy=' + encodeURIComponent('createdTime desc') + '&pageSize=20&spaces=drive';
  const r = await api('GET', url);
  return { files: r.json.files || [], ms: r.ms };
}

// ---------------------------------------------------------------- the two test runs

class StepError extends Error {}

async function step(name, fn) {
  log('… ' + name);
  try {
    const detail = await fn();
    log('✓ ' + name + (detail ? '：' + detail : ''), 'ok');
  } catch (e) {
    log('✗ ' + name + '：' + ((e && e.message) || e), 'ng');
    throw new StepError(name);
  }
}

async function run(fn) {
  if (S.busy) return;
  S.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof StepError)) log('✗ ' + ((e && e.message) || e), 'ng');
  } finally {
    S.busy = false;
    render();
  }
}

/** First device: make the file, add a tab, add 1 row and 500 big rows, read back, find by the mark. */
async function runFirstDevice() {
  log('■ テスト用ファイルを作って試す（' + DEVICE + '・' + displayMode() + '）');
  const runId = L.randomHex(8);
  const at = L.stamp(new Date());
  let id = null;
  let tab = null;
  const sent = [L.HEADER_ROW.slice()];

  await step('ファイルを作る', async () => {
    const r = await api('POST', SHEETS + '?fields=' + encodeURIComponent('spreadsheetId,spreadsheetUrl,properties.title'), {
      properties: { title: L.TEST_FILE_NAME, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
      sheets: [{ properties: { title: '説明' } }],
    });
    id = r.json.spreadsheetId;
    if (!id) throw new Error('ファイルのIDが返ってこない');
    S.file = { id, url: r.json.spreadsheetUrl || '' };
    setJson(LS, K.file, S.file);
    return '「' + ((r.json.properties && r.json.properties.title) || '') + '」ID ' + L.maskId(id) + '（' + r.ms + 'ms）';
  });

  await step('目印を付ける（appProperties）', async () => {
    const r = await api('PATCH', DRIVE + '/files/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent('id,name,appProperties'), { appProperties: L.APP_PROPS });
    const ap = r.json.appProperties || {};
    if (ap.app !== L.APP_PROPS.app || ap.kind !== L.APP_PROPS.kind) throw new Error('目印が付いていない（' + JSON.stringify(ap) + '）');
    return 'app=' + ap.app + '・kind=' + ap.kind + '（' + r.ms + 'ms）';
  });

  await step('説明のタブに1行書く', async () => {
    const res = await append(id, '説明', [['このファイルは「実行リスト」の接続テストで作りました。消してかまいません。', at]]);
    expectRange(res, 'A1:B1', 1);
    return res.cells + '（' + res.ms + 'ms）';
  });

  await step('タブを足す', async () => {
    const r = await addTab(id);
    tab = r.title;
    return '「' + tab + '」（' + r.ms + 'ms）';
  });

  await step('見出しの行を足す', async () => {
    const res = await append(id, tab, [L.HEADER_ROW.slice()]);
    expectRange(res, 'A1:J1', 1);
    return res.cells + '（' + res.ms + 'ms）';
  });

  await step('1行足す', async () => {
    const row = L.smallRow({ at, device: DEVICE, runId });
    const res = await append(id, tab, [row]);
    expectRange(res, 'A2:J2', 1);
    sent.push(row);
    return res.cells + '・' + res.bytes.toLocaleString() + 'バイト（' + res.ms + 'ms）';
  });

  await step(L.BIG_ROWS + '行×約' + L.BIG_CHARS.toLocaleString() + '字を足す', async () => {
    const rows = L.bigRows(runId, at, DEVICE);
    const chars = rows.reduce((n, r) => n + r[9].length, 0);
    const startRow = sent.length + 1;
    const cells = 'A' + startRow + ':J' + (startRow + rows.length - 1);
    let one = null;
    try {
      one = await append(id, tab, rows);
    } catch (e) {
      // A body that is too large may come back as an HTTP error or as a dropped connection.
      if (e.status === 401 || e.status === 403) throw e;
      log('△ 1回では送れなかった：' + e.message + ' → ' + mb(CHUNK_BYTES) + 'ずつに分けて送ります', 'warn');
    }
    if (one) {
      expectRange(one, cells, rows.length);
      sent.push(...rows);
      return '1回で送れた：' + one.cells + '・J列 ' + chars.toLocaleString() + '字・送った量 ' + mb(one.bytes) + '（' + seconds(one.ms) + '）';
    }
    const chunks = L.chunkRows(rows, CHUNK_BYTES);
    let row = startRow;
    let total = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      const res = await append(id, tab, c);
      expectRange(res, 'A' + row + ':J' + (row + c.length - 1), c.length);
      log('  分けて送信 ' + (i + 1) + '/' + chunks.length + '：' + res.cells + '・' + mb(res.bytes) + '（' + seconds(res.ms) + '）');
      row += c.length;
      total += res.ms;
      sent.push(...c);
    }
    return chunks.length + '回に分けて送れた（1回では不可）・J列 ' + chars.toLocaleString() + '字（合計 ' + seconds(total) + '）';
  });

  await step('読み戻して一致を確かめる', async () => {
    const r = await readRows(id, tab);
    const c = L.compareRows(sent, r.rows);
    if (c.diff) {
      const d = c.firstDiff;
      throw new Error(c.rows + '行のうち ' + c.diff + '行が一致しない（最初: ' + d.row + '行目 ' + d.col + '列・送った ' + d.sentLength + '字／読んだ ' + d.gotLength + '字）');
    }
    return c.rows + '行すべて一致・' + c.chars.toLocaleString() + '字（' + seconds(r.ms) + '）';
  });

  await step('目印で探す（files.list）', async () => {
    let found = [];
    for (let i = 0; i < 4; i += 1) {
      if (i) await new Promise((res) => setTimeout(res, 3000));
      const r = await findByMark();
      found = r.files;
      if (found.some((f) => f.id === id)) {
        return found.length + '件見つかった・今作ったファイルを含む' + (i ? '（' + i + '回目のやり直しで見つかった）' : '') + '（' + r.ms + 'ms）';
      }
      log('  まだ見つからない（' + found.length + '件）。3秒後にもう一度探します');
    }
    throw new Error('15秒探しても、今作ったファイルが見つからない（見つかったのは ' + found.length + '件）');
  });

  await step('権限の確かめ（目印なしで検索）', async () => {
    const r = await api('GET', DRIVE + '/files?q=' + encodeURIComponent('trashed = false') + '&fields=' + encodeURIComponent('files(id,appProperties)') + '&pageSize=100&spaces=drive');
    const files = r.json.files || [];
    const others = files.filter((f) => !(f.appProperties && f.appProperties.app === L.APP_PROPS.app));
    if (others.length) throw new Error('このアプリが作っていないファイルが ' + others.length + '件見えた（drive.file より広い可能性）');
    return '見えたのは ' + files.length + '件で、全部このアプリが作ったファイル（' + r.ms + 'ms）';
  });

  log('■ 通しで合格（ファイル「' + L.TEST_FILE_NAME + '」・タブ「' + tab + '」）', 'ok');
}

/** Second device: find the file another device made, read its tabs, add this device's own tab and 1 row. */
async function runOtherDevice() {
  log('■ 別の端末で作ったファイルを探して書く（' + DEVICE + '・' + displayMode() + '）');
  const runId = L.randomHex(8);
  const at = L.stamp(new Date());
  let target = null;
  let tab = null;
  let row = null;

  await step('目印で探す（files.list）', async () => {
    const r = await findByMark();
    if (!r.files.length) throw new Error('見つからない（別の端末で先に「テスト用ファイルを作って試す」を行い、同じアカウントでログインしているか確かめてください）');
    target = r.files[0];
    const mine = S.file && S.file.id === target.id;
    return r.files.length + '件・いちばん新しいもの: 「' + target.name + '」' + (mine ? '（この端末で作ったもの）' : '（この端末では作っていない）') + '（' + r.ms + 'ms）';
  });

  await step('見つけたファイルを読む', async () => {
    const r = await api('GET', sheetUrl(target.id, '?fields=' + encodeURIComponent('properties.title,sheets.properties.title')));
    const tabs = (r.json.sheets || []).map((s) => s.properties.title);
    const ranges = tabs.map((t) => 'ranges=' + encodeURIComponent(L.a1Range(t, 'G:G'))).join('&');
    const r2 = await api('GET', sheetUrl(target.id, '/values:batchGet?' + ranges + '&majorDimension=ROWS'));
    const counts = (r2.json.valueRanges || []).map((vr, i) => tabs[i] + ' ' + (vr.values ? vr.values.length : 0) + '行');
    return 'タブ ' + tabs.length + '個：' + counts.join('・') + '（' + (r.ms + r2.ms) + 'ms）';
  });

  await step('自分のタブを足す', async () => {
    const r = await addTab(target.id);
    tab = r.title;
    return '「' + tab + '」（' + r.ms + 'ms）';
  });

  await step('見出しと1行を足す', async () => {
    row = L.smallRow({ at, device: DEVICE, runId });
    const res = await append(target.id, tab, [L.HEADER_ROW.slice(), row]);
    expectRange(res, 'A1:J2', 2);
    return res.cells + '（' + res.ms + 'ms）';
  });

  await step('読み戻して一致を確かめる', async () => {
    const r = await readRows(target.id, tab);
    const c = L.compareRows([L.HEADER_ROW.slice(), row], r.rows);
    if (c.diff) throw new Error(c.diff + '行が一致しない');
    return c.rows + '行すべて一致（' + r.ms + 'ms）';
  });

  log('■ 別の端末のファイルで合格（タブ「' + tab + '」）', 'ok');
}

// ---------------------------------------------------------------- view

const root = document.getElementById('page');
const logBox = h('ol', { class: 'log', 'aria-live': 'polite' });
// Built once so that a re-render never wipes what is being typed.
const idInput = h('input', {
  type: 'text', class: 'field', id: 'client-id', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
  placeholder: 'クライアントIDを貼る', 'aria-label': 'クライアントID',
});

function saveClientId() {
  const v = L.cleanClientId(idInput.value);
  if (!v) {
    log('✗ クライアントIDの形が違います（英数字と . _ - だけ・20〜200字）', 'ng');
    return;
  }
  S.clientId = v;
  S.editingId = false;
  idInput.value = '';
  setJson(LS, K.clientId, v);
  log('✓ クライアントIDをこの端末に保存した（' + L.maskId(v) + '）', 'ok');
  render();
}
idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) saveClientId(); });

function kv(label, value, cls) {
  return h('li', {}, h('span', { class: 'k' }, label), h('span', { class: 'v' + (cls ? ' ' + cls : '') }, value));
}

function g2Summary() {
  const rs = S.returns;
  const show = (list) => {
    if (!list.length) return ['まだ', ''];
    const okN = list.filter((r) => r.ok).length;
    const last = list[list.length - 1];
    const lastText = last.ok
      ? '最後 ✓' + (last.elapsedMs != null ? ' ' + seconds(last.elapsedMs) : '') + '（' + (last.startDisplay || '?') + ' → ' + last.display + '）'
      : '最後 ✗ ' + (last.error || last.result || '') + '（' + last.display + '）';
    return ['✓' + okN + '回・✗' + (list.length - okN) + '回｜' + lastText, last.ok ? 'ok' : 'ng'];
  };
  return {
    first: show(rs.filter((r) => r.mode === 'select')),
    silent: show(rs.filter((r) => r.mode === 'none')),
    adopt: rs.some((r) => r.mode === 'adopt') ? show(rs.filter((r) => r.mode === 'adopt')) : null,
  };
}

function render() {
  const t = S.token && tokenUsable(S.token) ? S.token : null;
  const g2 = g2Summary();
  const dis = S.busy;

  const more = h('details', { class: 'more', open: S.moreOpen },
    h('summary', {}, '予備の試し（ホーム画面版で戻ってこなかったとき）'),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn', disabled: dis || !S.clientId, onclick: () => login(false, 'window') }, '別の窓でログイン')),
    h('p', { class: 'note' }, '戻った先の画面でも鍵を保存します。アプリの画面に戻ったときに、その鍵を読めるかを確かめます。'));
  more.addEventListener('toggle', () => { S.moreOpen = more.open; });

  fill(root,
    h('div', { class: 'top' },
      h('a', { class: 'back', href: '/' }, '‹ アプリに戻る'),
      h('span', { class: 'ver' }, '接続テスト v1')),
    h('h1', {}, '接続テスト（同期の準備）'),
    h('p', { class: 'lead' }, 'PCとスマホの同期の前に、Googleとつながるかを確かめるページです。アプリのタスクやメモは送りません。送るのは、下の［試す］で作るテスト用の行だけです。'),

    S.banner ? h('div', { class: 'banner ' + S.banner.kind, role: 'status' }, S.banner.text) : null,

    h('h2', { class: 'sec' }, 'いまの状態'),
    h('ul', { class: 'card kv' },
      kv('この画面の開き方', displayMode()),
      kv('端末', DEVICE),
      kv('クライアントID', S.clientId ? '保存済み ' + L.maskId(S.clientId) : 'まだ'),
      kv('ログイン（鍵）', t ? 'あり・残り ' + minutesLeft(t) + '分（受け取った画面: ' + t.display + '）' : 'なし'),
      kv('アカウント', S.account ? (S.account.name ? S.account.name + ' ' : '') + S.account.email : 'まだ'),
      kv('ログインして戻る', g2.first[0], g2.first[1]),
      kv('画面なしで戻る（2回目以降）', g2.silent[0], g2.silent[1]),
      g2.adopt ? kv('ほかの画面の鍵を読む（予備）', g2.adopt[0], g2.adopt[1]) : null,
      kv('この端末で作ったファイル', S.file ? 'あり ' + L.maskId(S.file.id) : 'まだ')),
    S.file && S.file.url ? h('p', { class: 'note' }, h('a', { href: S.file.url, target: '_blank', rel: 'noopener noreferrer' }, 'テスト用ファイルを開く（Googleスプレッドシート）')) : null,

    h('h2', { class: 'sec' }, '① クライアントID'),
    h('div', { class: 'card' },
      S.clientId && !S.editingId
        ? h('div', { class: 'row' }, h('span', {}, '保存済み ' + L.maskId(S.clientId)),
          h('button', { type: 'button', class: 'btn small', disabled: dis, onclick: () => { S.editingId = true; render(); } }, '入れ直す'))
        : h('div', {}, idInput, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn primary', disabled: dis, onclick: saveClientId }, '保存'))),
      h('p', { class: 'note' }, 'Google Cloud の「クライアント」画面にある ID を貼ります。この端末の中にだけ保存され、どこにも送りません（ログインのときに Google へ名乗るためだけに使います）。')),

    h('h2', { class: 'sec' }, '② Googleでログイン'),
    h('div', { class: 'card' },
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn primary', disabled: dis || !S.clientId, onclick: () => login(false, 'same') },
          S.account && S.account.email ? 'Googleでログイン（画面なしで試す）' : 'Googleでログイン'),
        h('button', { type: 'button', class: 'btn', disabled: dis || !S.clientId, onclick: () => login(true, 'same') }, 'アカウントを選び直す')),
      h('p', { class: 'note' }, '会社のアカウントを選んでください。パスワード・2段階認証・許可の画面はご本人が操作します。許可の画面にチェックの欄があれば、チェックを入れてから進みます。'),
      more),

    h('h2', { class: 'sec' }, '③ スプレッドシートの試し'),
    h('div', { class: 'card' },
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn primary', disabled: dis || !t, onclick: () => run(runFirstDevice) }, 'テスト用ファイルを作って試す'),
        h('button', { type: 'button', class: 'btn', disabled: dis || !t, onclick: () => run(runOtherDevice) }, '別の端末で作ったファイルを探して書く')),
      h('p', { class: 'note' }, '「' + L.TEST_FILE_NAME + '」を会社のマイドライブに作り、タブを足す → 1行 → ' + L.BIG_ROWS + '行×約' + L.BIG_CHARS.toLocaleString() + '字 → 読み戻して一致 → 目印で探す、まで続けて行います（PCで1回だけ）。2台目では右のボタンで、そのファイルが見つかるか・自分のタブに書けるかを試します。'),
      S.busy ? h('p', { class: 'busy' }, '実行中…（画面を閉じずにお待ちください）') : null),

    h('h2', { class: 'sec' }, '受け取りの記録（Googleから戻ったとき）'),
    S.returns.length
      ? h('ol', { class: 'card returns' }, S.returns.slice().reverse().map((r) => h('li', { class: r.ok ? 'ok' : 'ng' },
        h('div', { class: 't' }, hhmmss(r.at) + '　' + (r.mode === 'none' ? '画面なし' : r.mode === 'select' ? 'アカウントを選ぶ' : r.mode === 'adopt' ? 'ほかの画面の鍵' : '?') + (r.via === 'window' ? '・別の窓' : '')),
        h('div', {}, (r.ok ? '✓ ' : '✗ ') + r.result),
        h('div', { class: 'sub' }, '出かけた画面: ' + (r.startDisplay || '不明') + ' → 戻った画面: ' + r.display + '・乱数: ' + r.stateWhere +
          (r.elapsedMs != null ? '・' + seconds(r.elapsedMs) : '') + '・場所: ' + r.path))))
      : h('p', { class: 'note' }, 'まだありません'),

    h('h2', { class: 'sec' }, '結果の記録'),
    h('div', { class: 'card' },
      logBox,
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn small', onclick: copyLog }, '記録をコピー'),
        h('button', { type: 'button', class: 'btn small', disabled: dis, onclick: clearLocal }, 'この端末の試しの記録を消す'))),
    h('p', { class: 'note' }, 'このページだけが Google（www.googleapis.com・sheets.googleapis.com）と通信します。アプリ本体はこれまでどおり通信しません。鍵（アクセストークン）は1時間で切れ、このアプリが作ったファイルにしか使えません。'));
  renderLog();
}

function renderLog() {
  fill(logBox, S.logs.slice().reverse().map((l) => h('li', { class: l.kind },
    h('span', { class: 't' }, hhmmss(l.at)), l.text)));
}

function logText() {
  const head = '実行リスト 接続テストの記録（' + L.stamp(new Date()) + '・' + DEVICE + '・' + displayMode() + '）';
  const returns = S.returns.map((r) => hhmmss(r.at) + ' ' + (r.ok ? '✓' : '✗') + ' ' + r.result + '｜' + (r.mode || '?') +
    '｜' + (r.startDisplay || '不明') + '→' + r.display + '｜乱数: ' + r.stateWhere + '｜' + (r.elapsedMs != null ? seconds(r.elapsedMs) : '-') + '｜' + r.path);
  const lines = S.logs.map((l) => hhmmss(l.at) + ' ' + l.text);
  return [head, '', '[受け取りの記録]', ...returns, '', '[結果の記録]', ...lines].join('\n');
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText());
    log('記録をコピーしました（メールは伏せ字・鍵は含まない）');
  } catch (e) {
    log('✗ コピーできませんでした（' + ((e && e.message) || e) + '）', 'ng');
  }
}

function clearLocal() {
  if (!window.confirm('この端末に保存した試しの記録（クライアントID・鍵・アカウント・ログ）を消しますか？ Googleのファイルは消えません。')) return;
  for (const key of Object.values(K)) {
    drop(LS, key);
    drop(SS, key);
  }
  Object.assign(S, { clientId: null, account: null, token: null, file: null, tab: null, banner: null, editingId: false, logs: [], returns: [] });
  log('この端末の試しの記録を消しました（Googleのファイルはそのまま）');
  render();
}

// ---------------------------------------------------------------- start

document.addEventListener('securitypolicyviolation', (e) => {
  log('✗ 守りの設定（CSP）で止められた：' + e.effectiveDirective + ' → ' + e.blockedURI, 'ng');
});

S.clientId = L.cleanClientId(getJson(LS, K.clientId));
S.account = getJson(LS, K.account);
S.file = getJson(LS, K.file);
S.logs = getJson(LS, K.log) || [];
S.returns = getJson(LS, K.returns) || [];
S.token = loadToken();

log('ページを開いた（開き方: ' + displayMode() + '・端末: ' + DEVICE + '・場所: ' + location.pathname + '・保存: ' + (LS ? 'OK' : '使えない') + '）');
const accepted = RETURNED ? handleReturn(RETURNED) : false;
render();

window.addEventListener('storage', (e) => { if (e.key === K.token) adoptStoredToken('別の画面が保存した'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') adoptStoredToken('画面に戻った'); });
window.addEventListener('pageshow', (e) => { if (e.persisted) adoptStoredToken('ページの復元'); });
setInterval(() => { if (!S.busy) render(); }, 60 * 1000);

if (accepted) run(checkAccount);
