// control.js: logging in (the answer is accepted only for our own departure), getting a new key without a screen at
// the right moments (never twice at once, never while editing), connecting after the login, taking the device off.
// The app around it is faked; Google is the fake that answers like the real web addresses.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from './helpers/fake-idb.js';
import { FakeGoogleHttp } from './helpers/fake-google-http.js';
import * as ST from '../public/js/store.js';
import { createSyncControl } from '../public/js/sync/control.js';
import { newTask } from '../public/js/tasks.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}

const CID = 'fake-client-1234567890-abcdefghij.apps.example';
const pages = [];
afterEach(() => { for (const p of pages.splice(0)) p.control.stop(); });
const ORIGIN = 'https://example.workers.dev';

/**
 * A page of the app (its own IndexedDB) around a control; "assign" records the trips to Google. session: the tab's
 * own storage (the same tab after a trip to Google keeps it; another tab has its own); local: shared by the tabs.
 */
async function page(emu, opts = {}) {
  const session = opts.session || memoryStorage();
  const local = opts.local || memoryStorage();
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;
  globalThis.fetch = opts.fetch || emu.fetch();
  const factory = opts.idb || createFakeIndexedDB();
  const db = await ST.openDb(factory);
  let { rev, empty, data } = await ST.loadState(db);
  if (empty) {
    data = ST.newState('2026-10-20', new Date().toISOString());
    rev = await ST.saveKeys(db, data, ST.KEYS, rev);
  }
  const p = { db, factory, session, local, trips: [], toasts: [], editing: false, typed: false, offline: false, flushed: 0, confirms: [], changes: 0 };
  p.app = {
    db,
    clock: { now: () => new Date().toISOString(), today: () => '2026-10-20' },
    isEditingKey: () => false,
    isEditingAny: () => p.editing,
    hasTypedText: () => p.typed,
    flushSaves: async () => { p.flushed += 1; },
    runExclusive: (fn) => fn(),
    adopt: () => {},
    onChange: () => { p.changes += 1; },
    toast: (m) => p.toasts.push(m),
    confirm: async (o) => { p.confirms.push(o.title); return true; },
    isPc: () => true,
    online: () => !p.offline,
    visible: () => true,
    location: { origin: ORIGIN, assign: (url) => p.trips.push(url) },
  };
  p.control = createSyncControl(p.app);
  pages.push(p);
  return p;
}

/** Follow a trip to the fake Google and come back: a new page in the same tab reading the answer at start-up. */
async function comeBack(emu, p, opts = {}) {
  const url = p.trips[p.trips.length - 1];
  const back = new URL(emu.signIn(url));
  const { parseAuthReturn } = await import('../public/js/sync/google.js');
  const ret = parseAuthReturn(back.hash, back.search);
  const q = await page(emu, { idb: p.factory, session: p.session, local: p.local });
  if (opts.tamper) ret.state = 'not-ours';
  const leaving = await q.control.start(ret);
  return { q, leaving };
}

/** The same tab opened again (a reload, or the app opened again later). */
function reopen(emu, p, opts = {}) {
  return page(emu, Object.assign({ idb: p.factory, session: p.session, local: p.local }, opts));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  for (let t = 0; t < ms && !(await fn()); t += 10) await wait(10);
  return fn();
}

/** Logged in and connected (the sync file made by this page). */
async function connectedPage(emu) {
  const p = await page(emu);
  await p.control.setClientId(CID);
  await p.control.start(null);
  await p.control.login({ silent: false });
  const { q } = await comeBack(emu, p);
  await q.control.connect();
  assert.equal(q.control.view().connected, true);
  return q;
}

/** The key on the device runs out (as if an hour went by). */
async function expireKey(p) {
  const cfg = (await ST.loadSync(p.db)).config;
  cfg.token.expiresAt = Date.now() - 1000;
  await ST.saveSync(p.db, { config: cfg }, []);
}

async function addTask(p, title) {
  const { data, rev } = await ST.loadState(p.db);
  data.tasks.push(newTask({ title }, new Date().toISOString(), 0));
  await ST.saveKeys(p.db, data, ['tasks'], rev);
}

