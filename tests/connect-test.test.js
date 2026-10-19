import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE, REDIRECT_PATH, APP_PROPS, HEADER_ROW, BIG_ROWS, BIG_CHARS,
  cleanClientId, buildAuthUrl, parseAuthReturn, randomHex, maskEmail, maskId, utf8Bytes,
  a1Range, deviceName, fillTo, smallRow, bigRow, bigRows, chunkRows, compareRows, markQuery, rangeCells,
} from '../public/js/connect-test-lib.js';

const ORIGIN = 'https://example.workers.dev';
const CID = '1234567890-abcdefghijklmnop.example.test';

test('login URL: token flow, drive.file only, the account chooser the first time', () => {
  const u = new URL(buildAuthUrl({ clientId: CID, origin: ORIGIN, state: 'abc', loginHint: '' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('response_type'), 'token');
  assert.equal(u.searchParams.get('scope'), SCOPE);
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/connect-test.html');
  assert.equal(REDIRECT_PATH, '/connect-test.html');
  assert.equal(u.searchParams.get('state'), 'abc');
  assert.equal(u.searchParams.get('client_id'), CID);
  assert.equal(u.searchParams.get('prompt'), 'select_account');
  assert.equal(u.searchParams.has('login_hint'), false);
});

test('login URL: with the last account, no screen (prompt=none) and login_hint', () => {
  const u = new URL(buildAuthUrl({ clientId: CID, origin: 'http://localhost:8807', state: 's', loginHint: 'someone@example.com' }));
  assert.equal(u.searchParams.get('prompt'), 'none');
  assert.equal(u.searchParams.get('login_hint'), 'someone@example.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8807/connect-test.html');
});

test('the answer from Google is read after # (and errors after ?)', () => {
  const ok = parseAuthReturn('#state=s1&access_token=ya29.x&token_type=Bearer&expires_in=3599&scope=' + encodeURIComponent(SCOPE), '');
  assert.deepEqual(ok, { token: 'ya29.x', expiresIn: 3599, scope: SCOPE, state: 's1', error: null });
  const err = parseAuthReturn('#error=interaction_required&state=s2', '');
  assert.equal(err.token, null);
  assert.equal(err.error, 'interaction_required');
  assert.equal(err.state, 's2');
  const q = parseAuthReturn('', '?error=access_denied&state=s3');
  assert.equal(q.error, 'access_denied');
  assert.equal(q.state, 's3');
  assert.equal(parseAuthReturn('', ''), null);
  assert.equal(parseAuthReturn('#section', '?x=1'), null);
  assert.equal(parseAuthReturn('#access_token=t&expires_in=abc', '').expiresIn, null);
});

test('client ID: a light shape check only', () => {
  assert.equal(cleanClientId('  ' + CID + '\n'), CID);
  assert.equal(cleanClientId(''), null);
  assert.equal(cleanClientId('short'), null);
  assert.equal(cleanClientId('has space in the middle of it'), null);
  assert.equal(cleanClientId('<script>alert(1)</script>xxxxxxxx'), null);
  assert.equal(cleanClientId(null), null);
});

test('state is 64 hex characters and differs each time', () => {
  const a = randomHex(32);
  const b = randomHex(32);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('masks: the log never carries a whole e-mail address or ID', () => {
  assert.equal(maskEmail('taro.yamada@example.co.jp'), 't•••@e•••.jp');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail('nodomain'), 'n•••');
  assert.equal(maskId('1234567890abcdef'), '123456…（16字）');
  assert.equal(maskId(''), '');
});

test('A1 ranges quote the tab name', () => {
  assert.equal(a1Range('試し_Mac_ab12', 'A1'), "'試し_Mac_ab12'!A1");
  assert.equal(a1Range("it's", 'A1:J'), "'it''s'!A1:J");
  assert.equal(rangeCells("'試し_Mac_ab12'!A3:J502"), 'A3:J502');
  assert.equal(rangeCells('A1:J1'), 'A1:J1');
});

test('device names', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5), 'iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'Mac');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'iPad');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0), 'Windows');
  assert.equal(deviceName('', 0), 'ブラウザ');
});

test('rows: 10 columns like the planned sync record, written as RAW text', () => {
  assert.equal(HEADER_ROW.length, 10);
  const small = smallRow({ at: '2026-10-19 21:30:00', device: 'Mac', runId: 'a1b2c3d4e5f60718' });
  assert.equal(small.length, 10);
  assert.ok(small.every((c) => typeof c === 'string'));
  assert.ok(small[3].startsWith('='), 'column D starts with "=" to prove RAW keeps it as text');
  assert.doesNotThrow(() => JSON.parse(small[9]));
});

test('big rows: 500 rows, column J exactly 10,000 characters, valid JSON, different from each other', () => {
  assert.equal(BIG_ROWS, 500);
  assert.equal(BIG_CHARS, 10000);
  const one = bigRow('a1b2c3d4e5f60718', 7, '2026-10-19 21:30:00', 'Mac');
  assert.equal(one.length, 10);
  assert.equal(one[9].length, 10000);
  const task = JSON.parse(one[9]);
  assert.equal(task.links.slack.length, 2000);
  assert.equal(task.memo.length, 2000);
  const rows = bigRows('a1b2c3d4e5f60718', '2026-10-19 21:30:00', 'Mac');
  assert.equal(rows.length, 500);
  assert.ok(rows.every((r) => r[9].length === 10000));
  assert.equal(new Set(rows.map((r) => r[6])).size, 500);
  const bytes = utf8Bytes(JSON.stringify({ majorDimension: 'ROWS', values: rows }));
  assert.ok(bytes > 5 * 1024 * 1024 && bytes < 10 * 1024 * 1024, 'about 5–10 MB per request: ' + bytes);
});

test('chunks stay under the byte limit and keep every row in order', () => {
  const rows = bigRows('a1b2c3d4e5f60718', '2026-10-19 21:30:00', 'Mac', 60);
  const chunks = chunkRows(rows, 200 * 1024);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), rows);
  for (const c of chunks) assert.ok(utf8Bytes(JSON.stringify(c)) <= 200 * 1024 + 2);
  assert.equal(chunkRows([['x'.repeat(5000)]], 10).length, 1, 'a row bigger than the limit still goes alone');
});

test('compare: same rows pass, a changed cell is found, missing trailing cells count as empty', () => {
  const sent = [['a', 'b', ''], ['c', 'd', 'e']];
  assert.deepEqual(compareRows(sent, [['a', 'b'], ['c', 'd', 'e']]).diff, 0);
  const bad = compareRows(sent, [['a', 'b'], ['c', 'X', 'e']]);
  assert.equal(bad.diff, 1);
  assert.deepEqual(bad.firstDiff, { row: 2, col: 'B', sentLength: 1, gotLength: 1 });
  const short = compareRows(sent, [['a', 'b']]);
  assert.equal(short.diff, 1);
  assert.equal(short.firstDiff.row, 2);
});

test('files.list query uses the test mark, never the sync mark', () => {
  assert.deepEqual({ ...APP_PROPS }, { app: 'jikko-list', kind: 'connect-test' });
  const q = markQuery();
  assert.equal(q, "appProperties has { key='app' and value='jikko-list' } and appProperties has { key='kind' and value='connect-test' } and trashed = false");
  assert.ok(!q.includes('sync'));
});

test('fillTo makes exact lengths', () => {
  assert.equal(fillTo('あいう', 7), 'あいうあいうあ');
  assert.equal(fillTo('ab', 0), '');
});
