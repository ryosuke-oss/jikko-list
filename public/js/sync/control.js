// The sync's place in the app (7-2, 7-7, 7-12 of the spec): when to sync, logging in (and getting a new key without
// a screen), connecting, pausing and taking this device off. Nothing is drawn here (ui.js draws); the app tells what
// it knows through `app`. Until the person turns the sync on, nothing here talks to Google.

import { createSyncEngine } from './engine.js';
import { createGoogle, buildAuthUrl, randomHex, tokenUsable, cleanClientId, defaultDeviceName, EXPIRY_MARGIN_MS } from './google.js';
import { syncStorage, loadSync, saveSync } from '../store.js';

const PENDING_KEY = 'jikko-list.sync.pending';
export const SOON_MS = 3000; // after a change
export const EVERY_MS = 2 * 60 * 1000; // while the app is open
export const HIDDEN_LONG_MS = 30 * 60 * 1000; // back after a long time away
export const REFRESH_BEFORE_MS = 15 * 60 * 1000; // a PC left open: a new key when less than this is left
export const IDLE_MS = 3 * 60 * 1000;
export const QUIET_GRACE_MS = 2 * 60 * 1000; // Google refusing a key it gave without a screen this soon: a failed try
const PENDING_MAX_AGE = 15 * 60 * 1000;

/**
 * Should the page go to Google now for a new key without any screen (7-2)? Returns the reason, or null.
 * why: 'open' (the app opened) / 'visible' (back on screen) / 'hidden' (another tab or app) / 'idle' (no input)
 * / 'expired' (the key ran out, or Google refused it). Never while something is being edited, without signal or
 * without an account to ask for. Once a try without a screen has failed (failedAt), never again by itself: the
 * button takes over until the person logs in (no going back and forth to Google, 5 of the spec).
 */
export function refreshReason({ why, token, now, hiddenFor = 0, idleFor = 0, pc = false, editing, online, account, failedAt, connected }) {
  if (!connected || !account || editing || !online) return null;
  if (failedAt) return null;
  const left = token && typeof token.expiresAt === 'number' ? token.expiresAt - now : -Infinity;
  const usable = tokenUsable(token, now);
  if (why === 'open' || why === 'expired') return usable && why === 'open' ? null : why;
  if (why === 'visible') return !usable || (hiddenFor >= HIDDEN_LONG_MS && left < HIDDEN_LONG_MS) ? why : null;
  if (why === 'hidden' || why === 'idle') {
    if (!pc || left >= REFRESH_BEFORE_MS) return null;
    if (why === 'idle' && idleFor < IDLE_MS) return null;
    return why;
  }
  return null;
}