test('logging in: the key is kept only when the answer belongs to our own departure', async () => {
  const emu = new FakeGoogleHttp();
  const p = await page(emu);
  assert.equal(await p.control.setClientId(CID), true);
  await p.control.start(null);
  await p.control.login({ silent: false });
  assert.equal(p.trips.length, 1);
  assert.equal(p.flushed, 1); // what was typed is saved before the page leaves
  const u = new URL(p.trips[0]);
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/');
  assert.equal(u.searchParams.get('prompt'), 'select_account');
  // someone else's answer (another state): thrown away
  const bad = await comeBack(emu, p, { tamper: true });
  assert.equal(bad.q.control.view().tokenOk, false);
  // the page that left does not leave a second time (a second trip would spoil the first one's state)
  assert.equal(await p.control.login({ silent: false }), true);
  assert.equal(p.trips.length, 1);
  // our own answer (from the page that came back): kept, and the account is looked up for the next login without a screen
  await bad.q.control.login({ silent: false });
  const good = await comeBack(emu, bad.q);
  assert.equal(good.leaving, false);
  await until(() => good.q.control.view().account); // looked up behind the screen (start-up does not wait for it)
  const v = good.q.control.view();
  assert.equal(v.tokenOk, true);
  assert.equal(v.account.email, 'someone@example.com');
  const cfg = (await ST.loadSync(good.q.db)).config;
  assert.ok(cfg.token.expiresAt > Date.now() + 50 * 60 * 1000);
});

test('connecting before logging in: the login comes first, and connecting carries on by itself after it', async () => {
  const emu = new FakeGoogleHttp();
  const p = await page(emu);
  await p.control.setClientId(CID);
  await p.control.start(null);
  assert.equal(await p.control.connect(), null); // went to Google first
  assert.equal(p.trips.length, 1);
  const { q } = await comeBack(emu, p);
  await new Promise((r) => setTimeout(r, 600)); // "carry on" waits for the screen
  for (let i = 0; i < 50 && !q.control.view().connected; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.control.view().connected, true);
  assert.deepEqual(q.confirms, ['同期ファイルを作りますか？']); // nothing existed: asked before making it
  assert.equal(emu.sheets.files.length, 1);
});

test('a new key without a screen: on opening when it ran out (once, never two trips at once), never while editing', async () => {
  const emu = new FakeGoogleHttp();
  const p = await page(emu);
  await p.control.setClientId(CID);
  await p.control.start(null);
  await p.control.login({ silent: false });
  const { q } = await comeBack(emu, p);
  await q.control.connect();
  assert.equal(q.control.view().connected, true);
  // the key ran out
  await expireKey(q);
  const r = await reopen(emu, q);
  assert.equal(await r.control.start(null), true); // leaving for Google
  assert.equal(r.trips.length, 1);
  const u = new URL(r.trips[0]);
  assert.equal(u.searchParams.get('prompt'), 'none');
  assert.equal(u.searchParams.get('login_hint'), 'someone@example.com');
  // another reason to go comes while the page is already leaving: no second trip, no sync
  assert.equal(await r.control.maybeRefresh('idle', { idleFor: 10 * 60 * 1000 }), true);
  assert.equal(await r.control.syncNow('timer'), null);
  assert.equal(r.trips.length, 1);
  // another tab while something is being edited there: no trip
  const e = await page(emu, { idb: q.factory, local: q.local });
  e.editing = true;
  assert.equal(await e.control.start(null), false);
  assert.equal(e.trips.length, 0);
  // a silent try that failed: "ログインしてください", and no automatic try after that
  emu.signedIn = false;
  const back = await comeBack(emu, r);
  assert.equal(back.q.control.view().kind, 'login');
  const again = await reopen(emu, back.q);
  assert.equal(await again.control.start(null), false);
  assert.equal(again.trips.length, 0);
});

