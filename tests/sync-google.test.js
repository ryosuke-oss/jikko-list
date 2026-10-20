// google.js: the sign-in address, the answers read back, and every Drive / Sheets call checked against a fake that
// answers like the real web addresses. Then the sync engine through google.js, two devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE, REDIRECT_PATH, APP_PROPS, FILE_NAME, buildAuthUrl, parseAuthReturn, cleanClientId, tokenUsable, createGoogle,
  defaultDeviceName, a1, markQuery,
} from '../public/js/sync/google.js';
import { HEADER } from '../public/js/sync/engine.js';
import { refreshReason } from '../public/js/sync/control.js';
import { FakeGoogleHttp } from './helpers/fake-google-http.js';
import { makeDevice, makeClock } from './helpers/device.js';
import { newTask } from '../public/js/tasks.js';
import * as ST from '../public/js/store.js';

const ORIGIN = 'https://example.workers.dev';
const CID = '1234567890-abcdefghijklmnop.example.test';

test('sign-in address: token flow, drive.file only, back to "/"; the chooser first, later without a screen', () => {
  const u = new URL(buildAuthUrl({ clientId: CID, origin: ORIGIN, state: 's', loginHint: '' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('response_type'), 'token');
  assert.equal(u.searchParams.get('scope'), SCOPE);
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/');
  assert.equal(REDIRECT_PATH, '/');
  assert.equal(u.searchParams.get('prompt'), 'select_account');
  const q = new URL(buildAuthUrl({ clientId: CID, origin: 'http://localhost:8807', state: 's', loginHint: 'someone@example.com', silent: true }));
  assert.equal(q.searchParams.get('prompt'), 'none');
  assert.equal(q.searchParams.get('login_hint'), 'someone@example.com');
  assert.equal(q.searchParams.get('redirect_uri'), 'http://localhost:8807/');
  // asking with a screen keeps the hint but shows the chooser
  assert.equal(new URL(buildAuthUrl({ clientId: CID, origin: ORIGIN, state: 's', loginHint: 'a@b.c' })).searchParams.get('prompt'), 'select_account');
  const back = parseAuthReturn('#state=s1&access_token=ya29.x&expires_in=3599&scope=' + encodeURIComponent(SCOPE), '');
  assert.deepEqual(back, { token: 'ya29.x', expiresIn: 3599, scope: SCOPE, state: 's1', error: null });
  assert.equal(parseAuthReturn('#error=login_required&state=s2', '').error, 'login_required');
  assert.equal(parseAuthReturn('', ''), null);
  assert.equal(cleanClientId(' ' + CID + ' '), CID);
  assert.equal(cleanClientId('<x>'), null);
  assert.equal(tokenUsable({ value: 'x', expiresAt: Date.now() + 6 * 60000 }), true);
  assert.equal(tokenUsable({ value: 'x', expiresAt: Date.now() + 4 * 60000 }), false); // less than 5 minutes left
  assert.equal(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5), 'iPhone');
  assert.equal(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'Mac');
  assert.equal(a1("it's", 'G2:J'), "'it''s'!G2:J");
  assert.match(markQuery(), /key='app' and value='jikko-list'/);
  assert.match(markQuery(), /key='kind' and value='sync'/);
  assert.equal(APP_PROPS.kind, 'sync');
});

test('the calls: find / make / tab / read / add, with the key, nothing sent with cookies or the address of the page', async () => {
  const g = new FakeGoogleHttp();
  const token = g.issueToken();
  const seen = [];
  const f = g.fetch();
  const api = createGoogle({ getToken: () => token, fetchImpl: async (url, init) => { seen.push({ url, init }); return f(url, init); } });
  assert.deepEqual(await api.findFiles(), []);
  const { id } = await api.createFile();
  assert.deepEqual(await api.findFiles(), []); // not marked yet
  await api.markFile(id);
  const files = await api.findFiles();
  assert.deepEqual(files, [{ id, name: FILE_NAME, trashed: false }]);
  assert.deepEqual(g.sheets.files[0].props, APP_PROPS);
  assert.ok(g.sheets.files[0].tabs.get('説明')[0][0].includes('同期データ'));
  await api.addTab(id, '記録_Mac_3f9a', HEADER);
  assert.deepEqual(g.sheets.files[0].tabs.get('記録_Mac_3f9a')[0], HEADER);
  const r1 = await api.appendRows(id, '記録_Mac_3f9a', [['a', 'b', 'c', 'd', 'e', 'f', 'g1', 'h1', 'i1', 'j1'], ['', '', '', '', '', '', 'g2', 'h2', 'i2', 'j2']]);
  assert.equal(r1.updatedRange, "'記録_Mac_3f9a'!A2:J3");
  const read = await api.readTabs(id, [{ title: '記録_Mac_3f9a', fromRow: 2 }, { title: '記録_Gone_0000', fromRow: 2 }, { title: '記録_Mac_3f9a', fromRow: 5000 }]);
  assert.deepEqual(read.titles, ['説明', '記録_Mac_3f9a']);
  assert.deepEqual(read.data[0], { title: '記録_Mac_3f9a', fromRow: 2, rows: [['g1', 'h1', 'i1', 'j1'], ['g2', 'h2', 'i2', 'j2']] });
  assert.deepEqual(read.data[1], { title: '記録_Mac_3f9a', fromRow: 5000, rows: [] }); // past the end: no rows, no refusal
  assert.equal(read.data.length, 2); // the tab that is gone is left out
  for (const s of seen) {
    assert.equal(s.init.headers.Authorization, 'Bearer ' + token);
    assert.equal(s.init.credentials, 'omit');
    assert.equal(s.init.referrerPolicy, 'no-referrer');
    assert.ok(/^https:\/\/(www|sheets)\.googleapis\.com\//.test(s.url), s.url);
  }
  const who = await api.whoAmI();
  assert.equal(who.email, 'someone@example.com');
});

test('errors: no key -> 401 without calling Google; no signal -> offline; HTTP errors keep their number', async () => {
  const g = new FakeGoogleHttp();
  let calls = 0;
  const none = createGoogle({ getToken: () => null, fetchImpl: async () => { calls += 1; return null; } });
  await assert.rejects(none.findFiles(), (e) => e.status === 401);
  assert.equal(calls, 0);
  const off = createGoogle({ getToken: () => 'x', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(off.findFiles(), (e) => e.offline === true && e.status === undefined);
  const token = g.issueToken();
  const api = createGoogle({ getToken: () => token, fetchImpl: g.fetch() });
  for (const status of [403, 404, 429, 503]) {
    g.inject(/files\?/, status);
    await assert.rejects(api.findFiles(), (e) => e.status === status);
  }
  await assert.rejects(api.readTabs('nope', []), (e) => e.status === 404);
  g.expireAll();
  await assert.rejects(api.findFiles(), (e) => e.status === 401);
});

test('when to get a new key without a screen (7-2): on opening when it ran out, back after a long time, a PC left open; never while editing', () => {
  const now = Date.parse('2026-10-20T03:00:00Z');
  const base = { now, editing: false, online: true, account: 'a@b.c', failedAt: null, connected: true };
  const tok = (min) => ({ value: 'x', expiresAt: now + min * 60000 });
  assert.equal(refreshReason(Object.assign({ why: 'open', token: tok(2) }, base)), 'open');
  assert.equal(refreshReason(Object.assign({ why: 'open', token: tok(40) }, base)), null);
  assert.equal(refreshReason(Object.assign({ why: 'open', token: null }, base)), 'open');
  assert.equal(refreshReason(Object.assign({ why: 'visible', token: tok(20), hiddenFor: 31 * 60000 }, base)), 'visible');
  assert.equal(refreshReason(Object.assign({ why: 'visible', token: tok(50), hiddenFor: 31 * 60000 }, base)), null);
  assert.equal(refreshReason(Object.assign({ why: 'visible', token: tok(20), hiddenFor: 5 * 60000 }, base)), null);
  assert.equal(refreshReason(Object.assign({ why: 'hidden', token: tok(10), pc: true }, base)), 'hidden');
  assert.equal(refreshReason(Object.assign({ why: 'hidden', token: tok(10), pc: false }, base)), null); // phones: only on opening / coming back
  assert.equal(refreshReason(Object.assign({ why: 'hidden', token: tok(20), pc: true }, base)), null);
  assert.equal(refreshReason(Object.assign({ why: 'idle', token: tok(10), pc: true, idleFor: 4 * 60000 }, base)), 'idle');
  assert.equal(refreshReason(Object.assign({ why: 'idle', token: tok(10), pc: true, idleFor: 60000 }, base)), null);
  // never: while editing, without signal, without an account, within 2 minutes of a failed try, not connected
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, editing: true })), null);
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, online: false })), null);
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, account: '' })), null);
  // once a try without a screen failed: never again by itself (not after 2 minutes, not the next day) until a login
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, failedAt: now - 1000 })), null);
  assert.equal(refreshReason(Object.assign({}, base, { why: 'expired', token: null, failedAt: now - 3 * 60 * 1000 })), null);
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, failedAt: now - 24 * 3600 * 1000 })), null);
  assert.equal(refreshReason(Object.assign({}, base, { why: 'open', token: null, connected: false })), null);
});

