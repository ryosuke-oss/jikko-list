// 実行リスト — start-up, screens and user actions.
// Data lives only in this browser (IndexedDB). There is no network code in this app.

import { h, icon, fill, shapesSvg, debounce, isPlainEnter } from './dom.js';
import { openSheet, alertDialog, confirmDialog, pickFrom, toast, isPhone, overlayOpen } from './ui.js';
import * as U from './util.js';
import * as P from './parse.js';
import * as T from './tasks.js';
import * as D from './dragon.js';
import * as PL from './plan.js';
import * as ST from './store.js';

const TAB_ID = U.uid();
const UI_KEY = 'jikko-list.ui';

const S = {
  db: null,
  data: null,
  rev: 0,
  today: U.todayStr(),
  ui: loadUi(),
  filters: T.emptyFilters(),
  recentlyDone: new Map(),
  queue: Promise.resolve(),
  bc: null,
  layout: '',
  sortables: {},
  highlight: null,
  iosBannerHidden: false,
};

const C = {}; // components that are created once and re-filled

// ---------------------------------------------------------------- small helpers

function nowIso() {
  return new Date().toISOString();
}

function loadUi() {
  const base = { smart: 'all', tab: 'today', goalSeg: 'week', scheduleCollapsed: false };
  try {
    const raw = window.localStorage.getItem(UI_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (T.SMART_LISTS.some((s) => s.key === v.smart)) base.smart = v.smart;
      if (['today', 'tasks', 'memo', 'goals', 'dragon'].includes(v.tab)) base.tab = v.tab;
      if (PL.GOAL_KINDS.includes(v.goalSeg)) base.goalSeg = v.goalSeg;
      base.scheduleCollapsed = v.scheduleCollapsed === true;
    }
  } catch (e) { /* storage blocked: defaults are fine */ }
  return base;
}

function saveUi() {
  try { window.localStorage.setItem(UI_KEY, JSON.stringify(S.ui)); } catch (e) { /* ignore */ }
}

function peopleMap() {
  return new Map(S.data.people.map((p) => [p.id, p]));
}

function activePeople() {
  return S.data.people.filter((p) => !p.deletedAt);
}

function findTask(id) {
  return S.data.tasks.find((t) => t.id === id) || null;
}

function thisYear() {
  return Number(S.today.slice(0, 4));
}

function longDate(s) {
  const d = U.parseYmd(s);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + U.WEEKDAYS[d.getDay()] + '曜日';
}

function circled(n) {
  return '①②③④⑤⑥⑦⑧⑨⑩'[n - 1] || String(n);
}

function avatar(p, size) {
  const group = p ? p.group : 'dept';
  return h('span', { class: 'avatar g-' + group + (size ? ' ' + size : ''), 'aria-hidden': 'true' },
    p && p.icon ? icon(p.icon) : (p ? p.initial : '?'));
}

function toolButton(name, label, onclick) {
  return h('button', { type: 'button', class: 'tool-btn', 'aria-label': label, title: label, onclick }, icon(name));
}

function setBar(el, ratio) {
  el.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
}

function dragonSvg(stage, cls) {
  return shapesSvg(D.dragonShapes(stage), '0 0 120 100', cls);
}

function kindIcon(kind) {
  return icon(kind === 'request' ? 'send' : kind === 'reply' ? 'arrow-back-up' : 'eye-check');
}

// ---------------------------------------------------------------- saving

/** Queue a save of the given keys (one transaction each, in order). Resolves to true when it was written. */
function save(keys) {
  const data = S.data;
  S.queue = S.queue.then(async () => {
    if (data !== S.data) {
      toast('別のタブの変更を読み込んだため、直前の操作は保存されませんでした');
      return false;
    }
    try {
      const rev = await ST.saveKeys(S.db, data, keys, S.rev);
      S.rev = rev;
      if (S.bc) S.bc.postMessage({ type: 'saved', rev, from: TAB_ID });
      return true;
    } catch (e) {
      if (e instanceof ST.ConflictError) {
        await reloadFromDb();
        toast('別のタブで変更があったので読み直しました。もう一度操作してください');
      } else {
        console.error(e);
        toast('保存できませんでした。設定 → 書き出す で控えを取ってください', { duration: 8000 });
      }
      return false;
    }
  });
  return S.queue;
}

function fillMissing(raw) {
  const base = ST.newState(S.today, nowIso());
  const out = {};
  for (const k of ST.KEYS) out[k] = raw[k] === undefined ? base[k] : raw[k];
  return out;
}

async function reloadFromDb() {
  const { data, rev, empty } = await ST.loadState(S.db);
  if (empty) return;
  try {
    S.data = ST.cleanState(fillMissing(data));
    S.rev = rev;
  } catch (e) {
    console.error(e);
    return;
  }
  renderAll();
}

async function checkRev() {
  if (!S.db) return;
  const { rev } = await ST.loadState(S.db).catch(() => ({ rev: S.rev }));
  if (rev !== S.rev) {
    S.queue = S.queue.then(reloadFromDb);
  }
}

// ---------------------------------------------------------------- start-up

async function start() {
  buildShell();
  try {
    S.db = await ST.openDb();
  } catch (e) {
    fatal('データベースを開けませんでした', String(e && e.message ? e.message : e));
    return;
  }
  // Another tab is upgrading or deleting the database: let go of it instead of blocking.
  S.db.onversionchange = () => {
    S.db.close();
    toast('データベースが別の画面で変更されました。再読み込みしてください', { duration: 10000 });
  };
  const loaded = await ST.loadState(S.db);
  if (loaded.empty) {
    S.data = ST.newState(S.today, nowIso());
    S.rev = loaded.rev;
    await save(ST.KEYS);
  } else {
    try {
      S.data = ST.cleanState(fillMissing(loaded.data));
      S.rev = loaded.rev;
    } catch (e) {
      fatalData(loaded.data, e);
      return;
    }
  }
  setupChannel();
  setupKeyboardInset();
  setupLayout();
  await dayCheck(true);
  persistCheck();
  setupTimers();
  document.getElementById('app').hidden = false;
  document.getElementById('boot').remove();
  if (performance.mark) performance.mark('jikko:ready'); // start-up time, readable in the browser tools
}

function fatal(title, detail) {
  const boot = document.getElementById('boot');
  fill(boot, h('div', { class: 'fatal' }, h('h1', {}, title), h('p', {}, detail)));
}

/** The saved data could not be read: offer the raw data as a file, write nothing. */
function fatalData(raw, err) {
  const boot = document.getElementById('boot');
  const btn = h('button', {
    type: 'button',
    class: 'btn primary',
    onclick: () => downloadJson({ app: ST.APP_ID, format: 'raw', exportedAt: nowIso(), data: raw }, 'jikko-list_raw.json'),
  }, 'いまのデータをそのまま書き出す');
  fill(boot, h('div', { class: 'fatal' },
    h('h1', {}, '保存されたデータを読めませんでした'),
    h('p', {}, '何も書き換えていません。下のボタンで中身をファイルに残してから相談してください。'),
    h('p', { class: 'muted' }, String(err && err.message ? err.message : err)),
    btn));
}

/** Day changed (or start-up): roll schedule / goals over, bring back parked tasks, daily copy. */
async function dayCheck(force) {
  const today = U.todayStr();
  const changed = today !== S.today;
  S.today = today;
  const at = nowIso();
  const d = S.data;
  const keys = new Set();
  if (PL.rolloverSchedule(d, today)) { keys.add('schedule'); keys.add('scheduleLog'); }
  if (PL.rolloverGoals(d.goals, d.goalLog, today, at).length) { keys.add('goals'); keys.add('goalLog'); }
  const back = T.returnDueParked(d.tasks, today, at);
  if (back.length) keys.add('tasks');
  if (keys.size) save([...keys]);
  await S.queue;
  try {
    await ST.autoBackup(S.db, S.data, today, at);
  } catch (e) {
    console.warn('auto backup failed', e);
  }
  if (changed || force || keys.size) renderAll();
  if (back.length) toast(back.length + '件があとで箱から戻りました');
}

async function persistCheck() {
  const st = S.data.settings;
  let p = await ST.isPersisted();
  if (p === false && !st.persistAsked) {
    st.persistAsked = true;
    p = await ST.requestPersist();
    save(['settings']);
  }
  if (p !== st.persisted) {
    st.persisted = p;
    save(['settings']);
  }
}

function setupChannel() {
  if (typeof BroadcastChannel !== 'function') return;
  S.bc = new BroadcastChannel('jikko-list');
  S.bc.onmessage = (e) => {
    const m = e.data;
    if (!m || m.from === TAB_ID || m.type !== 'saved') return;
    if (m.rev === S.rev) return;
    S.queue = S.queue.then(async () => {
      await reloadFromDb();
      toast('別のタブの変更を読み込みました');
    });
  };
}

/** On phones the on-screen keyboard covers the bottom; sheets are lifted by its height (--kb). */
function setupKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', inset + 'px');
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

function setupTimers() {
  // Due labels and return dates are recalculated every hour while the app is open.
  setInterval(() => { dayCheck(false); }, 60 * 60 * 1000);
  const toMidnight = () => {
    const n = new Date();
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 5);
    setTimeout(() => { dayCheck(true); toMidnight(); }, next.getTime() - n.getTime());
  };
  toMidnight();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkRev();
    dayCheck(false);
  });
}

// ---------------------------------------------------------------- layout

function buildShell() {
  const app = document.getElementById('app');
  C.band = h('div', { class: 'band' });
  C.left = h('aside', { class: 'col col-left', 'aria-label': '竜・リスト・目標' });
  C.center = h('main', { class: 'col col-center', id: 'main' });
  C.right = h('aside', { class: 'col col-right', 'aria-label': 'メモ・あとで箱' });
  C.panesTop = h('div', { class: 'panes-top' });
  C.panes = {};
  const paneBox = h('div', { class: 'panes' });
  for (const t of TABS) {
    C.panes[t.key] = h('section', { class: 'pane', dataset: { tab: t.key }, 'aria-label': t.label });
    paneBox.append(C.panes[t.key]);
  }
  C.tabbar = h('nav', { class: 'tabbar', 'aria-label': '画面の切り替え' });
  C.fab = h('button', { type: 'button', class: 'fab', 'aria-label': '新しいタスクを追加', onclick: () => openAddSheet('', null) }, icon('plus'));

  C.banners = h('div', { class: 'banners' });
  C.header = h('div', { class: 'large-head' });
  C.quick = createQuickAdd({});
  buildSchedule();
  buildList();
  C.tiles = h('div', { class: 'tiles', role: 'group', 'aria-label': 'リスト' });
  C.goals = h('section', { class: 'goals', 'aria-label': '目標' });
  C.dragonWidget = h('button', { type: 'button', class: 'dragon-card', onclick: openDragonSheet, 'aria-label': '竜を見る' });
  buildMemo();
  buildBox();
  C.heads = {};
  for (const t of TABS) C.heads[t.key] = h('div', { class: 'large-head' });
  C.todayTasks = h('section', { class: 'today-tasks', 'aria-label': '今日やること' });
  C.weekGoals = h('section', { class: 'week-goals', 'aria-label': '今週の目標' });
  C.dragonFull = h('section', { class: 'dragon-full', 'aria-label': '竜' });

  app.append(C.band, C.left, C.center, C.right, C.panesTop, paneBox, C.tabbar, C.fab);
}

const TABS = [
  { key: 'today', label: '今日', icon: 'sun' },
  { key: 'tasks', label: 'タスク', icon: 'list-check' },
  { key: 'memo', label: 'メモ', icon: 'notes' },
  { key: 'goals', label: '目標', icon: 'target' },
  { key: 'dragon', label: '竜', icon: 'egg' },
];

function currentLayout() {
  if (window.matchMedia('(min-width: 1024px)').matches) return 'pc';
  if (window.matchMedia('(min-width: 768px)').matches) return 'tablet';
  return 'mobile';
}