function readJson(store, key) {
  try {
    const v = store && store.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function storages() {
  const out = [];
  for (const k of ['sessionStorage', 'localStorage']) {
    try { if (globalThis[k]) out.push(globalThis[k]); } catch (e) { /* blocked */ }
  }
  return out;
}

/**
 * app: {
 *   db, clock: { now(), today() }, isEditingKey(key), isEditingAny(), hasTypedText(), flushSaves(), runExclusive(fn),
 *   adopt(data, rev), commit(data, expectedRev, write) (optional: the sync's write in the app's own save queue),
 *   onChange(), toast(message, opts), confirm({ title, message, okLabel, cancelLabel }), isPc(), online(), visible(),
 *   location: { origin, assign(url) }
 * }
 */
export function createSyncControl(app) {
  const storage = syncStorage(app.db);
  let cfg = {};
  const st = { running: false, again: false, last: null, error: null, loginNeeded: false, questions: new Set(), status: null, timer: null, nextAt: 0, every: null, leaving: false };
  const google = createGoogle({ getToken: () => (tokenUsable(cfg.token, Date.now()) ? cfg.token.value : null) });
  const engine = createSyncEngine({
    storage,
    google,
    clock: app.clock,
    online: () => app.online(),
    hooks: {
      isEditing: (k) => app.isEditingKey(k),
      runExclusive: (fn) => app.runExclusive(fn),
      onApplied: (d, r) => app.adopt(d, r),
      commit: app.commit ? (d, rev, write) => app.commit(d, rev, write) : undefined,
    },
  });

  const now = () => Date.now();
  const connected = () => Boolean(cfg.fileId) && (cfg.status === 'on' || cfg.status === 'paused');
  const changed = () => { try { app.onChange(); } catch (e) { console.error(e); } };

  async function reloadCfg() {
    cfg = (await loadSync(app.db)).config || {};
    return cfg;
  }

  /** Change what the app owns in the config (the engine owns the status, the file and the tab). */
  async function saveCfg(changes) {
    const cur = (await loadSync(app.db)).config || {};
    cfg = Object.assign({}, cur, changes);
    await saveSync(app.db, { config: cfg }, []);
    return cfg;
  }

  async function refreshStatus() {
    st.status = await engine.status();
    st.questions = new Set(await engine.questionKeys());
    // paused: nothing is made into versions, so what waits is counted from the data (no call to Google)
    if (st.status.status === 'paused') st.status.pending = await engine.unsentCount();
  }

  // ---------------------------------------------------------------- logging in (7-2)

  function savePending(p) {
    let ok = false;
    for (const s of storages()) {
      try { s.setItem(PENDING_KEY, JSON.stringify(p)); ok = true; } catch (e) { /* full or blocked */ }
    }
    return ok;
  }

  function takePending(state) {
    let found = null;
    for (const s of storages()) {
      const p = readJson(s, PENDING_KEY);
      if (p && state && p.state === state && now() - (p.at || 0) < PENDING_MAX_AGE) found = found || p;
      try { s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    }
    return found;
  }

  /**
   * The page opened without a login result, but this tab had left for Google without a screen a moment ago (it
   * never came back: e.g. back from a page of Google's). Counted as a failed try, so it is not tried again by itself.
   */
  async function forgetUnansweredTrip() {
    let s = null;
    try { s = globalThis.sessionStorage || null; } catch (e) { /* blocked */ }
    const p = readJson(s, PENDING_KEY);
    if (!p) return;
    try { s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    if (p.silent && now() - (p.at || 0) < PENDING_MAX_AGE) {
      await saveCfg({ autoFailAt: now() });
      st.loginNeeded = true;
    }
  }

  /**
   * Go to Google (the page leaves). silent: come back without a screen, with the last account.
   * then: 'connect' continues with connecting once the page is back with a key.
   * auto: started by the app itself (7-2), not by a button.
   */
  async function login({ silent, then, auto } = {}) {
    if (st.leaving) return true; // already on the way to Google (a second trip would spoil the first one's state)
    if (!cfg.clientId) {
      app.toast('先に 設定 → 同期 で、クライアントIDを貼ってください');
      return false;
    }
    if (!app.online()) {
      if (!auto) app.toast('電波がありません。つながってから押してください');
      return false;
    }
    // what is typed and not added yet would be lost while the page is away
    if (!auto && app.hasTypedText && app.hasTypedText()) {
      app.toast('打ちかけの文字があります。追加するか消してから、もう一度押してください', { duration: 6000 });
      return false;
    }
    const hint = cfg.account && cfg.account.email ? cfg.account.email : '';
    const quiet = Boolean(silent && hint);
    const state = randomHex(32);
    if (!savePending({ state, silent: quiet, at: now(), then: then || null })) {
      app.toast('この画面に保存できないので、Googleへ移動できません（ブラウザの保存が止められている可能性）', { duration: 8000 });
      return false;
    }
    st.leaving = true;
    st.leftWith = state;
    stop(); // no timer while away (they start again if the page comes back without leaving)
    await app.flushSaves(); // nothing typed is lost while the page is away
    app.location.assign(buildAuthUrl({ clientId: cfg.clientId, origin: app.location.origin, state, loginHint: hint, silent: quiet }));
    return true;
  }

  /** The page came back from Google (read once at start-up; the address was cleaned already). */
  async function acceptReturn(r) {
    const p = takePending(r.state);
    if (!p) return { ok: false, why: 'state' }; // not our own departure: the key is thrown away
    if (r.error || !r.token) {
      await saveCfg({ autoFailAt: p.silent ? now() : cfg.autoFailAt || null });
      st.loginNeeded = true;
      return { ok: false, why: r.error || 'no-token', silent: p.silent };
    }
    const token = { value: r.token, expiresAt: now() + (r.expiresIn || 3600) * 1000, at: now(), quiet: Boolean(p.silent) };
    await saveCfg({ token, autoFailAt: null });
    st.loginNeeded = false;
    return { ok: true, silent: p.silent, then: p.then || null };
  }

  /**
   * Google refused the key (401). Right after a key that came without a screen, going again would only bring the
   * same answer (back and forth without end): counted as a failed try, so the button takes over.
   */
  async function keyRefused() {
    const t = cfg.token;
    const quietJustNow = t && t.quiet && now() - (t.at || 0) < QUIET_GRACE_MS;
    await saveCfg(quietJustNow ? { token: null, autoFailAt: now() } : { token: null });
    if (quietJustNow) st.loginNeeded = true;
  }

  /**
   * The page came back from the browser's memory without having left ("戻る" on Google's screen). The trip is
   * over: one without a screen counts as a failed try; the timers start again. Returns true when it was away.
   */
  async function restored() {
    if (!st.leaving) return false;
    let silent = false;
    for (const s of storages()) {
      const p = readJson(s, PENDING_KEY);
      if (p && p.state === st.leftWith) {
        silent = silent || Boolean(p.silent);
        try { s.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
      }
    }
    st.leftWith = null;
    if (silent) {
      await saveCfg({ autoFailAt: now() });
      st.loginNeeded = true;
    }
    // only now: an event that comes in between (the page shown again) must not go to Google once more
    st.leaving = false;
    await reloadCfg();
    await refreshStatus();
    if (connected() && cfg.status === 'on') {
      startTimers();
      const justNow = st.running || (st.last && now() - st.last.at < 5000); // "visible" may have started one
      if (!justNow) syncNow('back');
    }
    changed();
    return true;
  }

  /**
   * Whose key this is, looked up once per key (Drive about.get). A device tied to a sync file never uses a key of
   * another account: the key is dropped, nothing is read or sent with it, and the person is asked to log in with
   * the right one (no try without a screen either: it would come back with the same account).
   * Returns 'ok' / 'other' / 'login' (no key, or Google refused it) / 'offline' / 'forbidden' / 'failed'.
   */
  async function ensureAccount() {
    if (!tokenUsable(cfg.token, now())) return 'login';
    if (cfg.token.email) return 'ok';
    let who;
    try {
      who = await google.whoAmI();
    } catch (e) {
      if (e && e.status === 401) { await keyRefused(); return 'login'; }
      if (e && e.offline) return 'offline';
      return e && e.status === 403 ? 'forbidden' : 'failed';
    }
    if (!who.email) return 'failed';
    await reloadCfg();
    if (!tokenUsable(cfg.token, now())) return 'login';
    if (cfg.fileId && cfg.account && cfg.account.email && cfg.account.email !== who.email) {
      await saveCfg({ token: null, otherAccount: who.email, autoFailAt: now() });
      return 'other';
    }
    await saveCfg({ token: Object.assign({}, cfg.token, { email: who.email }), account: { email: who.email, name: who.name }, otherAccount: null });
    return 'ok';
  }

  /** Go for a new key without a screen when 7-2 says so. Returns true when the page is leaving. */
  async function maybeRefresh(why, extra = {}) {
    const reason = refreshReason(Object.assign({
      why,
      token: cfg.token,
      now: now(),
      pc: app.isPc(),
      editing: app.isEditingAny(),
      online: app.online(),
      account: cfg.account && cfg.account.email,
      failedAt: cfg.autoFailAt,
      connected: connected() && cfg.status === 'on',
    }, extra));
    if (!reason) return false;
    return login({ silent: true, auto: true });
  }

  // ---------------------------------------------------------------- syncing (7-7)

  function schedule(ms) {
    clearTimeout(st.timer);
    st.nextAt = now() + ms;
    st.timer = setTimeout(() => { syncNow('timer'); }, Math.max(0, ms));
  }

  /** A sync a little later (after a change: 3 seconds; repeated changes push it back). Paused: the count only. */
  function soon(ms = SOON_MS) {
    if (connected() && cfg.status === 'paused') {
      clearTimeout(st.countTimer);
      st.countTimer = setTimeout(() => { refreshStatus().then(changed, () => {}); }, 1000);
      return;
    }
    if (!connected() || cfg.status !== 'on') return;
    schedule(ms);
  }

  async function syncNow(reason) {
    if (st.leaving) return null;
    await reloadCfg();
    if (!connected() || cfg.status !== 'on') {
      await refreshStatus();
      changed();
      return null;
    }
    if (st.running) {
      st.again = true;
      return null;
    }
    if (!tokenUsable(cfg.token, now()) && (await maybeRefresh('expired'))) return null;
    st.running = true;
    changed();
    let r = null;
    try {
      await app.flushSaves();
      // whose key it is (once per key). Without a key or a signal the engine only counts what waits (no call).
      const who = app.online() ? await ensureAccount() : 'offline';
      if (who === 'other') r = { status: 'other-account' };
      else if (who === 'forbidden' || who === 'failed') r = { status: 'error', error: who };
      // no answer to "whose key is this?" (the signal dropped): nothing is read or sent with it this time
      else if (who === 'offline' && app.online()) r = { status: 'offline', pending: await engine.unsentCount() };
      else r = await engine.sync();
      st.last = Object.assign({ at: now(), reason }, r);
      if (r.status === 'synced') {
        st.error = null;
        st.loginNeeded = false;
        if (r.stats && r.stats.merged) {
          const from = r.stats.mergedFrom && r.stats.mergedFrom.length ? r.stats.mergedFrom.join('・') + 'の変更と' : '';
          app.toast(from + 'まとめました（' + r.stats.merged + '件）');
        }
      } else if (r.status === 'need-login') {
        if (cfg.token) await keyRefused();
      } else if (r.status === 'error') {
        st.error = r.error;
      }
    } catch (e) {
      console.error(e);
      st.error = 'failed';
    } finally {
      st.running = false;
    }
    await reloadCfg();
    await refreshStatus();
    changed();
    if (r && r.status === 'need-login' && !(await maybeRefresh('expired'))) st.loginNeeded = true;
    if (r && r.status === 'later' && r.retryAt) schedule(Math.max(1000, Date.parse(r.retryAt) - now()));
    else if (r && r.status === 'retry') schedule(5000);
    else if (st.again) { st.again = false; schedule(1000); }
    return r;
  }

  // ---------------------------------------------------------------- connecting, pausing, taking the device off

  async function connect() {
    await reloadCfg();
    if (!cfg.clientId) { app.toast('先にクライアントIDを貼ってください'); return null; }
    if (!app.online()) { app.toast('電波がありません。つながってから押してください'); return null; }
    if (!tokenUsable(cfg.token, now())) { await login({ silent: false, then: 'connect' }); return null; } // continues after the login
    const who = await ensureAccount();
    if (who === 'login') { await login({ silent: false, then: 'connect' }); return null; }
    if (who !== 'ok') {
      app.toast(who === 'offline' ? '電波がありません。つながってから押してください'
        : who === 'other' ? '前と違うアカウントでログインしています。同期ファイルのあるアカウントでログインし直してください'
          : 'Google に確かめられませんでした。少し待ってからもう一度押してください', { duration: 6000 });
      return null;
    }
    const name = cfg.deviceName || defaultDeviceName(globalThis.navigator && navigator.userAgent, globalThis.navigator && navigator.maxTouchPoints);
    st.running = true;
    changed();
    let r;
    try {
      await app.flushSaves();
      r = await engine.connect({
        create: (o = {}) => app.confirm(o.trashed ? {
          title: '同期ファイルを作り直しますか？',
          message: '前の同期ファイルは Google ドライブのゴミ箱に入っています。\n\nゴミ箱から戻して続けるなら［作らない］を押し、ドライブで戻してから、もう一度［この端末をつなぐ］を押してください。\n\n［作り直す］を押すと、この端末の中身で新しい同期ファイルを作ります（ゴミ箱のファイルはそのまま）。ほかの端末は、つなぎ直すとこの中身を受け取ります。中身がいちばんそろっている端末で作ってください。',
          okLabel: '作り直す',
          cancelLabel: '作らない',
          destructive: true,
        } : {
          title: '同期ファイルを作りますか？',
          message: '同期ファイルが見つかりません。新しく作りますか？\n\nほかの端末ですでに作っているなら［作らない］を押して、同じアカウントでログインしているか確かめてください。',
          okLabel: '作る',
          cancelLabel: '作らない',
        }),
        receive: (there, here) => app.confirm({
          title: '同期データを受け取りますか？',
          message: '同期データ（タスク ' + there.tasks + '件・メモ ' + there.memos + '件）を受け取ります。\n\nこの端末の今の中身（タスク ' + here.tasks + '件・完了 ' + here.done + '件・メモ ' + here.memos + '件・目標 ' + here.goals + '行・予定 ' + here.schedule + '行）は「同期を始める前の控え」に残して置き換えます。設定や竜の「最近の経験値」はこの端末のままです。',
          okLabel: '受け取る',
          cancelLabel: 'やめる',
          destructive: true,
        }),
      }, name);
    } finally {
      st.running = false;
    }
    await reloadCfg();
    if (r.status === 'connected') {
      st.error = null;
      app.toast(r.how === 'created' ? '同期ファイルを作って、この端末の中身を送りました'
        : r.how === 'received' ? (r.kept ? '同期データを受け取りました（前の中身は「同期を始める前の控え」に）' : '同期データを受け取りました')
          : r.how === 'sent' ? 'この端末の中身を同期データに送りました' : '同期はオンです', { duration: 6000 });
      startTimers();
    } else if (r.status === 'error') {
      st.error = r.error;
    }
    await refreshStatus();
    changed();
    return r;
  }

  async function pause() {
    await engine.pause();
    stop(); // no call to Google while paused
    await reloadCfg();
    await refreshStatus();
    changed();
  }

  async function resume() {
    await engine.resume();
    await reloadCfg();
    startTimers();
    changed();
    return syncNow('resume');
  }

  async function detach() {
    await engine.detach();
    stop();
    await reloadCfg();
    st.error = null;
    st.loginNeeded = false;
    st.last = null;
    await refreshStatus();
    changed();
  }

  /** What waits to be sent (for "この端末を外す"). No call to Google. */
  function unsentCount() {
    return engine.unsentCount();
  }

  async function setClientId(v) {
    const id = cleanClientId(v);
    if (!id) return false;
    await saveCfg({ clientId: id });
    changed();
    return true;
  }

  async function setDeviceName(v) {
    const name = String(v || '').trim().slice(0, 20);
    if (!name) return false;
    await saveCfg({ deviceName: name });
    changed();
    return true;
  }

  // ---------------------------------------------------------------- questions ("どちらを残す？")

  const isQuestion = (key) => st.questions.has(key);

  async function questions() {
    return engine.questions();
  }

  async function choose(key, side) {
    const r = await engine.choose(key, side);
    await refreshStatus();
    changed();
    if (r.ok) soon(500);
    return r;
  }

  // ---------------------------------------------------------------- timers and events

  function startTimers() {
    clearInterval(st.every);
    st.every = setInterval(() => {
      if (app.visible() && app.online()) syncNow('every');
    }, EVERY_MS);
  }

  /**
   * Start-up: the login result (if the page just came back), a new key if needed, then the first sync (not waited for).
   * Returns true when the page is leaving for Google (to come back with a new key without any screen).
   */
  async function start(returned) {
    await reloadCfg();
    if (returned) st.lastLogin = await acceptReturn(returned);
    else await forgetUnansweredTrip();
    await refreshStatus();
    if (!cfg.clientId || !cfg.fileId) {
      // a new key: whose it is, for the screen and the next login hint (behind the screen, never waited for)
      if (tokenUsable(cfg.token, now()) && !cfg.token.email && app.online()) ensureAccount().then(changed, () => {});
      // "この端末をつなぐ" was pressed before logging in: carry on once the screen is shown
      if (st.lastLogin && st.lastLogin.ok && st.lastLogin.then === 'connect') setTimeout(() => { connect(); }, 300);
      return false;
    }
    if (cfg.status !== 'on') {
      changed(); // the status ("一時停止中") is drawn; no call to Google at all
      return false;
    }
    if (await maybeRefresh('open')) return true;
    startTimers();
    syncNow('open'); // not waited for: the screen comes first, the account check and the sync run behind it
    return false;
  }

  /** No more timers (tests; a page that is closing). */
  function stop() {
    clearTimeout(st.timer);
    clearInterval(st.every);
    clearTimeout(st.countTimer);
    st.timer = null;
    st.every = null;
  }

  return {
    start,
    stop,
    syncNow,
    soon,
    login,
    connect,
    pause,
    resume,
    detach,
    setClientId,
    setDeviceName,
    questions,
    choose,
    isQuestion,
    maybeRefresh,
    unsentCount,
    restored,
    /** What the screen shows. */
    view() {
      const s = st.status || {};
      // without a signal or a key the run only counted: versions waiting + changes not made into versions yet
      const counted = st.last && (st.last.status === 'offline' || st.last.status === 'need-login') && typeof st.last.pending === 'number' ? st.last.pending : 0;
      const pending = Math.max(s.pending || 0, counted);
      const base = {
        configured: Boolean(cfg.clientId),
        connected: connected(),
        clientId: cfg.clientId || '',
        account: cfg.account || null,
        deviceName: cfg.deviceName || defaultDeviceName(globalThis.navigator && navigator.userAgent, globalThis.navigator && navigator.maxTouchPoints),
        tokenOk: tokenUsable(cfg.token, now()),
        tokenLeftMin: cfg.token && cfg.token.expiresAt ? Math.max(0, Math.floor((cfg.token.expiresAt - EXPIRY_MARGIN_MS - now()) / 60000)) : 0,
        status: cfg.status || 'off',
        pending,
        questions: st.questions.size,
        lastSyncAt: s.lastSyncAt || null,
        rows: s.rows || 0,
        unreadable: s.unreadable || 0,
        waiting: s.waiting || 0,
        error: cfg.otherAccount ? 'other-account' : st.error,
        otherAccount: cfg.otherAccount || null,
        // the button may go to Google without a screen (it did not fail since the last login)
        quietOk: Boolean(cfg.account && cfg.account.email) && !cfg.autoFailAt && !cfg.otherAccount,
        running: st.running,
        loginNeeded: st.loginNeeded,
        last: st.last,
      };
      let kind = 'off';
      if (!base.connected) kind = 'off';
      else if (base.status === 'paused') kind = 'paused';
      else if (st.running) kind = 'syncing';
      else if (base.error) kind = 'error';
      else if (!app.online() || (st.last && st.last.status === 'offline')) kind = 'offline'; // before "login": nothing can be done without a signal
      else if (st.loginNeeded || !base.tokenOk) kind = 'login';
      else if (base.questions) kind = 'choose';
      else kind = 'ok';
      return Object.assign(base, { kind });
    },
    get engine() { return engine; },
    /** The 2-minute sync is running (tests). */
    get ticking() { return Boolean(st.every); },
  };
}
