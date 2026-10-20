// What the sync shows (7-12 of the spec): the small status (next to the tools at the top of each screen), the sync
// sheet, the banners, "どちらを残す？" and the "同期" part of the settings. Built with createElement / textContent only.

import { h, icon, fill } from '../dom.js';
import { openSheet, confirmDialog, toast } from '../ui.js';
import { fmtDateTime, fmtMD } from '../util.js';
import { RANK_LABEL, DURATION_LABEL, STATUS_LABEL, KIND_LABEL, STEP_STATE_LABEL, GROUP_LABEL } from '../tasks.js';
import { maskEmail, cleanClientId } from './google.js';

// Why the sync stopped, and what the person can do.
export const ERROR_TEXT = {
  'two-files': ['同期ファイルが2つあります', 'Googleドライブで、使わないほうをゴミ箱に入れてから［今すぐ同期］を押してください。'],
  'file-trashed': ['同期ファイルがゴミ箱に入っています', 'Googleドライブのゴミ箱から戻すと続けられます。作り直すなら、中身がいちばんそろっている端末で 設定 → 同期 →［この端末を外す］→［この端末をつなぐ］（作るか聞かれます）。'],
  'file-missing': ['同期ファイルが見つかりません', 'Googleドライブ（ゴミ箱も）と、ログインしているアカウントを確かめてください。勝手には作り直しません。作り直すなら 設定 → 同期 →［この端末を外す］→［この端末をつなぐ］。'],
  'not-found': ['同期ファイルが見つかりません', 'Googleドライブ（ゴミ箱も）と、ログインしているアカウントを確かめてください。勝手には作り直しません。作り直すなら 設定 → 同期 →［この端末を外す］→［この端末をつなぐ］。'],
  forbidden: ['Googleに断られました（権限がありません）', '管理者の設定でこのアプリが止められている可能性があります。管理者に相談してください。この端末の中のデータはそのまま使えます。'],
  busy: ['Googleが混んでいます', 'しばらくしてから自動でやり直します。'],
  'other-account': ['前と違うアカウントでログインしています', '同期ファイルは前のアカウントのものです。同じアカウントでログインし直してください。'],
  'tab-taken': ['端末の名前が重なっています', '設定 → 同期 で端末名を変えてから、もう一度つないでください。'],
  'need-login': ['Googleの確認が必要です', '［ログイン］を押してください。'],
  failed: ['同期できませんでした', 'しばらくしてからやり直します。続くときは［今すぐ同期］を押してください。'],
};

function errorText(code) {
  return ERROR_TEXT[code] || ERROR_TEXT.failed;
}

function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** The status in one short label and a color (null when the sync is not on this device). */
export function statusLabel(v) {
  if (!v.connected) return null;
  const pending = v.pending;
  switch (v.kind) {
    case 'paused': return { text: '一時停止中', tone: 'gray' };
    case 'syncing': return { text: '同期中…', tone: 'gray' };
    case 'error': return { text: '同期できません', tone: 'red' };
    case 'login': return { text: 'Googleの確認が必要', tone: 'orange' };
    case 'offline': return { text: 'オフライン' + (pending ? '・未送信' + pending + '件' : ''), tone: 'gray' };
    case 'choose': return { text: '選んでください ' + v.questions + '件', tone: 'orange' };
    default: return { text: '同期済み' + (v.lastSyncAt ? ' ' + hhmm(v.lastSyncAt) : ''), tone: 'green' };
  }
}

/** The small status button at the top of each screen. */
export function statusChip(control, ctx) {
  const s = statusLabel(control.view());
  if (!s) return null;
  return h('button', {
    type: 'button',
    class: 'sync-chip t-' + s.tone,
    'aria-label': '同期: ' + s.text + '（押すと詳しく）',
    onclick: () => openSyncSheet(control, ctx),
  }, h('span', { class: 'sync-dot', 'aria-hidden': 'true' }), h('span', { class: 'sync-chip-text' }, s.text));
}