function setupLayout() {
  const apply = () => {
    const l = currentLayout();
    if (l === S.layout) return;
    S.layout = l;
    document.documentElement.dataset.layout = l;
    placeComponents(l);
    setupSortables();
    renderAll();
  };
  window.matchMedia('(min-width: 1024px)').addEventListener('change', apply);
  window.matchMedia('(min-width: 768px)').addEventListener('change', apply);
  apply();
}

function placeComponents(l) {
  const put = (box, ...els) => fill(box, ...els);
  if (l === 'pc') {
    put(C.left, C.dragonWidget, C.tiles, C.goals);
    put(C.center, C.banners, C.header, C.quick.el, C.schedule, C.list);
    put(C.right, C.memo, C.box);
    put(C.band);
  } else if (l === 'tablet') {
    put(C.band, C.dragonWidget);
    put(C.center, C.banners, C.header, C.quick.el, C.schedule, C.list);
    put(C.right, C.tiles, C.goals, C.memo, C.box);
    put(C.left);
  } else {
    put(C.left);
    put(C.center);
    put(C.right);
    put(C.band);
    put(C.panesTop, C.banners);
    put(C.panes.today, C.heads.today, C.schedule, C.todayTasks, C.weekGoals);
    put(C.panes.tasks, C.heads.tasks, C.tiles, C.list);
    put(C.panes.memo, C.heads.memo, C.memo);
    put(C.panes.goals, C.heads.goals, C.goals);
    put(C.panes.dragon, C.heads.dragon, C.dragonFull);
  }
}

function setTab(key) {
  S.ui.tab = key;
  saveUi();
  renderTabs();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- render

function renderAll() {
  if (!S.data) return;
  renderBanners();
  renderHeader();
  renderTiles();
  renderList();
  renderSchedule(true);
  renderGoals(false);
  renderDragonWidget();
  renderMemo(true);
  renderBox();
  if (S.layout === 'mobile') {
    renderHeads();
    renderTodayTasks();
    renderWeekGoals();
    renderDragonFull(C.dragonFull);
    renderTabs();
  }
  C.quick.refresh();
}

function headTools() {
  return h('div', { class: 'head-tools' },
    toolButton('history', '完了ログ', openDoneLog),
    toolButton('settings', '設定', openSettings));
}

function renderHeader() {
  fill(C.header, 
    h('h1', { class: 'large-title' }, '今日'),
    h('span', { class: 'large-date' }, longDate(S.today)),
    headTools());
}

function renderHeads() {
  for (const t of TABS) {
    fill(C.heads[t.key], 
      h('h1', { class: 'large-title' }, t.label),
      t.key === 'today' ? h('span', { class: 'large-date' }, longDate(S.today)) : null,
      headTools());
  }
}

function renderTabs() {
  for (const t of TABS) C.panes[t.key].classList.toggle('active', S.ui.tab === t.key);
  fill(C.tabbar, ...TABS.map((t) => h('button', {
    type: 'button',
    class: 'tab' + (S.ui.tab === t.key ? ' on' : ''),
    'aria-current': S.ui.tab === t.key ? 'page' : null,
    onclick: () => setTab(t.key),
  }, icon(t.icon), h('span', { class: 'tab-label' }, t.label))));
}

// ---- banners

function isIosBrowserTab() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - Date.parse(iso)) / 86400000;
}

function renderBanners() {
  const items = [];
  if (isIosBrowserTab() && !S.iosBannerHidden) {
    items.push(h('div', { class: 'banner' },
      icon('device-mobile', 'banner-icon'),
      h('div', { class: 'banner-text' },
        h('strong', {}, 'ホーム画面に追加して使ってください'),
        h('span', {}, 'Safari のままだと、しばらく開かないとデータが消えることがあります。共有ボタン →「ホーム画面に追加」。Safari とホーム画面版のデータは別々です。')),
      h('button', { type: 'button', class: 'banner-x', 'aria-label': 'この案内を閉じる', onclick: () => { S.iosBannerHidden = true; renderBanners(); } }, icon('x'))));
  }
  const st = S.data.settings;
  const since = daysSince(st.lastExportAt || st.createdAt);
  if (since >= 7) {
    items.push(h('div', { class: 'banner warn' },
      icon('download', 'banner-icon'),
      h('div', { class: 'banner-text' },
        h('strong', {}, '書き出しておきましょう'),
        h('span', {}, st.lastExportAt ? '最後の書き出しから' + Math.floor(since) + '日たちました。ブラウザのデータを消すと全部消えるので、ファイルに控えを残します。' : 'まだ一度も書き出していません。ブラウザのデータを消すと全部消えるので、ファイルに控えを残します。')),
      h('button', { type: 'button', class: 'btn small primary', onclick: doExport }, '書き出す')));
  }
  fill(C.banners, ...items);
}

// ---- smart list tiles

function selectSmart(key) {
  S.ui.smart = key;
  saveUi();
  renderTiles();
  renderList();
  if (S.layout === 'mobile') C.list.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderTiles() {
  const counts = T.smartCounts(S.data.tasks, S.today);
  fill(C.tiles, ...T.SMART_LISTS.map((s) => h('button', {
    type: 'button',
    class: 'tile' + (S.ui.smart === s.key ? ' selected' : ''),
    'aria-pressed': String(S.ui.smart === s.key),
    dataset: { smart: s.key },
    onclick: () => selectSmart(s.key),
  },
  h('span', { class: 'tile-top' },
    h('span', { class: 'tile-icon c-' + s.color }, icon(s.icon)),
    h('span', { class: 'tile-count' }, String(counts[s.key]))),
  h('span', { class: 'tile-label' }, s.label))));
}

// ---- the task list

function buildList() {
  C.listHead = h('div', { class: 'list-head' });
  C.filterChips = h('div', { class: 'filter-chips' });
  C.listUl = h('ul', { class: 'card list', 'aria-label': 'タスク' });
  C.listEmpty = h('p', { class: 'empty' });
  C.list = h('section', { class: 'tasklist' }, C.listHead, C.filterChips, C.listUl, C.listEmpty);
}

function visibleTasks() {
  const key = S.ui.smart;
  return S.data.tasks
    .filter((t) => (T.inSmart(key, t, S.today) || S.recentlyDone.has(t.id)) && T.matchFilters(S.filters, t, S.today))
    .sort(T.byOrder);
}

function renderList() {
  const smart = T.SMART_LISTS.find((s) => s.key === S.ui.smart);
  const n = T.activeFilterCount(S.filters);
  fill(C.listHead, 
    h('h2', { class: 'list-title' }, smart.label),
    h('span', { class: 'list-sub' }, S.ui.smart === 'parked' ? '戻す日が来たら一覧の先頭に戻ります' : (S.layout === 'mobile' ? '長押しで並べ替え' : '上から順にやる')),
    h('button', {
      type: 'button',
      class: 'filter-btn' + (n ? ' active' : ''),
      'aria-label': '絞り込み' + (n ? '（' + n + '件の条件）' : ''),
      onclick: openFilterMenu,
    }, icon('filter'), h('span', {}, '絞り込み'), n ? h('span', { class: 'count-pill' }, String(n)) : null));

  const chips = [];
  for (const g of T.FILTER_GROUPS) {
    for (const it of g.items) {
      const on = it.key === 'cOption' ? S.filters.cOption : S.filters[it.key] === it.value;
      if (!on) continue;
      chips.push(h('button', {
        type: 'button',
        class: 'chip on',
        'aria-label': it.label + ' の絞り込みを外す',
        onclick: () => { clearFilter(it.key); renderList(); },
      }, it.key === 'due' ? '期日 ' + it.label : it.key === 'duration' ? '所要' + it.label : it.label, icon('x')));
    }
  }
  fill(C.filterChips, ...chips);
  C.filterChips.hidden = chips.length === 0;

  const list = visibleTasks();
  const parkedView = S.ui.smart === 'parked';
  const draggable = !parkedView;
  fill(C.listUl, ...list.map((t) => taskRow(t, { draggable, parkedView })));
  C.listUl.hidden = list.length === 0;
  C.listEmpty.hidden = list.length > 0;
  C.listEmpty.textContent = n ? '条件に合うタスクはありません' : (parkedView ? 'あとで箱は空です' : 'タスクはありません');
  if (S.sortables.list) S.sortables.list.option('disabled', !draggable);
  flashHighlight(C.listUl);
}

function flashHighlight(container) {
  if (!S.highlight) return;
  const row = container.querySelector('[data-id="' + CSS.escape(S.highlight) + '"]');
  if (!row) return;
  row.classList.add('flash');
  row.scrollIntoView({ block: 'nearest' });
  S.highlight = null;
}

function clearFilter(key) {
  if (key === 'cOption') S.filters.cOption = false;
  else S.filters[key] = null;
}

function metaLine(parts) {
  const out = [];
  parts.forEach((m, i) => {
    if (i > 0) out.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '・'));
    out.push(h('span', { class: 'm-' + m.tone }, m.text));
  });
  return h('div', { class: 'row-meta' }, out);
}

function taskRow(t, opts) {
  const done = t.status === 'done';
  const li = h('li', { class: 'row' + (done ? ' is-done' : ''), dataset: { id: t.id } });
  const check = h('button', {
    type: 'button',
    class: 'check' + (done ? ' on' : ''),
    'aria-label': (done ? '完了を取り消す: ' : '完了にする: ') + t.title,
    onclick: (e) => { e.stopPropagation(); toggleDone(t.id); },
  }, done ? icon('check') : null);

  const title = h('div', { class: 'row-title' }, t.star ? h('span', { class: 'star', title: '重要' }, '★') : null, h('span', { class: 'row-title-text' }, t.title));
  const lines = [title];
  if (!done && t.rank === 'A' && t.nextAction && S.layout !== 'mobile') {
    lines.push(h('div', { class: 'row-next' }, icon('arrow-right'), h('span', {}, '次の一手: ' + t.nextAction)));
  }
  let meta;
  if (done) meta = [{ text: '完了・竜 +' + (t.xpGiven || 0), tone: 'green' }];
  else {
    meta = T.rowMeta(t, peopleMap(), S.today);
    if (t.returnedMark) meta.unshift({ text: '箱から戻りました', tone: 'returned' });
  }
  if (meta.length) lines.push(metaLine(meta));
  const main = h('div', {
    class: 'row-main',
    role: 'button',
    tabindex: '0',
    'aria-label': t.title + ' の詳細を開く',
    onclick: () => openDetail(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(t.id); } },
  }, lines);
  li.append(check, main);
  if (opts.parkedView) {
    li.append(h('button', { type: 'button', class: 'mini-btn', onclick: (e) => { e.stopPropagation(); unparkNow(t.id); } }, '戻す'));
  }
  if (t.rank) li.append(h('span', { class: 'rank rank-' + t.rank, title: T.RANK_LABEL[t.rank] }, t.rank));
  if (opts.draggable) li.append(h('span', { class: 'grip', title: 'ドラッグで並べ替え' }, icon('grip-vertical')));
  return li;
}

// ---- drag & drop