test('a try without a screen that failed (Google\'s own login ran out): never again by itself, the button takes over', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await expireKey(q);
  emu.signedIn = false; // e.g. the company makes everyone log in again every 14 days
  const r = await reopen(emu, q);
  assert.equal(await r.control.start(null), true); // one trip without a screen
  const { q: back } = await comeBack(emu, r);
  let v = back.control.view();
  assert.equal(v.kind, 'login');
  assert.equal(v.quietOk, false); // the banner says "Googleにログインしてください" with the button
  // the 2-minute sync, coming back to the page, no input, opening again the next day: no trip at all
  await back.control.syncNow('timer');
  assert.equal(await back.control.maybeRefresh('visible', { hiddenFor: 40 * 60 * 1000 }), false);
  assert.equal(await back.control.maybeRefresh('idle', { idleFor: 10 * 60 * 1000 }), false);
  assert.equal(await back.control.maybeRefresh('expired'), false);
  const later = await reopen(emu, back);
  assert.equal(await later.control.start(null), false);
  await later.control.syncNow('every');
  assert.equal(back.trips.length + later.trips.length, 0);
  // the button: the account chooser (not prompt=none); once logged in, it goes on by itself again
  assert.equal(await later.control.login({ silent: false }), true);
  assert.equal(new URL(later.trips[0]).searchParams.get('prompt'), 'select_account');
  emu.signedIn = true;
  const { q: ok } = await comeBack(emu, later);
  const cfg = (await ST.loadSync(ok.db)).config;
  assert.equal(cfg.autoFailAt, null);
  await until(() => ok.control.view().kind === 'ok');
  v = ok.control.view();
  assert.equal(v.kind, 'ok');
  assert.equal(v.quietOk, true);
});

test('a trip without a screen that never came back (the page opened again without an answer): counted as a failed try', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await expireKey(q);
  const r = await reopen(emu, q);
  assert.equal(await r.control.start(null), true);
  // the person came back with the browser's back button before Google answered
  const s = await reopen(emu, r);
  assert.equal(await s.control.start(null), false);
  assert.equal(s.trips.length, 0);
  assert.equal(s.control.view().quietOk, false);
  assert.ok((await ST.loadSync(s.db)).config.autoFailAt);
});

test('opening does not wait for Google: the account check runs behind the screen; paused sends nothing; 再開 starts the 2-minute sync', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  // a new key whose account was not looked up yet, and Google that does not answer the account question
  const cfg = (await ST.loadSync(q.db)).config;
  delete cfg.token.email;
  await ST.saveSync(q.db, { config: cfg }, []);
  const real = emu.fetch();
  let hanging = 0;
  const slow = async (url, init) => {
    if (String(url).includes('/drive/v3/about')) { hanging += 1; return new Promise(() => {}); }
    return real(url, init);
  };
  const r = await reopen(emu, q, { fetch: slow });
  const t0 = Date.now();
  assert.equal(await r.control.start(null), false);
  assert.ok(Date.now() - t0 < 500, 'start-up waited for Google');
  await until(() => hanging > 0);
  assert.equal(hanging, 1);
  // paused: opening sends nothing at all
  const p2 = await reopen(emu, q);
  await p2.control.pause();
  p2.control.stop();
  const before = emu.requests.length;
  const p3 = await reopen(emu, q);
  assert.equal(await p3.control.start(null), false);
  await wait(50);
  assert.equal(emu.requests.length, before);
  assert.ok(p3.changes >= 1); // "一時停止中" is drawn right away
  assert.equal(p3.control.view().kind, 'paused');
  assert.equal(p3.control.ticking, false);
  // 再開: a sync right away (or as soon as the 10-second stop allows), and the 2-minute sync runs from now on
  const res = await p3.control.resume();
  assert.ok(['synced', 'later'].includes(res.status), res.status);
  assert.equal(p3.control.ticking, true);
});