function banner(tone, ic, title, text, button) {
  return h('div', { class: 'banner ' + tone },
    icon(ic, 'banner-icon'),
    h('div', { class: 'banner-text' }, h('strong', {}, title), text ? h('span', {}, text) : null),
    button || null);
}

/** Banners for the top of the list: questions, logging in, a stop. */
export function syncBanners(control, ctx) {
  const v = control.view();
  if (!v.connected || v.status !== 'on') return [];
  const out = [];
  if (v.questions) {
    out.push(banner('choose', 'alert-circle', '2台で同じ所を直した項目が' + v.questions + '件あります', 'どちらを残すか選ぶまで、その項目は直せません。',
      h('button', { type: 'button', class: 'btn small primary', onclick: () => openQuestions(control, ctx) }, '選ぶ')));
  }
  if (v.kind === 'login' && v.quietOk) {
    // the key ran out while something was being edited: it is fetched again by itself once the editing is over
    out.push(banner('warn', 'hourglass', '同期を止めています', '編集が終わると自動で再開します（Google の確認が要るため）。端末の中のデータはそのまま使えます。',
      h('button', { type: 'button', class: 'btn small primary', onclick: () => control.login({ silent: true }) }, '同期を再開')));
  } else if (v.kind === 'login') {
    out.push(banner('warn', 'user', 'Googleにログインしてください', '同期を続けるには Google の確認が必要です。端末の中のデータはそのまま使えます。',
      h('button', { type: 'button', class: 'btn small primary', onclick: () => control.login({ silent: false }) }, 'ログイン')));
  }
  if (v.kind === 'error' && v.error === 'other-account') {
    const [title] = errorText(v.error);
    out.push(banner('danger', 'user', title, otherAccountText(v),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => control.login({ silent: false }) }, 'ログインし直す')));
  } else if (v.kind === 'error') {
    const [title, text] = errorText(v.error);
    out.push(banner('danger', 'alert-circle', title, text,
      h('button', { type: 'button', class: 'btn small', onclick: () => control.syncNow('button') }, 'もう一度')));
  }
  return out;
}

/** "前と違うアカウント": which account has the sync file, and which one was chosen (masked). */
function otherAccountText(v) {
  const right = v.account && v.account.email ? maskEmail(v.account.email) : '前のアカウント';
  return '同期ファイルは ' + right + ' の Google ドライブにあります。そのアカウントを選んでログインし直してください' +
    (v.otherAccount ? '（いま選ばれたのは ' + maskEmail(v.otherAccount) + '）' : '') + '。この端末の中のデータはそのまま使えます。';
}

function kvRow(label, value) {
  return h('li', {}, h('span', {}, label), h('span', { class: 'kv-v' }, value));
}