function setupSortables() {
  const Sortable = globalThis.Sortable;
  if (!Sortable) return;
  const mobile = S.layout === 'mobile';
  const common = {
    // The library's own pointer dragging (not the browser's drag & drop): same feel with a mouse and a finger,
    // and the dragged row is drawn above everything, so it can travel to the later box in the next column.
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    animation: 150,
    delay: mobile ? 250 : 0,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    ghostClass: 'drag-ghost',
    chosenClass: 'drag-chosen',
    dragClass: 'drag-drag',
    filter: '.check, .mini-btn, .line-del, .line-to, input, textarea',
    preventOnFilter: false,
  };
  if (!S.sortables.list) {
    S.sortables.list = Sortable.create(C.listUl, Object.assign({}, common, {
      group: { name: 'tasks', pull: true, put: false },
      draggable: '.row',
      onStart: () => document.documentElement.classList.add('dragging'),
      onEnd: (evt) => {
        document.documentElement.classList.remove('dragging');
        if (evt.to !== evt.from || evt.oldIndex === evt.newIndex) return;
        const ids = [...C.listUl.querySelectorAll('.row')].map((el) => el.dataset.id);
        T.applyReorder(S.data.tasks, ids);
        save(['tasks']);
        renderList();
        if (S.layout === 'mobile') renderTodayTasks();
      },
    }));
    S.sortables.box = Sortable.create(C.boxZone, {
      forceFallback: true,
      group: { name: 'tasks', pull: false, put: true },
      sort: false,
      draggable: '.row',
      onAdd: (evt) => {
        const id = evt.item.dataset.id;
        setTimeout(() => askPark(id), 0);
      },
    });
    S.sortables.schedule = Sortable.create(C.schedUl, Object.assign({}, common, {
      draggable: '.line',
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const ids = [...C.schedUl.querySelectorAll('.line')].map((el) => el.dataset.id);
        const byId = new Map(S.data.schedule.lines.map((l) => [l.id, l]));
        S.data.schedule.lines = ids.map((id) => byId.get(id)).filter(Boolean);
        save(['schedule']);
        renderSchedule();
      },
    }));
  }
  const handle = mobile ? null : '.grip';
  for (const key of ['list', 'schedule']) {
    S.sortables[key].option('handle', handle);
    S.sortables[key].option('delay', mobile ? 250 : 0);
  }
}

// ---- schedule (today only)

function buildSchedule() {
  C.schedHead = h('div', { class: 'group-head' });
  C.schedUl = h('ul', { class: 'card lines', 'aria-label': '今日の予定' });
  C.schedInput = h('input', {
    type: 'text',
    class: 'line-input',
    placeholder: '予定を追加（例 15:00 打ち合わせ）',
    'aria-label': '予定を追加',
    maxlength: String(PL.SCHEDULE_LIMITS.chars),
    enterkeyhint: 'done',
    autocomplete: 'off',
  });
  C.schedInput.addEventListener('keydown', (e) => {
    if (!isPlainEnter(e)) return;
    e.preventDefault();
    addScheduleFromText(C.schedInput.value);
  });
  C.schedInput.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text && /[\r\n]/.test(text.trim())) {
      e.preventDefault();
      addScheduleFromText(withTyped(C.schedInput, text));
    }
  });
  C.schedNote = h('p', { class: 'sub-note' });
  C.schedBody = h('div', { class: 'sched-body' }, C.schedUl, h('div', { class: 'card add-card' }, C.schedInput), C.schedNote);
  C.schedule = h('section', { class: 'schedule', 'aria-label': '今日の予定' }, C.schedHead, C.schedBody);
}

/** The pasted text placed where the cursor is, so what was already typed is kept. */
function withTyped(input, pasted) {
  const v = input.value;
  const a = input.selectionStart == null ? v.length : input.selectionStart;
  const b = input.selectionEnd == null ? v.length : input.selectionEnd;
  return v.slice(0, a) + pasted + v.slice(b);
}

function addScheduleFromText(text) {
  const s = S.data.schedule;
  if (!String(text).trim()) return;
  if (s.lines.length >= PL.SCHEDULE_LIMITS.lines) {
    toast('予定は' + PL.SCHEDULE_LIMITS.lines + '件までです');
    return;
  }
  const n = PL.addScheduleText(s, text);
  if (!n) return;
  C.schedInput.value = '';
  save(['schedule']);
  renderSchedule();
  if (n > 1) toast(n + '件の予定を入れました');
}

function timeText(text) {
  const st = PL.splitTime(text);
  return st.time
    ? [h('span', { class: 'time' }, st.time), h('span', { class: 'line-text' }, st.rest)]
    : [h('span', { class: 'time empty' }), h('span', { class: 'line-text' }, text)];
}

function isEditingIn(el) {
  const a = document.activeElement;
  return Boolean(a && a.classList && a.classList.contains('line-edit') && el.contains(a));
}

function renderSchedule(fromAll) {
  if (fromAll && isEditingIn(C.schedUl)) return;
  const s = S.data.schedule;
  const collapsible = S.layout !== 'mobile';
  const collapsed = collapsible && S.ui.scheduleCollapsed;
  fill(C.schedHead, 
    collapsible
      ? h('button', {
        type: 'button',
        class: 'group-toggle',
        'aria-expanded': String(!collapsed),
        onclick: () => { S.ui.scheduleCollapsed = !S.ui.scheduleCollapsed; saveUi(); renderSchedule(); },
      }, icon(collapsed ? 'chevron-right' : 'chevron-down'), h('span', {}, '今日の予定'), h('span', { class: 'group-count' }, s.lines.length ? s.lines.length + '件' : ''))
      : h('span', { class: 'group-label' }, '予定'),
    h('button', { type: 'button', class: 'link-btn', onclick: openPastSchedule }, '過去の予定', icon('chevron-right')));
  C.schedBody.hidden = collapsed;
  fill(C.schedUl, ...s.lines.map((l) => scheduleLine(l)));
  C.schedUl.hidden = s.lines.length === 0;
  const full = s.lines.length >= PL.SCHEDULE_LIMITS.lines;
  C.schedInput.disabled = full;
  C.schedNote.textContent = full ? '予定は' + PL.SCHEDULE_LIMITS.lines + '件までです' : '複数行を貼り付けると、1行ずつ入ります。日付が変わると「過去の予定」へ移ります（消えません）。';
}

function scheduleLine(l) {
  const li = h('li', { class: 'line', dataset: { id: l.id } });
  const text = h('button', { type: 'button', class: 'line-body', 'aria-label': l.text + '（押すと書き直せます）', onclick: () => editLineInline(li, l.text, (v) => {
    const line = S.data.schedule.lines.find((x) => x.id === l.id);
    if (!line) return;
    if (!v.trim()) { renderSchedule(); return; }
    line.text = U.clampText(v.trim(), PL.SCHEDULE_LIMITS.chars);
    save(['schedule']);
    renderSchedule();
  }, () => renderSchedule()) }, timeText(l.text));
  const del = h('button', { type: 'button', class: 'line-del', 'aria-label': '予定を消す: ' + l.text, onclick: () => {
    const lines = S.data.schedule.lines;
    const i = lines.findIndex((x) => x.id === l.id);
    if (i < 0) return;
    const [removed] = lines.splice(i, 1);
    save(['schedule']);
    renderSchedule();
    toast('予定を消しました', { actionLabel: '元に戻す', onAction: () => { S.data.schedule.lines.splice(i, 0, removed); save(['schedule']); renderSchedule(); }, duration: 5000 });
  } }, icon('x'));
  li.append(text, del, h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip-vertical')));
  return li;
}

/** Turn a line into an input; Enter / leaving the field saves, Esc cancels. */
function editLineInline(li, value, onCommit, onCancel) {
  const input = h('input', { type: 'text', class: 'line-edit', value, maxlength: '500', enterkeyhint: 'done', 'aria-label': '書き直す' });
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (commit) onCommit(input.value);
    else onCancel();
  };
  input.addEventListener('keydown', (e) => {
    if (isPlainEnter(e)) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  fill(li, input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---- goals (week / month / year)

const saveGoals = debounce(() => save(['goals']), 400);

function renderGoals(force) {
  // While a goal line is being typed, outside updates do not redraw it (the typing would be lost).
  if (!force && C.goals.contains(document.activeElement)) return;
  const kind = S.ui.goalSeg;
  const period = S.data.goals[kind];
  const key = PL.storedKey(S.data.goals, kind);
  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': '目標の期間' }, PL.GOAL_KINDS.map((k) => h('button', {
    type: 'button',
    role: 'tab',
    class: 'seg-btn' + (k === kind ? ' on' : ''),
    'aria-selected': String(k === kind),
    onclick: () => { S.ui.goalSeg = k; saveUi(); renderGoals(true); },
  }, PL.GOAL_KIND_LABEL[k])));
  const ul = h('ul', { class: 'card goal-lines' });
  period.lines.forEach((line, i) => ul.append(goalRow(kind, i, line)));
  if (period.lines.length < PL.GOAL_LIMITS.lines) {
    ul.append(h('li', { class: 'goal-add' }, h('button', {
      type: 'button',
      class: 'link-btn',
      onclick: () => {
        S.data.goals[kind].lines.push('');
        renderGoals(true);
        focusGoal(S.data.goals[kind].lines.length - 1);
      },
    }, icon('plus'), '書き足す')));
  }
  fill(C.goals, 
    S.layout === 'mobile' ? null : h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '目標')),
    seg,
    h('div', { class: 'period-label' }, PL.periodLabel(kind, key)),
    ul,
    h('button', { type: 'button', class: 'link-btn', onclick: () => openGoalReview(kind) }, 'ふり返り', icon('chevron-right')),
    S.layout === 'mobile' ? h('p', { class: 'sub-note' }, '期間が終わると自動で「ふり返り」に移ります。消えません。') : null);
}

function focusGoal(i) {
  const el = C.goals.querySelectorAll('.goal-input')[i];
  if (el) el.focus();
}

function goalRow(kind, i, line) {
  const input = h('input', {
    type: 'text',
    class: 'goal-input',
    value: line,
    maxlength: String(PL.GOAL_LIMITS.chars),
    placeholder: '目標を書く',
    enterkeyhint: 'next',
    'aria-label': PL.GOAL_KIND_LABEL[kind] + 'の目標 ' + (i + 1),
  });
  input.addEventListener('input', () => {
    const lines = S.data.goals[kind].lines;
    if (i >= lines.length) return; // the period changed or another tab reloaded the goals
    lines[i] = U.clampText(input.value, PL.GOAL_LIMITS.chars);
    saveGoals();
  });
  input.addEventListener('keydown', (e) => {
    const lines = S.data.goals[kind].lines;
    if (isPlainEnter(e)) {
      e.preventDefault();
      if (lines.length >= PL.GOAL_LIMITS.lines) { toast('目標は' + PL.GOAL_LIMITS.lines + '行までです'); return; }
      lines.splice(i + 1, 0, '');
      saveGoals();
      renderGoals(true);
      focusGoal(i + 1);
    } else if (e.key === 'Backspace' && input.value === '' && lines.length > 0) {
      e.preventDefault();
      lines.splice(i, 1);
      saveGoals();
      renderGoals(true);
      focusGoal(Math.max(0, i - 1));
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      // Empty lines are dropped once you leave the goals card.
      if (C.goals.contains(document.activeElement)) return;
      const lines = S.data.goals[kind].lines;
      const kept = lines.filter((s) => s.trim() !== '');
      if (kept.length !== lines.length) S.data.goals[kind].lines = kept;
      saveGoals.flush();
      save(['goals']);
      renderGoals(true);
      if (S.layout === 'mobile') renderWeekGoals();
    }, 0);
  });
  return h('li', { class: 'goal-row' }, h('span', { class: 'bullet', 'aria-hidden': 'true' }, '・'), input);
}

function renderWeekGoals() {
  const lines = S.data.goals.week.lines.filter((s) => s.trim());
  fill(C.weekGoals, 
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '今週の目標'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.ui.goalSeg = 'week'; saveUi(); renderGoals(true); setTab('goals'); } }, '書く', icon('chevron-right'))),
    lines.length
      ? h('ul', { class: 'card plain-lines' }, lines.map((s) => h('li', {}, h('span', { class: 'bullet' }, '・'), h('span', {}, s))))
      : h('p', { class: 'empty small' }, '今週の目標はまだありません'));
}

// ---- mobile "today"