test('another account: nothing is read or sent with its key, the device says so (also after opening again) until the right account logs in', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await addTask(q, 'ずっと残るタスク');
  await q.control.syncNow('test');
  // the person chooses another account at Google
  emu.account = { email: 'other@example.org', name: 'ほか' };
  await q.control.login({ silent: false });
  const mark = emu.requests.length;
  const { q: back } = await comeBack(emu, q); // opening syncs behind the screen
  await until(() => back.control.view().last && !back.control.view().running);
  await back.control.syncNow('timer');
  const sent = emu.requests.slice(mark);
  assert.deepEqual(sent.map((x) => new URL(x.url).pathname), ['/drive/v3/about']); // only "who is this?"
  let v = back.control.view();
  assert.equal(v.kind, 'error');
  assert.equal(v.error, 'other-account');
  assert.equal(v.otherAccount, 'other@example.org');
  assert.equal(v.tokenOk, false); // the key of the other account is thrown away
  assert.equal(v.account.email, 'someone@example.com');
  // opening again: still told, and no trip by itself (it would come back with the same account)
  const again = await reopen(emu, back);
  assert.equal(await again.control.start(null), false);
  assert.equal(again.trips.length, 0);
  assert.equal(again.control.view().error, 'other-account');
  // the right account: back to normal
  emu.account = { email: 'someone@example.com', name: 'テスト' };
  await again.control.login({ silent: false });
  const { q: ok } = await comeBack(emu, again);
  await until(() => ok.control.view().kind === 'ok');
  v = ok.control.view();
  assert.equal(v.error, null);
  assert.equal(v.otherAccount, null);
  assert.ok((await ST.loadState(ok.db)).data.tasks.some((t) => t.title === 'ずっと残るタスク'));
});

test('no signal and the key ran out: "オフライン・未送信N件" (not the login), and the button does not leave', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await expireKey(q);
  const r = await reopen(emu, q);
  r.offline = true;
  assert.equal(await r.control.start(null), false); // no trip without a signal
  await addTask(r, '圏外で足した');
  await r.control.syncNow('soon');
  const v = r.control.view();
  assert.equal(v.kind, 'offline');
  assert.equal(v.pending, 1);
  assert.equal(await r.control.login({ silent: false }), false);
  assert.equal(r.trips.length, 0);
  assert.match(r.toasts.join('\n'), /電波がありません/);
});

test('the login button with text typed and not added: does not leave (the text would be lost)', async () => {
  const emu = new FakeGoogleHttp();
  const p = await page(emu);
  await p.control.setClientId(CID);
  await p.control.start(null);
  p.typed = true;
  assert.equal(await p.control.login({ silent: false }), false);
  assert.equal(p.trips.length, 0);
  assert.match(p.toasts.join('\n'), /打ちかけの文字/);
  p.typed = false;
  assert.equal(await p.control.login({ silent: false }), true);
});

test('"この端末を外す": the sync records and the key go, the data and the client ID stay; next time it receives as a new device', async () => {
  const emu = new FakeGoogleHttp();
  const p = await page(emu);
  await p.control.setClientId(CID);
  await p.control.start(null);
  await p.control.login({ silent: false });
  const { q } = await comeBack(emu, p);
  const { data, rev } = await ST.loadState(q.db);
  data.tasks.push(newTask({ title: '残るタスク' }, new Date().toISOString(), 0));
  await ST.saveKeys(q.db, data, ['tasks'], rev);
  await q.control.connect();
  await q.control.syncNow('test');
  assert.ok((await ST.getAllRevs(q.db)).length > 0);
  await addTask(q, 'まだ送っていない');
  assert.equal(await q.control.unsentCount(), 1); // told before taking the device off
  await q.control.detach();
  const sy = await ST.loadSync(q.db);
  assert.deepEqual(Object.keys(sy.config).sort(), ['clientId', 'deviceName', 'status']); // settings of this device stay
  assert.equal(sy.progress, undefined);
  assert.equal(sy.applied, undefined);
  assert.deepEqual(await ST.getAllRevs(q.db), []);
  assert.equal((await ST.loadState(q.db)).data.tasks[0].title, '残るタスク');
  assert.equal(q.control.ticking, false);
  assert.equal(q.control.view().connected, false);
  assert.equal(q.control.view().tokenOk, false); // the key went too
});