/** The sheet opened from the status: what is going on, and the buttons. */
export function openSyncSheet(control, ctx) {
  const box = h('div');
  const render = () => {
    const v = control.view();
    const s = statusLabel(v) || { text: 'オフ', tone: 'gray' };
    const parts = [
      h('ul', { class: 'card kv' },
        kvRow('状態', s.text),
        kvRow('最後の同期', v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : 'まだありません'),
        kvRow('未送信', v.pending + '件'),
        v.questions ? kvRow('選んでください', v.questions + '件') : null,
        kvRow('アカウント', v.account && v.account.email ? maskEmail(v.account.email) : '（未ログイン）')),
    ];
    if (v.kind === 'error') {
      const [title, text] = errorText(v.error);
      parts.push(h('p', { class: 'sheet-note danger-text' }, title + '：' + (v.error === 'other-account' ? otherAccountText(v) : text)));
    }
    const buttons = [];
    if (v.questions) buttons.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => { sheet.close(); openQuestions(control, ctx); } }, icon('alert-circle'), '選ぶ（' + v.questions + '件）')));
    if (v.status === 'on') buttons.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => { await control.syncNow('button'); render(); } }, icon('arrow-back-up'), '今すぐ同期')));
    if (v.kind === 'login' || !v.tokenOk || v.error === 'other-account') buttons.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => control.login({ silent: false }) }, icon('user'), 'Googleにログイン')));
    if (v.status === 'on') buttons.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => { await control.pause(); render(); } }, icon('hourglass'), '一時停止')));
    if (v.status === 'paused') buttons.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => { await control.resume(); render(); } }, icon('arrow-right'), '再開')));
    parts.push(h('ul', { class: 'card form' }, buttons));
    parts.push(h('p', { class: 'sub-note' }, '同期ファイルはログインしたアカウントの Google ドライブにあります（行を下に足すだけの記録）。くわしくは 設定 → 同期。'));
    fill(box, ...parts);
  };
  render();
  const sheet = openSheet({ title: '同期', content: box, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
  return sheet;
}

// ---------------------------------------------------------------- "どちらを残す？"

function short(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function stepText(st, ctx) {
  if (!st) return '（消した）';
  return (ctx.personName(st.whoId) || '?') + '（' + (KIND_LABEL[st.kind] || '') + '）' + (st.note ? '・' + short(st.note, 20) : '') + '・' + (STEP_STATE_LABEL[st.state] || '');
}

/** One differing value in words. */
export function valueText(field, value, ctx) {
  const none = '（なし）';
  if (value === null || value === undefined) {
    if (/^line\./.test(field) || field.endsWith('.removed')) return '（消した）';
    return none;
  }
  const f = field.split('.');
  switch (f[0]) {
    case 'title': case 'nextAction': case 'name': case 'text': return value === '' ? '（空）' : short(value, 60);
    case 'memo': return value === '' ? '（空）' : short(value, 60);
    case 'due': return fmtMD(value, ctx.baseYear);
    case 'rank': return RANK_LABEL[value] || none;
    case 'duration': return DURATION_LABEL[value] || none;
    case 'star': case 'cOption': return value ? 'あり' : 'なし';
    case 'status': return STATUS_LABEL[value] || String(value);
    case 'group': return GROUP_LABEL[value] || String(value);
    case 'icon': return value ? String(value) : none;
    case 'links': return value ? short(String(value).replace(/^https?:\/\//, ''), 50) : none;
    case 'park': return value.parked ? 'あとで箱' + (value.returnOn ? '（戻す日 ' + fmtMD(value.returnOn, ctx.baseYear) + '）' : '') : 'しまっていない';
    case 'trash': case 'purged': case 'deleted': return String(value);
    case 'route':
      if (f.length === 1) return Array.isArray(value) ? value.length + '段：' + value.map((s) => stepText(s, ctx)).join(' → ') : none;
      if (f[2] === 'kind') return KIND_LABEL[value] || String(value);
      if (f[2] === 'whoId') return ctx.personName(value) || '?';
      if (f[2] === 'note') return value === '' ? '（空）' : short(value, 40);
      if (f[2] === 'state') return (STEP_STATE_LABEL[value.state] || '') + (value.doneAt ? ' ' + fmtMD(value.doneAt, ctx.baseYear) : value.waitSince ? '（' + fmtMD(value.waitSince, ctx.baseYear) + 'から）' : '');
      if (f[2] === 'removed') return stepText(value, ctx);
      return String(value);
    case 'line': return typeof value === 'string' ? short(value, 60) : short(value.text || '', 60);
    case 'over': return Array.isArray(value) ? value.length + '行' + (value.length ? '（' + value.slice(0, 3).map((x) => short(typeof x === 'string' ? x : x.text, 12)).join('・') + (value.length > 3 ? '…' : '') + '）' : '') : none;
    default: return short(typeof value === 'object' ? JSON.stringify(value) : String(value), 60);
  }
}

/** The words on the two buttons ("Mac のほうを残す"; ★ cases say what happens). */
export function sideLabels(q) {
  let a = q.a.device || 'こちら';
  let b = q.b.device || 'あちら';
  if (a === b) { a += '（1）'; b += '（2）'; }
  const special = q.fields.find((f) => f.field === 'trash' || f.field === 'purged' || f.field === 'deleted');
  const tail = (x) => (special ? '（' + x + '）' : '');
  return {
    a: a + 'のほうを残す' + tail(special ? special.a : ''),
    b: b + 'のほうを残す' + tail(special ? special.b : ''),
    aName: a,
    bName: b,
  };
}

function questionCard(control, q, ctx, after) {
  const labels = sideLabels(q);
  const head = (q.labels.type || '') + '「' + (q.labels.head || '') + '」';
  const rows = q.fields.map((f) => h('li', { class: 'q-row' },
    h('div', { class: 'q-field' }, f.label),
    h('div', { class: 'q-sides' },
      h('div', { class: 'q-side' }, h('span', { class: 'q-who' }, labels.aName + (q.a.at ? ' ' + fmtDateTime(q.a.at) : '')), h('span', { class: 'q-val' }, valueText(f.field, f.a, ctx))),
      h('div', { class: 'q-side' }, h('span', { class: 'q-who' }, labels.bName + (q.b.at ? ' ' + fmtDateTime(q.b.at) : '')), h('span', { class: 'q-val' }, valueText(f.field, f.b, ctx))))));
  const pick = async (side) => {
    const r = await control.choose(q.key, side);
    if (r.ok) toast('残しました（' + (side === 'a' ? labels.aName : labels.bName) + 'のほう）');
    else if (r.reason === 'changed') toast('中身が変わったので、もう一度選んでください', { duration: 5000 });
    else toast('この項目はもう選ばれています');
    after();
  };
  return h('section', { class: 'q-card' },
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, head)),
    h('ul', { class: 'card q-list' }, rows),
    h('div', { class: 'q-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => pick('a') }, labels.a),
      h('button', { type: 'button', class: 'btn', onclick: () => pick('b') }, labels.b)));
}

/** "どちらを残す？": every open question, or only the one of `onlyKey` (opening an item that waits for an answer). */
export function openQuestions(control, ctx, onlyKey) {
  const box = h('div');
  let sheet = null;
  const render = async () => {
    const all = await control.questions();
    const list = onlyKey ? all.filter((q) => q.key === onlyKey) : all;
    if (!list.length) {
      if (sheet) sheet.close();
      if (ctx.after) ctx.after();
      return;
    }
    fill(box,
      h('p', { class: 'sheet-note' }, '2台で同じ所を別々に直しました。項目ごとに、残すほうを選んでください（その項目の食い違い全部に効きます）。選ばなかったほうも、同期ファイルの記録には残ります。'),
      ...list.map((q) => questionCard(control, q, ctx, () => { render(); if (ctx.after) ctx.after(); })));
  };
  sheet = openSheet({ title: 'どちらを残す？', content: box, cancelLabel: null, onDone: () => true, doneLabel: 'あとで' });
  render();
  return sheet;
}

// ---------------------------------------------------------------- settings → 同期

/** The "同期" part of the settings sheet. rerender() draws the settings again. */
export function syncSettings(control, ctx, rerender) {
  const v = control.view();
  const parts = [h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '同期（PC とスマホの中身をそろえる）'))];
  const rows = [];
  const idInput = h('input', { type: 'text', class: 'field', value: v.clientId, placeholder: '…apps.googleusercontent.com', 'aria-label': 'クライアントID', autocomplete: 'off', spellcheck: 'false' });
  const saveId = async () => {
    if (!cleanClientId(idInput.value)) { toast('クライアントIDの形が違います（Google Cloud の「クライアント」画面からコピーして貼ってください）'); return; }
    await control.setClientId(idInput.value);
    toast('クライアントIDを保存しました（この端末だけ）');
    rerender();
  };
  if (!v.connected) {
    rows.push(h('li', { class: 'form-row stack' }, h('span', { class: 'f-label' }, 'クライアントID'), idInput,
      h('button', { type: 'button', class: 'mini-btn', onclick: saveId }, '保存')));
  }
  if (v.configured) {
    rows.push(h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, 'アカウント'),
      h('span', { class: 'f-hint' }, v.account && v.account.email ? maskEmail(v.account.email) + (v.tokenOk ? '' : '（ログインが必要）') : '未ログイン'),
      h('button', { type: 'button', class: 'mini-btn', onclick: () => control.login({ silent: false }) }, 'Googleでログイン')));
  }
  const nameInput = h('input', { type: 'text', class: 'field small', value: v.deviceName, maxlength: '20', 'aria-label': '端末名' });
  rows.push(h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, '端末名'), nameInput,
    h('button', { type: 'button', class: 'mini-btn', onclick: async () => { if (await control.setDeviceName(nameInput.value)) { toast('端末名を保存しました'); rerender(); } } }, '保存')));
  if (v.configured && !v.connected) {
    rows.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => { await control.connect(); rerender(); } }, icon('link'), 'この端末をつなぐ（同期をオンにする）')));
  }
  parts.push(h('ul', { class: 'card form' }, rows.splice(0)));
  if (v.connected) {
    const s = statusLabel(v);
    parts.push(h('ul', { class: 'card kv' },
      kvRow('状態', v.status === 'paused' ? '一時停止中' : 'オン（' + s.text + '）'),
      kvRow('最後の同期', v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : 'まだありません'),
      kvRow('未送信', v.pending + '件'),
      kvRow('記録の行数', v.rows.toLocaleString() + '行'),
      kvRow('読めなかった行', v.unreadable + '行')));
    if (v.status === 'on') rows.push(h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => { await control.syncNow('button'); rerender(); } }, icon('arrow-back-up'), '今すぐ同期')));
    rows.push(h('li', {}, v.status === 'paused'
      ? h('button', { type: 'button', class: 'action', onclick: async () => { await control.resume(); rerender(); } }, icon('arrow-right'), '再開する（止めていた間の変更も送ります）')
      : h('button', { type: 'button', class: 'action', onclick: async () => { await control.pause(); rerender(); } }, icon('hourglass'), '一時停止（Google との通信を止める）')));
    rows.push(h('li', {}, h('button', {
      type: 'button',
      class: 'action danger',
      onclick: async () => {
        let unsent = 0;
        try { unsent = await control.unsentCount(); } catch (e) { unsent = 0; }
        const ok = await confirmDialog({
          title: 'この端末を外しますか？',
          message: (unsent ? '⚠ まだ送っていない変更が ' + unsent + '件あります。外すと同期データには送られません。先に［今すぐ同期］で送ってください（送らずに外した変更は、この端末の中身と「同期を始める前の控え」に残ります）。\n\n' : '') +
            'この端末の同期の記録（読んだ版の控え・同期の状態・Googleの鍵）を消します。タスクやメモなどの中身と、Googleドライブの同期ファイルは消しません。\n\n次につなぐと、新しい端末として同期データを「受け取る」ところからやり直しになります（今の中身は「同期を始める前の控え」に残り、設定 → 控え から戻せます）。',
          okLabel: unsent ? '送らずに外す' : '外す',
          destructive: true,
        });
        if (!ok) return;
        await control.detach();
        toast('この端末を外しました（中身はそのまま）');
        rerender();
      },
    }, icon('x'), 'この端末を外す')));
  }
  if (rows.length) parts.push(h('ul', { class: 'card form' }, rows));
  parts.push(h('p', { class: 'sub-note' }, v.connected
    ? '同期ファイルは、ログインしたアカウントの Google ドライブに1つだけあります。変更は1回ごとに1行ずつ下に足すだけで、前の行は書き換えません。権限は「このアプリが作ったファイルだけ」です。'
    : 'クライアントID（Google Cloud の「クライアント」画面でコピーしたもの）を貼って保存し、ログインしてから［この端末をつなぐ］を押します。クライアントIDはこの端末の中だけに保存されます。'));
  return parts;
}