function renderTodayTasks() {
  const list = S.data.tasks.filter((t) => T.inSmart('today', t, S.today) || (S.recentlyDone.has(t.id) && t.due === S.today)).sort(T.byOrder);
  const overdue = T.smartCounts(S.data.tasks, S.today).overdue;
  fill(C.todayTasks, 
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '今日やること'),
      overdue ? h('button', { type: 'button', class: 'link-btn red', onclick: () => { S.ui.smart = 'overdue'; saveUi(); setTab('tasks'); renderTiles(); renderList(); } }, '期限切れ ' + overdue + '件', icon('chevron-right')) : null),
    list.length
      ? h('ul', { class: 'card list' }, list.map((t) => taskRow(t, { draggable: false })))
      : h('p', { class: 'empty small' }, '今日が期日のタスクはありません'));
}

// ---- dragon

function renderDragonWidget() {
  const d = S.data.dragon;
  const p = D.progress(d.total);
  const barFill = h('span', { class: 'bar-fill' });
  setBar(barFill, p.ratio);
  fill(C.dragonWidget, 
    h('span', { class: 'dragon-avatar' }, dragonSvg(p.stage)),
    h('span', { class: 'dragon-info' },
      h('span', { class: 'dragon-name' }, d.name + '　Lv.' + p.level),
      h('span', { class: 'dragon-stage' }, p.next ? p.name + '・あと' + p.remaining.toLocaleString() + 'で' + p.next : p.name + '・最終形態'),
      h('span', { class: 'bar' }, barFill)));
}

function renderDragonFull(box) {
  const d = S.data.dragon;
  const p = D.progress(d.total);
  const barFill = h('span', { class: 'bar-fill' });
  setBar(barFill, p.ratio);
  const stages = h('ol', { class: 'stages' }, D.STAGES.map((s, i) => h('li', { class: 'stage' + (i === p.stage ? ' cur' : '') + (i > p.stage ? ' future' : '') },
    dragonSvg(i, 'stage-svg'), h('span', { class: 'stage-name' }, s.name), h('span', { class: 'stage-min' }, s.min.toLocaleString() + '〜'))));
  const recent = d.log.slice(-8).reverse();
  fill(box, 
    h('div', { class: 'card dragon-hero' },
      h('div', { class: 'dragon-big' }, dragonSvg(p.stage)),
      h('div', { class: 'dragon-hero-text' },
        h('div', { class: 'dragon-title' }, d.name, h('button', { type: 'button', class: 'tool-btn small', 'aria-label': '名前を変える', onclick: renameDragon }, icon('pencil'))),
        h('div', { class: 'dragon-sub' }, p.name + '　Lv.' + p.level + '　経験値 ' + d.total.toLocaleString()),
        h('span', { class: 'bar big' }, barFill),
        h('div', { class: 'dragon-sub' }, p.next ? 'あと ' + p.remaining.toLocaleString() + ' で' + p.next : '最終形態です'))),
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '育ち方')),
    stages,
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '経験値の内わけ')),
    h('ul', { class: 'card kv' },
      [['A 考える', d.xp.A], ['B 調べればできる', d.xp.B], ['C 作業', d.xp.C], ['追加・確認ルートなど', d.xp.other]].map(([k, v]) => h('li', {}, h('span', {}, k), h('span', { class: 'kv-v' }, v.toLocaleString())))),
    h('p', { class: 'sub-note' }, '追加 +1（1日10回まで）／C完了 +5／B完了 +10／A完了 +20／期日までに完了 +3／確認ルートの段を初めて済にする +2。完了を取り消すと、そのとき入った分が減ります。期限切れでは減りません。'),
    recent.length ? h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '最近の経験値')) : null,
    recent.length ? h('ul', { class: 'card kv' }, recent.map((e) => h('li', {}, h('span', {}, e.reason + '　' + U.fmtDateTime(e.at)), h('span', { class: 'kv-v ' + (e.delta >= 0 ? 'plus' : 'minus') }, (e.delta >= 0 ? '+' : '') + e.delta)))) : null);
}

function openDragonSheet() {
  const box = h('div', { class: 'dragon-full' });
  renderDragonFull(box);
  openSheet({ title: '竜', content: box, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

async function renameDragon() {
  const input = h('input', { type: 'text', class: 'field', value: S.data.dragon.name, maxlength: '20', 'aria-label': '竜の名前' });
  const sheet = openSheet({
    title: '竜の名前',
    className: 'sheet-small',
    content: h('div', { class: 'card pad' }, input),
    onDone: () => {
      const v = input.value.trim();
      if (!v) { toast('名前を入れてください'); return false; }
      S.data.dragon.name = U.clampText(v, 20);
      save(['dragon']);
      renderAll();
      return true;
    },
  });
  input.addEventListener('keydown', (e) => { if (isPlainEnter(e)) { e.preventDefault(); sheet.done(); } });
  input.focus();
}

function evolveText(stage) {
  return S.data.dragon.name + 'が' + D.STAGES[stage].name + 'に進化しました';
}

function hop() {
  for (const el of document.querySelectorAll('.dragon-avatar, .dragon-big')) {
    el.classList.remove('hop');
    void el.offsetWidth;
    el.classList.add('hop');
  }
}

// ---- memo pad

function buildMemo() {
  C.memoUl = h('ul', { class: 'card lines memo-lines', 'aria-label': 'メモ' });
  C.memoInput = h('input', {
    type: 'text',
    class: 'line-input',
    placeholder: '書いてEnter',
    'aria-label': 'メモを書く',
    maxlength: String(ST.MEMO_TEXT_MAX),
    enterkeyhint: 'done',
    autocomplete: 'off',
  });
  C.memoInput.addEventListener('keydown', (e) => {
    if (!isPlainEnter(e)) return;
    e.preventDefault();
    addMemo(C.memoInput.value);
  });
  C.memoInput.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text && /[\r\n]/.test(text.trim())) {
      e.preventDefault();
      P.pastedLines(withTyped(C.memoInput, text)).forEach((l) => addMemo(l, true));
      save(['memos']);
      renderMemo();
    }
  });
  C.memoHead = h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'メモ'), h('span', { class: 'group-hint' }, '→ でタスクにする'));
  C.memo = h('section', { class: 'memo', 'aria-label': 'メモ' }, C.memoHead, C.memoUl, h('div', { class: 'card add-card' }, C.memoInput));
}

function addMemo(text, batch) {
  const v = U.clampText(String(text).trim(), ST.MEMO_TEXT_MAX);
  if (!v) return;
  S.data.memos.push({ id: U.uid(), text: v, createdAt: nowIso(), taskId: null, deletedAt: null });
  if (!batch) {
    C.memoInput.value = '';
    save(['memos']);
    renderMemo();
  } else {
    C.memoInput.value = '';
  }
}

function renderMemo(fromAll) {
  if (fromAll && isEditingIn(C.memoUl)) return;
  const memos = S.data.memos.filter((m) => !m.deletedAt);
  fill(C.memoUl, ...memos.map((m) => memoLine(m)));
  C.memoUl.hidden = memos.length === 0;
}

function memoLine(m) {
  const li = h('li', { class: 'line' + (m.taskId ? ' used' : ''), dataset: { id: m.id } });
  const body = h('button', { type: 'button', class: 'line-body', 'aria-label': m.text + '（押すと書き直せます）', onclick: () => editLineInline(li, m.text, (v) => {
    const memo = S.data.memos.find((x) => x.id === m.id);
    if (!memo || !v.trim()) { renderMemo(); return; }
    memo.text = U.clampText(v.trim(), ST.MEMO_TEXT_MAX);
    save(['memos']);
    renderMemo();
  }, () => renderMemo()) }, h('span', { class: 'line-text' }, m.text));
  const to = h('button', { type: 'button', class: 'line-to', 'aria-label': 'タスクにする: ' + m.text, title: 'タスクにする', onclick: () => memoToTask(m) }, icon('arrow-right'));
  const del = h('button', { type: 'button', class: 'line-del', 'aria-label': 'メモを消す: ' + m.text, onclick: () => {
    const memo = S.data.memos.find((x) => x.id === m.id);
    if (!memo) return;
    memo.deletedAt = nowIso();
    save(['memos']);
    renderMemo();
    toast('メモをゴミ箱に移しました', { actionLabel: '元に戻す', onAction: () => { memo.deletedAt = null; save(['memos']); renderMemo(); }, duration: 5000 });
  } }, icon('x'));
  li.append(body, to, del);
  return li;
}

function memoToTask(m) {
  if (S.layout === 'mobile') openAddSheet(m.text, m.id);
  else C.quick.setText(m.text, m.id);
}

// ---- later box (drop zone on PC / tablet)

function buildBox() {
  C.boxZone = h('div', { class: 'dropzone', 'aria-label': 'あとで箱（ここへドラッグでしまう）' });
  C.boxInfo = h('div', { class: 'dropzone-info' });
  C.boxHead = h('div', { class: 'group-head' });
  C.box = h('section', { class: 'box', 'aria-label': 'あとで箱' }, C.boxHead, h('div', { class: 'dropzone-wrap' }, C.boxZone, C.boxInfo));
}

function renderBox() {
  const parked = S.data.tasks.filter((t) => T.inSmart('parked', t, S.today));
  const dated = parked.filter((t) => t.returnOn).sort((a, b) => a.returnOn.localeCompare(b.returnOn));
  fill(C.boxHead, 
    h('span', { class: 'group-label' }, 'あとで箱'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => selectSmart('parked') }, '開く', icon('chevron-right')));
  fill(C.boxZone);
  fill(C.boxInfo, 
    icon('archive', 'dz-icon'),
    h('span', { class: 'dz-count' }, parked.length + '件'),
    h('span', { class: 'dz-hint' }, 'ここへドラッグ'),
    dated.length ? h('span', { class: 'dz-next' }, U.fmtMD(dated[0].returnOn, thisYear()) + ' に戻る分があります') : null);
}

// ---------------------------------------------------------------- quick add