test('"戻る" on Google\'s screen brings the page back without leaving: the trip is over (a quiet one counts as failed), the timers go on', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  // the button: Google's account chooser, then the browser's "戻る" (the page comes back from its memory)
  assert.equal(await q.control.login({ silent: false }), true);
  assert.equal(q.control.ticking, false);
  assert.equal(await q.control.syncNow('timer'), null); // away: nothing runs
  assert.equal(await q.control.restored(), true);
  assert.equal(q.control.ticking, true);
  assert.equal(q.session.getItem('jikko-list.sync.pending'), null);
  assert.equal((await ST.loadSync(q.db)).config.autoFailAt || null, null); // a login by button that was given up is not a failure
  await until(() => q.control.view().last && q.control.view().last.reason === 'back' && !q.control.view().running);
  assert.ok(['synced', 'later'].includes(q.control.view().last.status));
  // a trip without a screen brought back the same way: a failed try, the button takes over
  await expireKey(q);
  const s = await reopen(emu, q);
  assert.equal(await s.control.start(null), true);
  // the page is shown again while it is being brought back (Chrome: before "pageshow"): no second trip
  const back = s.control.restored();
  assert.equal(await s.control.maybeRefresh('visible', { hiddenFor: 40 * 60 * 1000 }), true); // still away: nothing
  assert.equal(await back, true);
  assert.ok((await ST.loadSync(s.db)).config.autoFailAt);
  assert.equal(s.control.view().quietOk, false);
  assert.equal(await s.control.maybeRefresh('visible', { hiddenFor: 40 * 60 * 1000 }), false);
  assert.equal(s.trips.length, 1);
  assert.equal(await s.control.restored(), false); // not away any more
});

test('Google refuses a key it has just given without a screen: no going back and forth, the button takes over', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await expireKey(q);
  const r = await reopen(emu, q);
  assert.equal(await r.control.start(null), true); // the one trip without a screen
  emu.inject(/googleapis\.com/, 401, 1000); // every call refused from now on (a trouble on Google's side)
  const { q: back } = await comeBack(emu, r);
  await until(() => back.control.view().last && !back.control.view().running);
  await back.control.syncNow('timer');
  assert.equal(await back.control.maybeRefresh('expired'), false);
  const again = await reopen(emu, back);
  assert.equal(await again.control.start(null), false);
  assert.equal(back.trips.length + again.trips.length, 0);
  const v = again.control.view();
  assert.equal(v.kind, 'login');
  assert.equal(v.quietOk, false);
});

test('no answer to "whose key is this?" (the signal dropped just then): nothing is read or sent with the key', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  const cfg = (await ST.loadSync(q.db)).config;
  delete cfg.token.email; // a new key whose account was not looked up yet
  await ST.saveSync(q.db, { config: cfg }, []);
  await addTask(q, '確かめられない間に足した');
  const real = emu.fetch();
  const seen = [];
  const flaky = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('/drive/v3/about')) throw new TypeError('Failed to fetch');
    return real(url, init);
  };
  const r = await reopen(emu, q, { fetch: flaky });
  assert.equal(await r.control.start(null), false);
  await until(() => r.control.view().last && !r.control.view().running);
  assert.deepEqual(seen.filter((u) => !u.includes('/drive/v3/about')), []);
  const v = r.control.view();
  assert.equal(v.kind, 'offline');
  assert.equal(v.pending, 1);
});

test('paused: what is changed meanwhile is counted as 未送信, without any call', async () => {
  const emu = new FakeGoogleHttp();
  const q = await connectedPage(emu);
  await q.control.pause();
  const before = emu.requests.length;
  await addTask(q, '止めている間に足した');
  q.control.soon(); // what the app calls after each save
  await until(() => q.control.view().pending === 1);
  const v = q.control.view();
  assert.equal(v.kind, 'paused');
  assert.equal(v.pending, 1);
  assert.equal(emu.requests.length, before);
});