test('the sync engine through google.js and the fake web addresses: two devices, connect, change, question, answer', async () => {
  const g = new FakeGoogleHttp();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const tokenA = g.issueToken();
  const tokenB = g.issueToken();
  const A = await makeDevice(g.sheets, 'Mac', { clock });
  const B = await makeDevice(g.sheets, 'iPhone', { clock });
  A.engine = A.newEngine({ google: createGoogle({ getToken: () => tokenA, fetchImpl: g.fetch() }) });
  B.engine = B.newEngine({ google: createGoogle({ getToken: () => tokenB, fetchImpl: g.fetch() }) });
  await A.init();
  await B.init();
  const t = await A.edit((d) => { const x = newTask({ title: 'Googleを通る' }, clock.now(), 0); d.tasks.push(x); return x; });
  assert.equal((await A.connect()).how, 'created');
  assert.equal((await B.connect()).how, 'received');
  assert.equal((await B.data()).tasks[0].title, 'Googleを通る');
  await A.edit((d) => { d.tasks[0].title = 'PCで直した'; d.tasks[0].updatedAt = clock.now(); });
  clock.tick(1000);
  await B.edit((d) => { d.tasks[0].title = 'iPhoneで直した'; d.tasks[0].updatedAt = clock.now(); });
  await A.sync();
  await B.sync();
  await A.sync();
  const q = (await A.engine.questions())[0];
  assert.equal(q.key, 'task:' + t.id);
  assert.equal((await A.engine.choose(q.key, q.a.device === 'Mac' ? 'a' : 'b')).ok, true);
  await A.sync();
  await B.sync();
  assert.equal((await B.data()).tasks[0].title, 'PCで直した');
  assert.deepEqual(await A.items(), await B.items());
  // every request went to the two Google API hosts only, appends RAW / INSERT_ROWS, never to another device's tab
  for (const r of g.requests) assert.match(r.url, /^https:\/\/(www|sheets)\.googleapis\.com\//);
  assert.ok(g.requests.every((r) => r.status < 400), JSON.stringify(g.requests.filter((r) => r.status >= 400)));
  // the key runs out in the middle: "log in again", and the next run works with a new key
  g.expireAll();
  assert.equal((await A.sync()).status, 'need-login');
});

test('a new file whose marks could not be added: the next connect adds them to that file (never a second file)', async () => {
  const g = new FakeGoogleHttp();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const token = g.issueToken();
  const A = await makeDevice(g.sheets, 'Mac', { clock });
  A.engine = A.newEngine({ google: createGoogle({ getToken: () => token, fetchImpl: g.fetch() }) });
  await A.init();
  await A.edit((d) => { d.tasks.push(newTask({ title: '印を付け直す' }, clock.now(), 0)); });
  g.inject(/^PATCH /, 503, 4); // Google busy for every try of the marks
  const r1 = await A.connect();
  assert.equal(r1.status, 'error');
  assert.equal(g.sheets.files.length, 1);
  assert.deepEqual(g.sheets.files[0].props, {}); // made, not marked
  // taken off in between: still remembered
  await A.engine.detach();
  const r2 = await A.connect();
  assert.equal(r2.status, 'connected');
  assert.equal(g.sheets.files.length, 1); // no second file
  assert.deepEqual(g.sheets.files[0].props, APP_PROPS);
  assert.equal((await A.syncRecords()).config.madeFile, null);
  const B = await makeDevice(g.sheets, 'iPhone', { clock });
  B.engine = B.newEngine({ google: createGoogle({ getToken: () => token, fetchImpl: g.fetch() }) });
  await B.init();
  assert.equal((await B.connect()).how, 'received');
  assert.ok((await B.data()).tasks.some((t) => t.title === '印を付け直す'));
});

test('a file made here and never marked, while another device made the sync file meanwhile: that one is used, never two marked files', async () => {
  const g = new FakeGoogleHttp();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const token = g.issueToken();
  const dev = async (name) => {
    const d = await makeDevice(g.sheets, name, { clock });
    d.engine = d.newEngine({ google: createGoogle({ getToken: () => token, fetchImpl: g.fetch() }) });
    await d.init();
    return d;
  };
  const A = await dev('Mac');
  await A.edit((d) => { d.tasks.push(newTask({ title: 'Mac のタスク' }, clock.now(), 0)); });
  g.inject(/^PATCH /, 503, 4);
  assert.equal((await A.connect()).status, 'error'); // made, not marked
  // the iPhone connects meanwhile: nothing marked is found, it makes (and marks) its own file
  const B = await dev('iPhone');
  await B.edit((d) => { d.tasks.push(newTask({ title: 'iPhone のタスク' }, clock.now(), 0)); });
  assert.equal((await B.connect()).how, 'created');
  // the Mac connects again: the iPhone's file is used, the Mac's old file stays unmarked
  const r = await A.connect();
  assert.equal(r.status, 'connected');
  assert.equal(g.sheets.files.filter((f) => f.props.kind === 'sync').length, 1);
  assert.equal((await A.syncRecords()).config.fileId, (await B.syncRecords()).config.fileId);
  assert.equal((await A.syncRecords()).config.madeFile, null);
  // the Mac received the iPhone's data; its own task is kept in "同期を始める前の控え" (back from the settings)
  assert.ok((await A.data()).tasks.some((t) => t.title === 'iPhone のタスク'));
  const copy = (await ST.listBackups(A.db)).find((b) => b.kind === 'presync');
  assert.ok(copy.data.tasks.some((t) => t.title === 'Mac のタスク'));
  assert.equal((await A.sync()).status, 'synced');
});

test('a file marked at the next connect is used as it is, even when the search does not list it yet', async () => {
  const g = new FakeGoogleHttp();
  const clock = makeClock('2026-10-20T01:00:00.000Z');
  const token = g.issueToken();
  const A = await makeDevice(g.sheets, 'Mac', { clock });
  A.engine = A.newEngine({ google: createGoogle({ getToken: () => token, fetchImpl: g.fetch() }) });
  await A.init();
  g.inject(/^PATCH /, 503, 4);
  assert.equal((await A.connect()).status, 'error');
  const made = g.sheets.files[0].id;
  g.sheets.hidden.add(made); // the search lags after the marks are added
  let asked = 0;
  const r = await A.connect({ create: async () => { asked += 1; return true; }, receive: async () => true });
  assert.equal(r.status, 'connected');
  assert.equal(asked, 0); // never "作りますか？" again
  assert.equal(g.sheets.files.length, 1);
  assert.equal((await A.syncRecords()).config.fileId, made);
  assert.deepEqual(g.sheets.files[0].props, APP_PROPS);
});