function createQuickAdd({ onAdded }) {
  let removed = new Set();
  let suggestion = 'off'; // off | applied | dismissed
  let memoId = null;
  let parsed = null;

  const input = h('input', {
    type: 'text',
    class: 'qa-input',
    placeholder: '新しいタスク　例）研修資料の改訂 木曜 B 3日 教育部に確認',
    'aria-label': '新しいタスク（1行で書いてEnter）',
    maxlength: '400',
    enterkeyhint: 'done',
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  const chips = h('div', { class: 'qa-chips', 'aria-live': 'polite' });
  const err = h('div', { class: 'qa-error', role: 'alert' });
  const bulk = h('button', { type: 'button', class: 'qa-bulk', 'aria-label': 'まとめて追加（複数行を貼り付け）', title: 'まとめて追加', onclick: () => openBulkSheet(input.value) }, icon('clipboard-text'));
  const field = h('div', { class: 'qa-field' }, icon('plus', 'qa-plus'), input, bulk);
  const el = h('div', { class: 'quickadd' }, field, chips, err);

  function signatures(tokens) {
    const seen = new Map();
    return tokens.map((t) => {
      const n = (seen.get(t.raw) || 0) + 1;
      seen.set(t.raw, n);
      return t.raw + '#' + n;
    });
  }

  function reparse() {
    const text = input.value;
    if (!text.trim()) {
      parsed = null;
      fill(chips);
      return;
    }
    const opts = { today: S.today, people: activePeople() };
    const tokens = P.tokenize(text, opts);
    const sig = signatures(tokens);
    tokens.forEach((t, i) => { if (removed.has(sig[i]) && t.type !== 'title') tokens[i] = { raw: t.raw, type: 'title', value: null }; });
    parsed = P.summarize(tokens, S.today);
    const boss = T.bossFor(S.data.people);
    if (suggestion === 'applied' && boss && parsed.rank === 'A' && !parsed.steps.length) {
      parsed = P.withSuggestedStep(parsed, { kind: 'confirm', whoId: boss.id, note: '方向性確認' }, S.today);
    }
    renderChips(boss);
  }

  function chip(label, cls, onRemove, extra) {
    return h('span', { class: 'chip ' + (cls || '') },
      extra || null,
      h('span', {}, label),
      onRemove ? h('button', { type: 'button', class: 'chip-x', 'aria-label': label + ' を外してタスク名に戻す', onclick: onRemove }, icon('x')) : null);
  }

  function removeToken(i) {
    const t = parsed.tokens[i];
    if (t.synthetic) {
      suggestion = 'dismissed';
    } else {
      const sig = signatures(parsed.tokens.filter((x) => !x.synthetic));
      const idx = parsed.tokens.filter((x) => !x.synthetic).indexOf(t);
      removed.add(sig[idx]);
    }
    reparse();
    input.focus();
  }

  function renderChips(boss) {
    const out = [];
    const people = peopleMap();
    out.push(chip(parsed.title ? 'タスク名「' + parsed.title + '」' : 'タスク名がありません', parsed.title ? 'c-title' : 'c-error'));
    let stepNo = 0;
    parsed.tokens.forEach((t, i) => {
      const rm = () => removeToken(i);
      if (t.type === 'due') out.push(chip('期日 ' + U.fmtMD(t.value, thisYear()), 'c-due', rm, icon('calendar')));
      else if (t.type === 'rank') out.push(chip(T.RANK_LABEL[t.value], 'c-rank r-' + t.value, rm));
      else if (t.type === 'duration') out.push(chip('所要' + T.DURATION_LABEL[t.value], 'c-dur', rm));
      else if (t.type === 'star') out.push(chip('★ 重要', 'c-star', rm));
      else if (t.type === 'step') {
        stepNo += 1;
        const p = people.get(t.value.whoId);
        out.push(chip(circled(stepNo) + (p ? p.name : '?') + '（' + T.KIND_LABEL[t.value.kind] + '）' + (t.value.note ? ' ' + t.value.note : ''), 'c-step', rm, avatar(p, 'xs')));
      }
    });
    if (boss && parsed.rank === 'A' && !parsed.steps.length && suggestion === 'off') {
      out.push(h('button', {
        type: 'button',
        class: 'chip c-suggest',
        onclick: () => { suggestion = 'applied'; reparse(); input.focus(); },
      }, icon('plus'), '提案: ①確認・' + boss.name + '（方向性確認）'));
    }
    fill(chips, ...out);
  }

  function submit() {
    reparse();
    err.textContent = '';
    if (!parsed) { err.textContent = 'タスク名を入れてください'; return; }
    const e = P.lineError(parsed);
    if (e) { err.textContent = e; return; }
    const id = addTask(parsed, memoId);
    input.value = '';
    removed = new Set();
    suggestion = 'off';
    memoId = null;
    reparse();
    if (onAdded) onAdded(id);
  }

  input.addEventListener('input', () => {
    err.textContent = '';
    if (!input.value.trim()) { removed = new Set(); suggestion = 'off'; memoId = null; }
    reparse();
  });
  input.addEventListener('keydown', (e) => {
    if (isPlainEnter(e)) { e.preventDefault(); submit(); }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text && P.pastedLines(text).length > 1) {
      e.preventDefault();
      openBulkSheet(text);
    }
  });

  return {
    el,
    input,
    /** Adds the line. Returns true when a task was added. */
    submit() {
      const before = input.value;
      submit();
      return before.trim() !== '' && input.value === '';
    },
    refresh() { if (input.value.trim()) reparse(); },
    setText(text, fromMemo) {
      input.value = text;
      memoId = fromMemo || null;
      removed = new Set();
      suggestion = 'off';
      err.textContent = '';
      reparse();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
}

function addTask(p, memoId) {
  const at = nowIso();
  const t = T.newTask({ title: p.title, due: p.due, rank: p.rank, duration: p.duration, star: p.star, steps: p.steps }, at, T.nextOrder(S.data.tasks));
  S.data.tasks.push(t);
  const g = D.grantAdd(S.data.dragon, S.today, at);
  const keys = ['tasks', 'dragon'];
  if (memoId) {
    const m = S.data.memos.find((x) => x.id === memoId);
    if (m) { m.taskId = t.id; keys.push('memos'); }
  }
  save(keys);
  S.highlight = t.id;
  renderAll();
  const evo = g.evolvedTo >= 0 ? '　' + evolveText(g.evolvedTo) : '';
  const visible = T.inSmart(S.ui.smart, t, S.today) && T.matchFilters(S.filters, t, S.today);
  toast('追加しました' + (g.applied ? '（竜 +1）' : '') + evo, visible || S.layout === 'mobile' ? undefined : {
    actionLabel: '見る',
    onAction: () => { S.ui.smart = 'all'; S.filters = T.emptyFilters(); S.highlight = t.id; saveUi(); renderTiles(); renderList(); },
    duration: 5000,
  });
  if (g.evolvedTo >= 0) hop();
  return t.id;
}

function openAddSheet(text, memoId) {
  const qa = createQuickAdd({ onAdded: () => { /* keep the sheet open for the next one */ } });
  const sheet = openSheet({
    title: '新しいタスク',
    className: 'sheet-add',
    content: [qa.el, h('p', { class: 'sub-note' }, '例）研修資料の改訂 木曜 B 3日 教育部に確認 → タスク名・期日・ランク・所要期間・確認ルートに分けて入ります。続けて何件でも追加できます。')],
    cancelLabel: '閉じる',
    onDone: () => (qa.input.value.trim() ? qa.submit() : true),
    doneLabel: '追加',
  });
  if (text) qa.setText(text, memoId);
  qa.input.focus();
  return sheet;
}

function openBulkSheet(initial) {
  const ta = h('textarea', { class: 'bulk-text', rows: '6', placeholder: '1行に1件。行頭の「- 」「・」「□」「1.」は外します', 'aria-label': 'まとめて追加するタスク' });
  ta.value = initial || '';
  const info = h('p', { class: 'sub-note' });
  const listEl = h('ul', { class: 'card bulk-list' });
  let rows = [];
  const peopleById = peopleMap();
  function summary(p) {
    const parts = [];
    if (p.due) parts.push(U.fmtMD(p.due, thisYear()));
    if (p.rank) parts.push(T.RANK_LABEL[p.rank]);
    if (p.duration) parts.push('所要' + T.DURATION_LABEL[p.duration]);
    if (p.star) parts.push('★重要');
    p.steps.forEach((s, i) => { const who = peopleById.get(s.whoId); parts.push(circled(i + 1) + (who ? who.name : '?') + '（' + T.KIND_LABEL[s.kind] + '）'); });
    return parts.join('・');
  }
  function refresh() {
    rows = P.parseBulk(ta.value, { today: S.today, people: activePeople() }).map((r) => Object.assign(r, { checked: !r.error }));
    fill(listEl, ...rows.map((r) => h('li', { class: 'bulk-row' + (r.error ? ' bad' : '') },
      h('input', {
        type: 'checkbox',
        checked: r.checked,
        disabled: Boolean(r.error),
        'aria-label': r.line,
        onchange: (e) => { r.checked = e.target.checked; updateInfo(); },
      }),
      h('div', { class: 'bulk-main' },
        h('div', { class: 'bulk-title' }, r.parsed.title || '（タスク名なし）'),
        summary(r.parsed) ? h('div', { class: 'bulk-meta' }, summary(r.parsed)) : null,
        r.error ? h('div', { class: 'qa-error' }, r.error) : null))));
    listEl.hidden = rows.length === 0;
    updateInfo();
  }
  function updateInfo() {
    const n = rows.filter((r) => r.checked && !r.error).length;
    info.textContent = rows.length ? rows.length + '行を読み取りました。追加するのは ' + n + '件です（チェックを外すと追加しません）。' : '複数行を貼り付けると、1行ずつ解釈します。空の行は数えません。';
  }
  const refreshSoon = debounce(refresh, 150);
  ta.addEventListener('input', refreshSoon);
  openSheet({
    title: 'まとめて追加',
    doneLabel: '追加',
    content: [h('div', { class: 'card pad' }, ta), info, listEl],
    onDone: () => {
      refreshSoon.flush(); // only re-reads the text when it was just edited (keeps unchecked rows unchecked)
      const sel = rows.filter((r) => r.checked && !r.error);
      if (!sel.length) { toast('追加するタスクがありません'); return false; }
      addMany(sel.map((r) => r.parsed));
      return true;
    },
  });
  refresh();
  ta.focus();
}

function addMany(list) {
  const at = nowIso();
  let xp = 0;
  let evolved = -1;
  for (const p of list) {
    const t = T.newTask({ title: p.title, due: p.due, rank: p.rank, duration: p.duration, star: p.star, steps: p.steps }, at, T.nextOrder(S.data.tasks));
    S.data.tasks.push(t);
    const g = D.grantAdd(S.data.dragon, S.today, at);
    xp += g.applied;
    if (g.evolvedTo >= 0) evolved = g.evolvedTo;
  }
  save(['tasks', 'dragon']);
  renderAll();
  toast(list.length + '件追加しました' + (xp ? '（竜 +' + xp + '）' : '') + (evolved >= 0 ? '　' + evolveText(evolved) : ''));
}

// ---------------------------------------------------------------- complete / undo / park

function toggleDone(id) {
  const t = findTask(id);
  if (!t) return;
  if (t.status === 'done') {
    undoComplete(id);
    return;
  }
  const r = T.completeTask(t, S.data.dragon, S.today, nowIso());
  if (!r) return;
  clearTimeout(S.recentlyDone.get(id));
  S.recentlyDone.set(id, setTimeout(() => {
    S.recentlyDone.delete(id);
    renderList();
    if (S.layout === 'mobile') renderTodayTasks();
  }, 1500));
  save(['tasks', 'dragon']);
  renderAll();
  toast('完了しました（竜 +' + r.amount + '）' + (r.evolvedTo >= 0 ? '　' + evolveText(r.evolvedTo) : ''), {
    actionLabel: '元に戻す',
    onAction: () => undoComplete(id),
    duration: 5000,
  });
  if (r.evolvedTo >= 0) hop();
}

function undoComplete(id) {
  const t = findTask(id);
  if (!t || t.status !== 'done') return;
  clearTimeout(S.recentlyDone.get(id));
  S.recentlyDone.delete(id);
  const r = T.uncompleteTask(t, S.data.dragon, nowIso());
  save(['tasks', 'dragon']);
  renderAll();
  toast('元に戻しました' + (r.amount ? '（竜 ' + r.amount + '）' : ''));
}

/** Ask for the return date. Resolves with null (none), 'YYYY-MM-DD', or undefined (cancelled). */
function pickReturnDate() {
  return new Promise((resolve) => {
    let result;
    const choices = T.returnChoices(S.today);
    const date = h('input', { type: 'date', class: 'field', min: U.addDays(S.today, 1), 'aria-label': '戻す日を指定' });
    const rows = choices.map((c) => h('li', {}, h('button', {
      type: 'button',
      class: 'menu-row',
      onclick: () => { result = { v: c.date }; sheet.close(); },
    }, h('span', { class: 'menu-label' }, c.label), h('span', { class: 'menu-count' }, c.date ? U.fmtMD(c.date, thisYear()) : '自分で戻す'))));
    rows.push(h('li', { class: 'menu-date' }, h('span', { class: 'menu-label' }, '日付を指定'), date, h('button', {
      type: 'button',
      class: 'btn small primary',
      onclick: () => {
        if (!U.isYmd(date.value)) { toast('日付を選んでください'); return; }
        result = { v: date.value };
        sheet.close();
      },
    }, '決定')));
    const sheet = openSheet({
      title: '戻す日',
      className: 'sheet-small',
      content: [h('p', { class: 'sheet-note' }, 'その日になったら一覧の先頭に戻ります。'), h('ul', { class: 'card menu' }, rows)],
      onClose: () => resolve(result ? result.v : undefined),
    });
  });
}

async function askPark(id) {
  const t = findTask(id);
  if (!t || !T.isLive(t)) { renderList(); renderBox(); return; }
  const when = await pickReturnDate();
  if (when === undefined) { renderList(); renderBox(); return; }
  parkNow(id, when);
}

function parkNow(id, when) {
  const t = findTask(id);
  if (!t) return;
  const before = { parked: t.parked, returnOn: t.returnOn, returnedMark: t.returnedMark };
  T.parkTask(t, when, nowIso());
  save(['tasks']);
  renderAll();
  toast('あとで箱にしまいました' + (when ? '（' + U.fmtMD(when, thisYear()) + 'に戻ります）' : ''), {
    actionLabel: '元に戻す',
    onAction: () => { Object.assign(t, before); save(['tasks']); renderAll(); },
    duration: 5000,
  });
}

function unparkNow(id) {
  const t = findTask(id);
  if (!t) return;
  T.unparkTask(t, S.data.tasks, false, nowIso());
  save(['tasks']);
  renderAll();
  toast('一覧の先頭に戻しました');
}

// ---------------------------------------------------------------- filter menu

function openFilterMenu() {
  const body = h('div', { class: 'filter-menu' });
  const base = S.data.tasks.filter((t) => T.inSmart(S.ui.smart, t, S.today));
  const render = () => {
    fill(body, ...T.FILTER_GROUPS.map((g) => h('section', { class: 'menu-group' },
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, g.label)),
      h('ul', { class: 'card menu' }, g.items.map((it) => {
        const on = it.key === 'cOption' ? S.filters.cOption : S.filters[it.key] === it.value;
        const n = base.filter((t) => T.optionMatch(it.key, it.value, t, S.today)).length;
        return h('li', {}, h('button', {
          type: 'button',
          class: 'menu-row',
          'aria-pressed': String(on),
          dataset: { fkey: it.key, fvalue: String(it.value) },
          onclick: () => {
            if (it.key === 'cOption') S.filters.cOption = !S.filters.cOption;
            else S.filters[it.key] = on ? null : it.value;
            render();
            renderList();
          },
        }, h('span', { class: 'menu-check' }, on ? icon('check') : null), h('span', { class: 'menu-label' }, it.label), h('span', { class: 'menu-count' }, String(n))));
      })))),
    h('button', { type: 'button', class: 'btn wide', onclick: () => { S.filters = T.emptyFilters(); render(); renderList(); } }, '条件をすべて外す'));
  };
  render();
  openSheet({ title: '絞り込み（' + T.SMART_LISTS.find((s) => s.key === S.ui.smart).label + '）', content: body, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

// ---------------------------------------------------------------- task detail

function openDetail(id) {
  const orig = findTask(id);
  if (!orig) return;
  if (orig.returnedMark) {
    orig.returnedMark = false;
    save(['tasks']);
    renderList();
  }
  const w = structuredClone(orig);
  const openedVersion = orig.updatedAt;
  let overwriteOk = false;
  let statusBeforeDone = w.status === 'done' ? (w.prevStatus || 'todo') : w.status;
  let dirty = false;
  const touch = () => { dirty = true; };
  const body = h('div', { class: 'detail' });
  const people = () => peopleMap();

  const sheet = openSheet({
    title: '詳細',
    content: body,
    className: 'sheet-detail',
    onDone: () => {
      const cur = findTask(id);
      if (cur && cur.updatedAt !== openedVersion && !overwriteOk) {
        confirmDialog({
          title: '別の画面で変更されています',
          message: 'このタスクは、詳細を開いたあとに別のタブなどで変更されました。この画面の内容で上書きしますか？',
          okLabel: '上書きする',
          cancelLabel: 'やめる',
          destructive: true,
        }).then((ok) => { if (ok) { overwriteOk = true; sheet.done(); } });
        return false;
      }
      return commitDetail(id, w, statusBeforeDone);
    },
    onCancel: () => {
      if (!dirty) return true;
      confirmDialog({ title: '変更を破棄しますか？', message: 'この画面で変えた内容は保存されません。', okLabel: '破棄する', cancelLabel: '編集を続ける', destructive: true })
        .then((ok) => { if (ok) sheet.close(); });
      return false;
    },
  });

  function row(label, value, onclick, extra) {
    return h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, label),
      onclick ? h('button', { type: 'button', class: 'f-value', onclick }, value, icon('chevron-right')) : value, extra || null);
  }

  function toggle(label, on, onChange, hint) {
    return h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, label, hint ? h('span', { class: 'f-hint' }, hint) : null),
      h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick: () => onChange(!on) }, h('span', { class: 'knob' })));
  }

  function cardMain() {
    const title = h('textarea', { class: 'f-title', rows: '2', maxlength: String(T.TITLE_MAX), 'aria-label': 'タスク名', placeholder: 'タスク名' });
    title.value = w.title;
    title.addEventListener('input', () => { w.title = title.value.replace(/[\r\n]+/g, ' '); touch(); });
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });
    const memo = h('textarea', { class: 'f-memo', rows: '3', maxlength: String(T.MEMO_MAX), placeholder: 'メモ', 'aria-label': 'メモ' });
    memo.value = w.memo;
    const count = h('span', { class: 'f-count' }, U.textLength(w.memo) + ' / ' + T.MEMO_MAX);
    memo.addEventListener('input', () => { w.memo = memo.value; touch(); count.textContent = U.textLength(memo.value) + ' / ' + T.MEMO_MAX; });
    const items = [h('li', { class: 'form-block' }, title)];
    if (w.rank === 'A') {
      const next = h('input', { type: 'text', class: 'f-input', value: w.nextAction, maxlength: String(T.NEXT_MAX), placeholder: '最初の一歩を1行で（例: 叩き台を3行で書く）', 'aria-label': '次の一手' });
      next.addEventListener('input', () => { w.nextAction = next.value; touch(); });
      items.push(h('li', { class: 'form-row stack' }, h('span', { class: 'f-label' }, '次の一手', h('span', { class: 'f-hint' }, 'A のとき')), next));
    }
    items.push(h('li', { class: 'form-block' }, memo, count));
    return h('ul', { class: 'card form' }, items);
  }

  function cardProps() {
    const due = h('input', { type: 'date', class: 'f-date', value: w.due || '', 'aria-label': '期日' });
    due.addEventListener('change', () => { w.due = U.isYmd(due.value) ? due.value : null; touch(); render(); });
    const dueInfo = T.dueInfo(w.due, S.today);
    const dueCell = h('span', { class: 'f-due' }, due,
      dueInfo ? h('span', { class: 'm-' + dueInfo.tone }, dueInfo.text) : null,
      w.due ? h('button', { type: 'button', class: 'mini-btn', onclick: () => { w.due = null; touch(); render(); } }, 'なし') : null);
    const items = [
      row('期日', dueCell),
      row('所要期間', w.duration ? T.DURATION_LABEL[w.duration] : '未設定', async () => {
        const v = await pickFrom({ title: '所要期間', current: w.duration, note: '印を付けて絞り込みに使うだけです（期日からの逆算はしません）。', options: [{ value: null, label: '未設定' }].concat(T.DURATIONS.map((d) => ({ value: d, label: T.DURATION_LABEL[d] }))) });
        if (v === undefined) return;
        w.duration = v; touch(); render();
      }),
      row('ランク', w.rank ? h('span', { class: 'rank-label r-' + w.rank }, T.RANK_LABEL[w.rank]) : '未設定', async () => {
        const v = await pickFrom({ title: 'ランク', current: w.rank, options: [{ value: null, label: '未設定' }].concat(T.RANKS.map((r) => ({ value: r, label: T.RANK_LABEL[r] }))) });
        if (v === undefined) return;
        w.rank = v; touch(); render();
      }),
      toggle('重要★', w.star, (v) => { w.star = v; touch(); render(); }),
      row('状態', h('span', { class: 'status-label st-' + w.status }, T.STATUS_LABEL[w.status]), async () => {
        const v = await pickFrom({ title: '状態', current: w.status, note: '確認ルートの段を「待ち」にすると停止中、待ちがなくなると進行中に自動で変わります。', options: T.STATUSES.map((s) => ({ value: s, label: T.STATUS_LABEL[s] })) });
        if (v === undefined || v === w.status) return;
        if (v === 'done') statusBeforeDone = w.status;
        w.status = v; touch(); render();
      }),
    ];
    if (w.rank === 'C') {
      items.push(toggle('振れる？自動化できる？', w.cOption, (v) => { w.cOption = v; touch(); render(); }, '人に振る・自動化の候補の印'));
    }
    return h('ul', { class: 'card form' }, items);
  }

  function cardRoute() {
    const now = T.routeNow(w, people(), S.today);
    const head = h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '確認ルート'),
      now ? h('span', { class: 'route-now ' + (now.type === 'wait' ? 'm-orange' : now.type === 'done' ? 'm-green' : 'm-blue') },
        now.type === 'wait' ? 'いま: ' + now.who + 'の返事待ち（' + now.days + '日）' : now.type === 'done' ? '全部済' : now.text) : null);
    const ul = h('ul', { class: 'card route' });
    w.route.forEach((s, i) => ul.append(stepRow(s, i)));
    if (w.route.length < T.ROUTE_MAX) {
      ul.append(h('li', { class: 'route-add' }, h('button', { type: 'button', class: 'link-btn', onclick: addStepFlow }, icon('plus'), '段を足す', h('span', { class: 'f-hint' }, '（最大' + T.ROUTE_MAX + '段）'))));
    }
    const boss = T.bossFor(S.data.people);
    const suggest = w.rank === 'A' && w.route.length === 0 && boss
      ? h('div', { class: 'suggest' }, icon('brain'), h('span', { class: 'suggest-text' }, 'A は早めに方向性を確認: ①確認・' + boss.name + '（方向性確認）'),
        h('button', { type: 'button', class: 'btn small primary', onclick: () => { T.addStep(w, 'confirm', boss.id, '方向性確認'); touch(); render(); } }, '入れる'))
      : null;
    return [head, suggest, ul];
  }

  function stepRow(s, i) {
    const p = people().get(s.whoId);
    const seg = h('div', { class: 'seg small', role: 'group', 'aria-label': circled(i + 1) + 'の状態' }, T.STEP_STATES.map((st) => h('button', {
      type: 'button',
      class: 'seg-btn' + (s.state === st ? ' on st-' + st : ''),
      'aria-pressed': String(s.state === st),
      onclick: () => {
        if (!T.setStepState(w, s.id, st, S.today)) return;
        touch();
        render();
        if (T.allStepsDone(w) && w.status !== 'done') askComplete();
      },
    }, T.STEP_STATE_LABEL[st])));
    const note = h('input', { type: 'text', class: 'step-note', value: s.note, maxlength: String(T.NOTE_MAX), placeholder: '一言メモ', 'aria-label': circled(i + 1) + 'の一言メモ' });
    note.addEventListener('input', () => { s.note = note.value; touch(); });
    return h('li', { class: 'step s-' + s.state, dataset: { step: s.id } },
      h('span', { class: 'step-dot', 'aria-hidden': 'true' }, s.state === 'done' ? icon('check') : null),
      h('span', { class: 'step-no' }, circled(i + 1)),
      h('button', { type: 'button', class: 'step-who', 'aria-label': circled(i + 1) + ' ' + T.KIND_LABEL[s.kind] + '・' + (p ? p.name : '削除した相手') + '（押すと変更）', onclick: () => editStepFlow(i) },
        avatar(p, 'xs'), h('span', {}, T.KIND_LABEL[s.kind] + '・' + (p ? p.name : '（削除した相手）'))),
      seg,
      note,
      h('button', { type: 'button', class: 'step-del', 'aria-label': circled(i + 1) + 'の段を消す', onclick: () => { T.removeStep(w, s.id); touch(); render(); } }, icon('x')));
  }

  async function addStepFlow() {
    const r = await pickPerson({ title: '段を足す', kind: 'confirm' });
    if (!r) return;
    T.addStep(w, r.kind, r.whoId, '');
    touch();
    render();
  }

  async function editStepFlow(i) {
    const s = w.route[i];
    const r = await pickPerson({ title: circled(i + 1) + 'を変える', kind: s.kind, whoId: s.whoId });
    if (!r) return;
    s.kind = r.kind;
    s.whoId = r.whoId;
    touch();
    render();
  }

  async function askComplete() {
    const ok = await confirmDialog({ title: '完了にしますか？', message: '確認ルートが全部「済」になりました。', okLabel: '完了にする', cancelLabel: 'あとで' });
    if (!ok) return;
    statusBeforeDone = w.status;
    w.status = 'done';
    sheet.done();
  }

  function cardLinks() {
    const defs = [['slack', 'Slack', 'brand-slack'], ['doc', '資料', 'file-text'], ['web', 'Webサイト', 'world']];
    return h('ul', { class: 'card form' }, defs.map(([k, label, ic]) => {
      const input = h('input', { type: 'url', class: 'f-input', value: w.links[k], placeholder: 'https://', 'aria-label': label + 'のURL', maxlength: String(U.URL_MAX), inputmode: 'url', autocapitalize: 'off', spellcheck: 'false' });
      const open = h('span', { class: 'link-open-slot' });
      const msg = h('span', { class: 'f-error' });
      const update = () => {
        const u = U.cleanUrl(input.value);
        fill(open, u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', class: 'link-open' }, icon('external-link'), '開く') : '');
        msg.textContent = u === null ? 'http:// か https:// で始まるURLだけ保存できます' : '';
      };
      input.addEventListener('input', () => { w.links[k] = input.value.trim(); touch(); update(); });
      update();
      return h('li', { class: 'form-row link-row' }, h('span', { class: 'f-label' }, icon(ic), label), input, open, msg);
    }));
  }

  function cardActions() {
    return h('ul', { class: 'card form actions' },
      w.status !== 'done' ? h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => { statusBeforeDone = w.status; w.status = 'done'; sheet.done(); } }, icon('check'), 'このタスクを完了にする')) : null,
      !w.parked && w.status !== 'done'
        ? h('li', {}, h('button', { type: 'button', class: 'action', onclick: async () => {
          const when = await pickReturnDate();
          if (when === undefined) return;
          w.parked = true;
          w.returnOn = when;
          w.returnedMark = false;
          touch();
          sheet.done();
          toast('あとで箱にしまいました' + (when ? '（' + U.fmtMD(when, thisYear()) + 'に戻ります）' : ''));
        } }, icon('archive'), 'あとで箱へ'))
        : null,
      w.parked ? h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => {
        w.parked = false;
        w.returnOn = null;
        w.order = T.topOrder(S.data.tasks);
        touch();
        sheet.done();
        toast('一覧の先頭に戻しました');
      } }, icon('arrow-back-up'), 'あとで箱から一覧に戻す')) : null,
      h('li', {}, h('button', { type: 'button', class: 'action danger', onclick: () => {
        sheet.close();
        trashNow(id);
      } }, icon('trash'), '削除（ゴミ箱へ）')));
  }

  function render() {
    fill(body, 
      cardMain(),
      cardProps(),
      ...cardRoute(),
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'リンク')),
      cardLinks(),
      cardActions(),
      h('p', { class: 'sub-note' }, '作成 ' + U.fmtDateTime(w.createdAt) + '　更新 ' + U.fmtDateTime(w.updatedAt)));
  }
  render();
}

/** Save the edited copy. Returns false (and keeps the sheet open) when something is not valid. */
function commitDetail(id, w, statusBeforeDone) {
  const i = S.data.tasks.findIndex((t) => t.id === id);
  if (i < 0) { toast('このタスクは見つかりませんでした（別のタブで消された可能性があります）'); return true; }
  const orig = S.data.tasks[i];
  const title = U.clampText(String(w.title).replace(/[\r\n]+/g, ' ').trim(), T.TITLE_MAX);
  if (!title) { toast('タスク名を入れてください'); return false; }
  for (const k of ['slack', 'doc', 'web']) {
    const u = U.cleanUrl(w.links[k]);
    if (u === null) { toast('リンクは http:// か https:// で始まるものだけ保存できます'); return false; }
    w.links[k] = u;
  }
  w.title = title;
  w.memo = U.clampText(w.memo, T.MEMO_MAX);
  w.nextAction = U.clampText(String(w.nextAction).trim(), T.NEXT_MAX);
  w.route.forEach((s) => { s.note = U.clampText(String(s.note).trim(), T.NOTE_MAX); });
  if (w.rank !== 'C') w.cOption = false;
  const at = nowIso();
  const wantDone = w.status === 'done' && orig.status !== 'done';
  const wantUndone = orig.status === 'done' && w.status !== 'done';
  const finalStatus = w.status;
  const stepXp = T.collectStepXp(w);
  if (wantDone) w.status = statusBeforeDone && statusBeforeDone !== 'done' ? statusBeforeDone : 'doing';
  if (wantUndone) w.status = 'done';
  w.updatedAt = at;
  S.data.tasks[i] = w;
  let msg = '保存しました';
  let evolved = -1;
  if (stepXp) {
    const g = D.grant(S.data.dragon, 'other', stepXp, '確認ルート', at);
    msg += '（竜 +' + g.applied + '）';
    if (g.evolvedTo >= 0) evolved = g.evolvedTo;
  }
  if (wantDone) {
    const r = T.completeTask(w, S.data.dragon, S.today, at);
    save(['tasks', 'dragon']);
    S.recentlyDone.set(id, setTimeout(() => { S.recentlyDone.delete(id); renderList(); if (S.layout === 'mobile') renderTodayTasks(); }, 1500));
    renderAll();
    if (r.evolvedTo >= 0) evolved = r.evolvedTo;
    toast('完了しました（竜 +' + r.amount + (stepXp ? '・確認ルート +' + stepXp : '') + '）' + (evolved >= 0 ? '　' + evolveText(evolved) : ''), { actionLabel: '元に戻す', onAction: () => undoComplete(id), duration: 5000 });
    if (evolved >= 0) hop();
    return true;
  }
  if (wantUndone) {
    T.uncompleteTask(w, S.data.dragon, at);
    w.status = finalStatus;
  }
  save(['tasks', 'dragon']);
  renderAll();
  if (stepXp || wantUndone) toast(msg + (evolved >= 0 ? '　' + evolveText(evolved) : ''));
  if (evolved >= 0) hop();
  return true;
}

function trashNow(id) {
  const t = findTask(id);
  if (!t) return;
  T.trashTask(t, nowIso());
  save(['tasks']);
  renderAll();
  toast('ゴミ箱に移しました', { actionLabel: '元に戻す', onAction: () => { T.restoreTask(t, nowIso()); save(['tasks']); renderAll(); }, duration: 5000 });
}

/** Choose who a route step is for: kind (確認/依頼/返信) + a round icon tile. */
function pickPerson({ title, kind, whoId }) {
  return new Promise((resolve) => {
    let picked;
    let curKind = kind || 'confirm';
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '種類' });
    const renderSeg = () => fill(seg, ...T.KINDS.map((k) => h('button', {
      type: 'button',
      class: 'seg-btn' + (k === curKind ? ' on' : ''),
      'aria-pressed': String(k === curKind),
      onclick: () => { curKind = k; renderSeg(); },
    }, kindIcon(k), T.KIND_LABEL[k])));
    renderSeg();
    const groups = T.GROUPS.map((g) => {
      const ps = activePeople().filter((p) => p.group === g);
      if (!ps.length) return null;
      return [h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, T.GROUP_LABEL[g])),
        h('div', { class: 'people-grid' }, ps.map((p) => h('button', {
          type: 'button',
          class: 'person-tile' + (p.id === whoId ? ' selected' : ''),
          onclick: () => { picked = { kind: curKind, whoId: p.id }; sheet.close(); },
        }, avatar(p, 'lg'), h('span', { class: 'person-name' }, p.name))))];
    });
    const sheet = openSheet({
      title,
      content: [seg, ...groups.flat().filter(Boolean), h('p', { class: 'sub-note' }, '人の名前は 設定 → 相手 で足せます（この端末の中だけに保存）。')],
      onClose: () => resolve(picked),
    });
  });
}

// ---------------------------------------------------------------- records: done log, trash, history

function openDoneLog() {
  const box = h('div');
  let limit = 100;
  const render = () => {
    const done = S.data.tasks.filter((t) => !t.deletedAt && t.status === 'done').sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
    const groups = new Map();
    for (const t of done.slice(0, limit)) {
      const day = t.doneAt ? U.ymd(new Date(t.doneAt)) : '----';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(t);
    }
    const parts = [];
    if (!done.length) parts.push(h('p', { class: 'empty' }, '完了したタスクはまだありません'));
    for (const [day, list] of groups) {
      parts.push(h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, U.isYmd(day) ? U.fmtMD(day, thisYear()) : '日付なし')));
      parts.push(h('ul', { class: 'card list' }, list.map((t) => h('li', { class: 'row is-done' },
        h('button', { type: 'button', class: 'check on', 'aria-label': '未完了に戻す: ' + t.title, onclick: () => { undoComplete(t.id); render(); } }, icon('check')),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, h('span', { class: 'row-title-text' }, t.title)),
          metaLine([{ text: (t.rank ? T.RANK_LABEL[t.rank] + '・' : '') + '竜 +' + (t.xpGiven || 0), tone: 'gray' }]))))));
    }
    if (done.length > limit) parts.push(h('button', { type: 'button', class: 'btn wide', onclick: () => { limit += 100; render(); } }, 'さらに表示（残り ' + (done.length - limit) + '件）'));
    fill(box, h('p', { class: 'sheet-note' }, '丸を押すと未完了に戻ります（入った経験値も戻ります）。'), ...parts);
  };
  render();
  openSheet({ title: '完了ログ', content: box, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

function openTrash() {
  const box = h('div');
  const render = () => {
    const tasks = S.data.tasks.filter((t) => t.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    const memos = S.data.memos.filter((m) => m.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    const item = (label, sub, onRestore, onPurge) => h('li', { class: 'trash-row' },
      h('div', { class: 'trash-main' }, h('div', { class: 'row-title-text' }, label), h('div', { class: 'row-meta' }, sub)),
      h('button', { type: 'button', class: 'mini-btn', onclick: onRestore }, '戻す'),
      h('button', { type: 'button', class: 'mini-btn danger', onclick: onPurge }, '完全に消す'));
    const purge = async (what, fn) => {
      const ok = await confirmDialog({ title: '完全に消しますか？', message: '「' + what + '」を消します。元に戻せません。', okLabel: '完全に消す', destructive: true });
      if (!ok) return;
      fn();
      render();
    };
    fill(box, 
      h('p', { class: 'sheet-note' }, '削除したものはここに残ります。自動では消えません。'),
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'タスク（' + tasks.length + '件）')),
      tasks.length ? h('ul', { class: 'card' }, tasks.map((t) => item(t.title, '削除 ' + U.fmtDateTime(t.deletedAt),
        () => { T.restoreTask(t, nowIso()); save(['tasks']); renderAll(); render(); toast('タスクを戻しました'); },
        () => purge(t.title, () => { S.data.tasks = S.data.tasks.filter((x) => x.id !== t.id); save(['tasks']); renderAll(); })))) : h('p', { class: 'empty small' }, 'ありません'),
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'メモ（' + memos.length + '件）')),
      memos.length ? h('ul', { class: 'card' }, memos.map((m) => item(m.text, '削除 ' + U.fmtDateTime(m.deletedAt),
        () => { m.deletedAt = null; save(['memos']); renderMemo(); render(); toast('メモを戻しました'); },
        () => purge(m.text, () => { S.data.memos = S.data.memos.filter((x) => x.id !== m.id); save(['memos']); renderMemo(); })))) : h('p', { class: 'empty small' }, 'ありません'));
  };
  render();
  openSheet({ title: 'ゴミ箱', content: box, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

function openPastSchedule() {
  const log = S.data.scheduleLog.slice().sort((a, b) => b.date.localeCompare(a.date));
  const parts = log.length ? log.map((e) => [
    h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, U.fmtMD(e.date, thisYear()))),
    h('ul', { class: 'card lines' }, e.lines.map((l) => h('li', { class: 'line' }, h('span', { class: 'line-body static' }, timeText(l.text))))),
  ]) : [h('p', { class: 'empty' }, '過去の予定はまだありません')];
  openSheet({ title: '過去の予定', content: [h('p', { class: 'sheet-note' }, '日付が変わったときに、その日の予定がここへ移ります。'), ...parts.flat()], cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

function openGoalReview(kind) {
  let cur = kind;
  const box = h('div');
  const render = () => {
    const seg = h('div', { class: 'seg', role: 'tablist' }, PL.GOAL_KINDS.map((k) => h('button', { type: 'button', role: 'tab', class: 'seg-btn' + (k === cur ? ' on' : ''), 'aria-selected': String(k === cur), onclick: () => { cur = k; render(); } }, PL.GOAL_KIND_LABEL[k])));
    const list = S.data.goalLog.filter((e) => e.kind === cur).sort((a, b) => b.key.localeCompare(a.key));
    fill(box, seg, ...(list.length ? list.map((e) => [
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, PL.historyLabel(e.kind, e.key) + ' の目標')),
      h('ul', { class: 'card plain-lines' }, e.lines.map((s) => h('li', {}, h('span', { class: 'bullet' }, '・'), h('span', {}, s)))),
    ]).flat() : [h('p', { class: 'empty' }, 'まだありません（期間が終わると自動でここに移ります）')]));
  };
  render();
  openSheet({ title: 'ふり返り', content: box, cancelLabel: null, onDone: () => true, doneLabel: '閉じる' });
}

// ---------------------------------------------------------------- settings, export / import

function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, class: 'hidden-link' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function doExport() {
  const at = nowIso();
  S.data.settings.lastExportAt = at;
  const name = ST.exportFileName(new Date());
  downloadJson(ST.buildExport(S.data, at), name);
  save(['settings']);
  renderBanners();
  toast('書き出しました（' + name + '）', { duration: 5000 });
  return name;
}

async function importFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    await alertDialog({ title: '読み込めませんでした', message: 'ファイルが大きすぎます（20MBまで）。今のデータは何も変わっていません。' });
    return;
  }
  const text = await file.text();
  const r = ST.parseImportText(text);
  if (!r.ok) {
    await alertDialog({ title: '読み込めませんでした', message: r.error + '\n今のデータは何も変わっていません。' });
    return;
  }
  const c = r.counts;
  const ok = await confirmDialog({
    title: 'このファイルで置き換えますか？',
    message: 'タスク ' + c.tasks + '件・完了 ' + c.done + '件・ゴミ箱 ' + c.trash + '件・メモ ' + c.memos + '件・相手 ' + c.people + '件・目標 ' + c.goals + '行・今日の予定 ' + c.schedule + '行・履歴 ' + c.history + '件・竜の経験値 ' + c.xp + '\n\n今のデータは「読み込み直前の控え」に残します（設定から戻せます）。',
    okLabel: '置き換える',
    destructive: true,
  });
  if (!ok) return;
  await replaceAllData(r.data, '読み込みました（タスク ' + c.tasks + '件）');
}

async function replaceAllData(newData, message) {
  await S.queue;
  try {
    await ST.savePreImport(S.db, S.data, nowIso());
  } catch (e) {
    await alertDialog({ title: '控えを作れなかったので止めました', message: '今のデータは何も変わっていません。' });
    return false;
  }
  S.data = newData;
  const ok = await save(ST.KEYS);
  if (!ok) {
    await reloadFromDb();
    await alertDialog({ title: '読み込みを保存できませんでした', message: '画面は保存されている内容に戻しました。「読み込み直前の控え」も残っています。' });
    return false;
  }
  await dayCheck(true);
  toast(message);
  return true;
}

async function restoreBackup(b) {
  const r = ST.validateImport({ app: ST.APP_ID, format: ST.FORMAT, data: b.data });
  if (!r.ok) {
    await alertDialog({ title: '控えが壊れているので戻せません', message: r.error });
    return false;
  }
  const ok = await confirmDialog({ title: 'この控えに戻しますか？', message: U.fmtDateTime(b.at) + ' の状態（タスク ' + r.counts.tasks + '件）に戻します。今のデータは「読み込み直前の控え」に残します。', okLabel: '戻す', destructive: true });
  if (!ok) return false;
  return replaceAllData(r.data, U.fmtDateTime(b.at) + ' の控えに戻しました');
}

function openSettings() {
  const body = h('div', { class: 'settings' });
  const sheet = openSheet({ title: '設定', content: body, cancelLabel: null, onDone: () => true, doneLabel: '完了' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden-file', 'aria-label': '読み込むファイル' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    await importFile(f);
    render();
  });

  const backupsBox = h('div');
  const storageBox = h('ul', { class: 'card kv' });

  async function renderBackups() {
    let all = [];
    try { all = await ST.listBackups(S.db); } catch (e) { /* ignore */ }
    const autos = all.filter((b) => b.kind === 'auto').sort((a, b) => b.date.localeCompare(a.date));
    const pre = all.find((b) => b.kind === 'pre');
    fill(backupsBox, 
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '自動の控え（1日1回・' + ST.BACKUP_DAYS + '日分）')),
      autos.length ? h('ul', { class: 'card' }, autos.map((b) => h('li', { class: 'trash-row' },
        h('div', { class: 'trash-main' }, h('div', {}, U.fmtMD(b.date, thisYear()) + ' の控え'), h('div', { class: 'row-meta' }, U.fmtDateTime(b.at) + '・タスク ' + (b.counts ? b.counts.tasks : '?') + '件')),
        h('button', { type: 'button', class: 'mini-btn', onclick: async () => { if (await restoreBackup(b)) sheet.close(); } }, 'この控えに戻す')))) : h('p', { class: 'empty small' }, 'まだありません'),
      h('p', { class: 'sub-note' }, 'ブラウザの中の控えです。ブラウザのデータを消すと一緒に消えるので、本命は「書き出す」です。'),
      pre ? h('ul', { class: 'card' }, h('li', { class: 'trash-row' },
        h('div', { class: 'trash-main' }, h('div', {}, '読み込み直前の控え'), h('div', { class: 'row-meta' }, U.fmtDateTime(pre.at) + '・タスク ' + (pre.counts ? pre.counts.tasks : '?') + '件')),
        h('button', { type: 'button', class: 'mini-btn', onclick: async () => { if (await restoreBackup(pre)) sheet.close(); } }, '元に戻す'))) : null);
  }

  async function renderStorage() {
    const est = await ST.storageEstimate();
    const p = S.data.settings.persisted;
    fill(storageBox, 
      h('li', {}, h('span', {}, '保存の保護（消されにくくする）'), h('span', { class: 'kv-v' }, p === true ? '許可されています' : p === false ? '許可されていません' : '確認できません')),
      h('li', {}, h('span', {}, '使っている容量'), h('span', { class: 'kv-v' }, est && est.usage != null ? Math.max(1, Math.round(est.usage / 1024)).toLocaleString() + ' KB' : '確認できません')));
  }

  function render() {
    const st = S.data.settings;
    const people = activePeople();
    fill(body, 
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '竜')),
      h('ul', { class: 'card form' }, h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, '名前'), h('button', { type: 'button', class: 'f-value', onclick: renameDragon }, S.data.dragon.name, icon('chevron-right')))),

      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '相手（確認先・依頼先）')),
      h('ul', { class: 'card' }, people.map((p) => h('li', {}, h('button', { type: 'button', class: 'person-row', onclick: () => editPerson(p, render) },
        avatar(p, 'sm'), h('span', { class: 'person-row-name' }, p.name), h('span', { class: 'f-hint' }, T.GROUP_LABEL[p.group]), icon('chevron-right')))),
      h('li', {}, h('button', { type: 'button', class: 'person-row add', onclick: () => editPerson(null, render) }, icon('plus'), h('span', {}, '相手を足す')))),
      h('p', { class: 'sub-note' }, '人の名前や社外の呼び名はここで足します。この端末の中にだけ保存され、どこにも送られません。'),

      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'バックアップ')),
      h('ul', { class: 'card form' },
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => { doExport(); render(); } }, icon('download'), '書き出す（JSONファイル）')),
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => fileInput.click() }, icon('upload'), '読み込む（今のデータと置き換え）')),
        h('li', { class: 'form-row' }, h('span', { class: 'f-label' }, '最後の書き出し'), h('span', { class: 'f-hint' }, st.lastExportAt ? U.fmtDateTime(st.lastExportAt) : 'まだありません'))),
      fileInput,
      backupsBox,

      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '保存の状態')),
      storageBox,

      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '記録')),
      h('ul', { class: 'card form' },
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: openDoneLog }, icon('history'), '完了ログ')),
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: openTrash }, icon('trash'), 'ゴミ箱（' + (S.data.tasks.filter((t) => t.deletedAt).length + S.data.memos.filter((m) => m.deletedAt).length) + '件）')),
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: openPastSchedule }, icon('calendar'), '過去の予定')),
        h('li', {}, h('button', { type: 'button', class: 'action', onclick: () => openGoalReview(S.ui.goalSeg) }, icon('target'), '目標のふり返り'))),

      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, 'このアプリについて')),
      h('p', { class: 'sub-note' }, '実行リスト v1.1。データはこの端末のブラウザの中（IndexedDB）にだけ保存されます。外部への送信はしません。PCとスマホは別々の帳簿です（引っ越しは 書き出す → 読み込む）。'));
    renderBackups();
    renderStorage();
  }
  render();
}

function editPerson(p, after) {
  const isNew = !p;
  const name = h('input', { type: 'text', class: 'field', value: p ? p.name : '', maxlength: String(T.PERSON_NAME_MAX), placeholder: '名前（例: 部署名や呼び名）', 'aria-label': '名前' });
  let group = p ? p.group : 'team';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '色分け' });
  const renderSeg = () => fill(seg, ...T.GROUPS.map((g) => h('button', { type: 'button', class: 'seg-btn' + (g === group ? ' on' : ''), 'aria-pressed': String(g === group), onclick: () => { group = g; renderSeg(); } }, T.GROUP_LABEL[g])));
  renderSeg();
  const del = !isNew ? h('button', { type: 'button', class: 'btn wide danger', onclick: async () => {
    const ok = await confirmDialog({ title: '「' + p.name + '」を消しますか？', message: '選ぶ画面から消えます。すでに確認ルートに入っている段は、そのまま名前で残ります。', okLabel: '消す', destructive: true });
    if (!ok) return;
    p.deletedAt = nowIso();
    save(['people']);
    sheet.close();
    renderAll();
    if (after) after();
  } }, 'この相手を消す') : null;
  const sheet = openSheet({
    title: isNew ? '相手を足す' : '相手を変える',
    className: 'sheet-small',
    content: [h('div', { class: 'card pad' }, name), h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, '色分け（上司・部署内＝藍／他部署＝青緑／社外＝橙）')), seg, del],
    onDone: () => {
      const v = U.clampText(name.value.trim(), T.PERSON_NAME_MAX);
      if (!v) { toast('名前を入れてください'); return false; }
      if (isNew) S.data.people.push(T.newPerson(v, group, null));
      else { p.name = v; p.group = group; p.initial = T.initialOf(v); }
      save(['people']);
      renderAll();
      if (after) after();
      return true;
    },
  });
  name.focus();
}

// ---------------------------------------------------------------- go

start().catch((e) => {
  console.error(e);
  fatal('起動できませんでした', String(e && e.message ? e.message : e));
});

// For checking in the browser console: numbers only, plus re-running the same day check
// that the hourly timer runs (used to test what happens when the date changes).
globalThis.jikkoDebug = {
  counts: () => (S.data ? ST.countsOf(S.data) : null),
  rev: () => S.rev,
  today: () => S.today,
  overlay: () => overlayOpen(),
  phone: () => isPhone(),
  recheckDay: () => dayCheck(true),
};
