// Putting two versions of the same item together (7-5 of the spec).
// base = the version before both changes (null = nothing), a and b = the two sides (a = the smaller version name).
// A place that only one side changed takes that change, the same change on both sides is kept, and different
// changes on both sides are "asked" (conflicts), except the places the spec decides automatically.
// ★ places are asked although they are not "the same place", because putting them together would lose something.
// Every result is a plain calculation, so two devices that put the same versions together get the same result.

import { canonical, compareVersions } from './rev.js';
import { parseKey } from './records.js';
import { ROUTE_MAX, PURGED_MEMO_TEXT, initialOf, purgeTask } from '../tasks.js';
import { GOAL_LIMITS, SCHEDULE_LIMITS } from '../plan.js';

const NONE = Symbol('none'); // a place that did not exist before (no base)

function same(x, y) {
  if (x === NONE || y === NONE) return x === y;
  return canonical(x) === canonical(y);
}

function at(o, f) {
  return o ? o[f] : NONE;
}

function pick(o, fields) {
  if (!o) return NONE;
  const out = {};
  for (const f of fields) out[f] = o[f] === undefined ? null : o[f];
  return out;
}

function time(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function earlier(x, y) {
  if (!x) return y;
  if (!y) return x;
  return time(y) < time(x) ? y : x;
}

function later(x, y) {
  if (!x) return y;
  if (!y) return x;
  return time(y) > time(x) ? y : x;
}

/** "The newer one": the saved update time of a task, otherwise (and on a tie) the larger version name. */
export function newerSide(key, a, b, aName, bName) {
  const k = parseKey(key);
  if (k && k.type === 'task' && a && b) {
    const ta = time(a.updatedAt);
    const tb = time(b.updatedAt);
    if (ta !== tb) return ta > tb ? 'a' : 'b';
  }
  return compareVersions(aName || '', bName || '') >= 0 ? 'a' : 'b';
}

function context(opt, newer) {
  const conflicts = [];
  const side = opt.prefer === 'a' || opt.prefer === 'b' ? opt.prefer : newer;
  return {
    conflicts,
    side,
    newer,
    /** One place: one side changed -> that change; both the same -> kept; different -> asked. */
    ask(field, label, o, a, b) {
      if (same(a, b)) return a;
      if (same(a, o)) return b;
      if (same(b, o)) return a;
      conflicts.push({ field, label, a, b });
      return side === 'a' ? a : b;
    },
    /** One place decided automatically: `both` is used when the two sides changed it differently. */
    auto(o, a, b, both) {
      if (same(a, b)) return a;
      if (same(a, o)) return b;
      if (same(b, o)) return a;
      return both(a, b);
    },
    conflict(field, label, a, b) {
      conflicts.push({ field, label, a, b });
      return side;
    },
  };
}

// ---------------------------------------------------------------- order of steps / schedule lines

/**
 * The order of ids after both sides added, removed or moved some. The side that moved things is followed
 * (both moved: the newer one); what the other side added goes right after the line it followed there
 * (after the first side's own new lines at that place), so each side's own order is kept as far as possible.
 */
export function mergeOrder(oIds, aIds, bIds, keep, newer) {
  const oSet = new Set(oIds);
  const aSeq = aIds.filter((id) => keep.has(id));
  const bSeq = bIds.filter((id) => keep.has(id));
  const bSet = new Set(bIds);
  const common = new Set(oIds.filter((id) => keep.has(id) && aSeq.includes(id) && bSet.has(id)));
  const rel = (seq) => seq.filter((id) => common.has(id));
  const movedA = !same(rel(aSeq), rel(oIds));
  const movedB = !same(rel(bSeq), rel(oIds));
  const primary = movedA && !movedB ? 'a' : !movedA && movedB ? 'b' : newer;
  const P = primary === 'a' ? aSeq : bSeq;
  const Q = primary === 'a' ? bSeq : aSeq;
  const pNew = new Set(P.filter((id) => !oSet.has(id)));
  const result = P.slice();
  const placed = new Set(result);
  for (let qi = 0; qi < Q.length; qi += 1) {
    const id = Q[qi];
    if (placed.has(id)) continue;
    let pos = -1;
    for (let k = qi - 1; k >= 0; k -= 1) {
      const r = result.indexOf(Q[k]);
      if (r >= 0) { pos = r; break; }
    }
    let put = pos + 1;
    while (put < result.length && pNew.has(result[put])) put += 1;
    result.splice(put, 0, id);
    placed.add(id);
  }
  for (const id of keep) if (!placed.has(id)) result.push(id); // never drop a line
  return result;
}

// ---------------------------------------------------------------- tasks

const TASK_ASK = [
  ['title', 'タスク名'], ['due', '期日'], ['rank', 'ランク'], ['duration', '所要期間'], ['star', '重要★'],
  ['nextAction', '次にやること'], ['memo', 'メモ'], ['cOption', 'Cの選択'],
];
const LINK_ASK = [['slack', 'リンク（Slack）'], ['doc', 'リンク（資料）'], ['web', 'リンク（Web）']];
const STATUS_FIELDS = ['status', 'doneAt', 'prevStatus', 'prevPark', 'xpGiven', 'xpBucket'];
const PARK_FIELDS = ['parked', 'returnOn'];
const STEP_STATE = ['state', 'waitSince', 'doneAt'];
// Places that "完全に消す" empties (tasks.js purgeTask).
const WIPED = ['title', 'due', 'duration', 'star', 'nextAction', 'memo', 'cOption', 'route', 'links', 'parked', 'returnOn', 'returnedMark', 'doneAt', 'prevStatus', 'prevPark'];

function stepEdited(o, x) {
  return !same(o.kind, x.kind) || !same(o.whoId, x.whoId) || !same(o.note, x.note) || !same(pick(o, STEP_STATE), pick(x, STEP_STATE));
}

function routeEdited(oR, xR) {
  const om = new Map(oR.map((s) => [s.id, s]));
  const xm = new Map(xR.map((s) => [s.id, s]));
  if (om.size !== xm.size) return true;
  for (const [id, s] of xm) {
    const o = om.get(id);
    if (!o || stepEdited(o, s)) return true;
  }
  return false;
}

/** Did this side change what the task says (not just its place in the list or its marks)? */
function taskEdited(o, x, restoreCounts) {
  if (!o) return true;
  for (const [f] of TASK_ASK) if (!same(o[f], x[f])) return true;
  for (const [f] of LINK_ASK) if (!same(o.links[f], x.links[f])) return true;
  if (!same(pick(o, STATUS_FIELDS), pick(x, STATUS_FIELDS))) return true;
  if (!same(pick(o, PARK_FIELDS), pick(x, PARK_FIELDS))) return true;
  if (routeEdited(o.route, x.route)) return true;
  if (restoreCounts && o.deletedAt && !x.deletedAt) return true;
  return false;
}

/** What a side looks like for the merge: a completely deleted side leaves the emptied places as they were. */
function effective(x, o, other) {
  if (!x.purgedAt || (o && o.purgedAt)) return x;
  const from = o || other;
  const out = Object.assign({}, x);
  for (const f of WIPED) out[f] = structuredClone(from[f]);
  return out;
}

function mergeRoute(oR, aR, bR, c) {
  const om = new Map((oR || []).map((s) => [s.id, s]));
  const am = new Map(aR.map((s) => [s.id, s]));
  const bm = new Map(bR.map((s) => [s.id, s]));
  const ids = [...new Set([...aR.map((s) => s.id), ...bR.map((s) => s.id), ...(oR || []).map((s) => s.id)])];
  const pos = (id) => {
    const i = aR.findIndex((s) => s.id === id);
    const j = bR.findIndex((s) => s.id === id);
    return '確認ルート' + '①②③④⑤⑥⑦⑧⑨⑩'[Math.max(i, j, 0)];
  };
  const out = new Map();
  for (const id of ids) {
    const o = om.get(id);
    const a = am.get(id);
    const b = bm.get(id);
    if (a && b) {
      const ob = o || null;
      out.set(id, {
        id,
        kind: c.ask('route.' + id + '.kind', pos(id) + 'の種類', at(ob, 'kind'), a.kind, b.kind),
        whoId: c.ask('route.' + id + '.whoId', pos(id) + 'の相手', at(ob, 'whoId'), a.whoId, b.whoId),
        note: c.ask('route.' + id + '.note', pos(id) + 'のメモ', at(ob, 'note'), a.note, b.note),
        ...c.ask('route.' + id + '.state', pos(id) + 'の状態', pick(ob, STEP_STATE), pick(a, STEP_STATE), pick(b, STEP_STATE)),
        xpGiven: Boolean(a.xpGiven || b.xpGiven),
      });
    } else if (a || b) {
      const x = a || b;
      if (o) {
        // removed by one side
        if (stepEdited(o, x)) {
          const keepSide = a ? 'a' : 'b';
          const s = c.conflict('route.' + id + '.removed', pos(id) + '（片方が消した段）', a ? x : null, b ? x : null);
          if (s === keepSide) out.set(id, structuredClone(x));
        }
      } else {
        out.set(id, structuredClone(x)); // added by one side
      }
    }
    // in the base only: removed by both
  }
  const order = mergeOrder((oR || []).map((s) => s.id), aR.map((s) => s.id), bR.map((s) => s.id), new Set(out.keys()), c.newer);
  const route = order.map((id) => out.get(id));
  const fromBoth = !same(route, aR) && !same(route, bR);
  return { route, fromBoth };
}

function mergeTask(key, o, a0, b0, opt, newer) {
  const c = context(opt, newer);
  const a = effective(a0, o, b0);
  const b = effective(b0, o, a0);
  const r = { id: a0.id };
  for (const [f, label] of TASK_ASK) r[f] = c.ask(f, label, at(o, f), a[f], b[f]);
  r.links = {};
  for (const [f, label] of LINK_ASK) r.links[f] = c.ask('links.' + f, label, o ? o.links[f] : NONE, a.links[f], b.links[f]);

  // the route (steps are told apart by their id)
  const before = c.conflicts.length;
  const rm = mergeRoute(o ? o.route : null, a.route, b.route, c);
  r.route = rm.route;
  if (r.route.length > ROUTE_MAX) {
    // ★ together it would be more than 5 steps: which route to keep
    c.conflicts.splice(before, c.conflicts.length - before);
    const s = c.conflict('route', '確認ルート（合わせると' + ROUTE_MAX + '段を超える）', a.route, b.route);
    r.route = structuredClone(s === 'a' ? a.route : b.route);
  }

  // the status (the completion time, the undo record and the completion points move with it)
  const sO = pick(o, STATUS_FIELDS);
  const sA = pick(a, STATUS_FIELDS);
  const sB = pick(b, STATUS_FIELDS);
  let st;
  if (same(sA, sB) || same(sB, sO)) st = sA;
  else if (same(sA, sO)) st = sB;
  else if (sA.status === 'done' && sB.status === 'done') {
    const ta = time(sA.doneAt);
    const tb = time(sB.doneAt);
    st = ta < tb || (ta === tb && compareVersions(opt.aName || '', opt.bName || '') <= 0) ? sA : sB; // both done: the earlier one
  } else if (sA.status === 'done' || sB.status === 'done') {
    st = c.conflict('status', '状態（完了とそれ以外）', sA.status, sB.status) === 'a' ? sA : sB; // ★
  } else {
    st = Object.assign({}, newer === 'a' ? sA : sB, { status: null }); // neither done: decided from the route below
  }
  Object.assign(r, structuredClone(st));
  if (r.status === null || (rm.fromBoth && r.status !== 'done')) {
    const waiting = r.route.some((s) => s.state === 'wait');
    r.status = waiting ? 'stopped' : r.status === 'todo' ? 'todo' : 'doing';
    if (st.status === null && !waiting && sA.status === 'todo' && sB.status === 'todo') r.status = 'todo';
  }

  // the later box (moved together with its return date)
  const pk = c.ask('park', 'あとで箱', pick(o, PARK_FIELDS), pick(a, PARK_FIELDS), pick(b, PARK_FIELDS));
  r.parked = pk.parked;
  r.returnOn = pk.returnOn;

  // decided automatically
  r.order = c.auto(at(o, 'order'), a.order, b.order, () => (newer === 'a' ? a.order : b.order));
  r.returnedMark = c.auto(at(o, 'returnedMark'), a.returnedMark, b.returnedMark, () => false);
  r.createdAt = earlier(a.createdAt, b.createdAt);
  r.updatedAt = later(a.updatedAt, b.updatedAt);
  const legacy = Math.max(a.xpStepsLegacy || 0, b.xpStepsLegacy || 0);
  r.xpSteps = [...new Set([...(a.xpSteps || []), ...(b.xpSteps || [])])].sort().slice(0, Math.max(0, ROUTE_MAX - legacy));
  r.xpStepsLegacy = legacy;
  r.stepXpCount = Math.min(ROUTE_MAX, r.xpSteps.length + legacy);

  // the trash and "完全に消す"
  const aP = Boolean(a0.purgedAt);
  const bP = Boolean(b0.purgedAt);
  const oP = Boolean(o && o.purgedAt);
  r.purgedAt = null;
  r.deletedAt = null;
  let purge = false;
  if (aP && bP) {
    purge = true;
    r.purgedAt = earlier(a0.purgedAt, b0.purgedAt);
    r.deletedAt = earlier(a0.deletedAt, b0.deletedAt);
  } else if ((aP || bP) && !oP) {
    const P = aP ? a0 : b0;
    const K = aP ? b0 : a0;
    const pSide = aP ? 'a' : 'b';
    let keepIt = false;
    if (taskEdited(o, K, true)) {
      // ★ one side deleted it completely, the other changed it
      keepIt = c.conflict('purged', '完全に消した（消す／残す）', aP ? '消す' : '残す', aP ? '残す' : '消す') !== pSide;
    }
    if (keepIt) {
      r.deletedAt = K.deletedAt || null;
    } else {
      purge = true;
      r.purgedAt = P.purgedAt;
      r.deletedAt = earlier(P.deletedAt, K.deletedAt);
    }
  } else {
    if (oP) {
      // it was already a mark: it stays one unless a side chose to keep it (an answer to "消す／残す")
      const p = purgedAgain(o, a0, b0, c);
      if (p) { purge = true; r.purgedAt = p; }
    }
    r.deletedAt = mergeTrash(o, a, b, c, (x) => taskEdited(o, x, false));
  }
  if (purge) {
    purgeTask(r, r.purgedAt);
    r.deletedAt = r.deletedAt || r.purgedAt;
    r.updatedAt = later(a.updatedAt, b.updatedAt);
    // the points it earned stay: the merged status, rank and steps
  }
  return { content: r, conflicts: c.conflicts, newer };
}

/** The base was a mark already: one side taking it back ("残す" chosen) wins; both still marks: the earlier date. */
function purgedAgain(o, a, b, c) {
  return c.auto(o.purgedAt, a.purgedAt || null, b.purgedAt || null, (x, y) => (x && y ? earlier(x, y) : null));
}

/**
 * The trash date. Both in the trash: the earlier date. ★ One side put it in the trash while the other side
 * changed it: asked ("ゴミ箱のまま" / "戻して残す").
 */
function mergeTrash(o, a, b, c, edited) {
  const od = o ? o.deletedAt : NONE;
  const ad = a.deletedAt || null;
  const bd = b.deletedAt || null;
  if (ad && bd) {
    if (same(ad, od)) return bd;
    if (same(bd, od)) return ad;
    return earlier(ad, bd);
  }
  if (!ad && !bd) return null;
  const tSide = ad ? 'a' : 'b';
  const td = ad || bd;
  const kept = ad ? b : a;
  const trashChanged = !same(td, od);
  const keptChanged = !same(null, od);
  if (trashChanged && !keptChanged) {
    // put in the trash on one side; the other side kept it out
    if (o && edited(kept)) {
      return c.conflict('trash', 'ゴミ箱（ゴミ箱のまま／戻して残す）', ad ? 'ゴミ箱のまま' : '戻して残す', ad ? '戻して残す' : 'ゴミ箱のまま') === tSide ? td : null;
    }
    return td;
  }
  if (!trashChanged && keptChanged) return null; // taken back out of the trash on one side
  return c.conflict('trash', 'ゴミ箱（ゴミ箱のまま／戻して残す）', ad ? 'ゴミ箱のまま' : '戻して残す', ad ? '戻して残す' : 'ゴミ箱のまま') === tSide ? td : null;
}

// ---------------------------------------------------------------- memos and people

function mergeMemo(key, o, a0, b0, opt, newer) {
  const c = context(opt, newer);
  const eff = (x, other) => (x.purgedAt && !(o && o.purgedAt) ? Object.assign({}, x, { text: (o || other).text, taskId: (o || other).taskId }) : x);
  const a = eff(a0, b0);
  const b = eff(b0, a0);
  const r = { id: a0.id };
  r.text = c.ask('text', '本文', at(o, 'text'), a.text, b.text);
  r.taskId = c.auto(at(o, 'taskId'), a.taskId, b.taskId, (x, y) => (x && y ? (newer === 'a' ? x : y) : x || y));
  r.createdAt = earlier(a.createdAt, b.createdAt);
  const edited = (x) => !o || !same(o.text, x.text);
  const aP = Boolean(a0.purgedAt);
  const bP = Boolean(b0.purgedAt);
  const oP = Boolean(o && o.purgedAt);
  let purge = false;
  r.purgedAt = null;
  if (aP && bP) {
    purge = true;
    r.purgedAt = earlier(a0.purgedAt, b0.purgedAt);
    r.deletedAt = earlier(a0.deletedAt, b0.deletedAt);
  } else if ((aP || bP) && !oP) {
    const P = aP ? a0 : b0;
    const K = aP ? b0 : a0;
    let keepIt = false;
    if (edited(K) || (o && o.deletedAt && !K.deletedAt)) {
      keepIt = c.conflict('purged', '完全に消した（消す／残す）', aP ? '消す' : '残す', aP ? '残す' : '消す') !== (aP ? 'a' : 'b');
    }
    if (keepIt) r.deletedAt = K.deletedAt || null;
    else {
      purge = true;
      r.purgedAt = P.purgedAt;
      r.deletedAt = earlier(P.deletedAt, K.deletedAt);
    }
  } else {
    if (oP) {
      const p = purgedAgain(o, a0, b0, c);
      if (p) { purge = true; r.purgedAt = p; }
    }
    r.deletedAt = mergeTrash(o, a, b, c, edited);
  }
  if (purge) {
    r.text = PURGED_MEMO_TEXT;
    r.taskId = null;
    r.deletedAt = r.deletedAt || r.purgedAt;
  }
  return { content: r, conflicts: c.conflicts, newer };
}

function mergePerson(key, o, a, b, opt, newer) {
  const c = context(opt, newer);
  const r = { id: a.id };
  r.name = c.ask('name', '名前', at(o, 'name'), a.name, b.name);
  r.group = c.ask('group', '区分', at(o, 'group'), a.group, b.group);
  r.icon = c.ask('icon', 'アイコン', at(o, 'icon'), a.icon, b.icon);
  r.initial = initialOf(r.name);
  const edited = (x) => !o || !same(o.name, x.name) || !same(o.group, x.group) || !same(o.icon, x.icon);
  const od = o ? o.deletedAt : NONE;
  if (a.deletedAt && b.deletedAt) r.deletedAt = same(a.deletedAt, od) ? b.deletedAt : same(b.deletedAt, od) ? a.deletedAt : earlier(a.deletedAt, b.deletedAt);
  else if (!a.deletedAt && !b.deletedAt) r.deletedAt = null;
  else {
    const dSide = a.deletedAt ? 'a' : 'b';
    const kept = a.deletedAt ? b : a;
    const d = a.deletedAt || b.deletedAt;
    if (!same(d, od) && edited(kept)) {
      // ★ deleted on one side, changed on the other
      r.deletedAt = c.conflict('deleted', '相手の削除（消す／残す）', dSide === 'a' ? '消す' : '残す', dSide === 'a' ? '残す' : '消す') === dSide ? d : null;
    } else if (!same(d, od)) r.deletedAt = d;
    else r.deletedAt = null;
  }
  return { content: r, conflicts: c.conflicts, newer };
}

// ---------------------------------------------------------------- goals (lines without ids)

/** Longest common subsequence of two lists of lines: the pairs [i, j] of lines that are exactly the same. */
export function lcsPairs(O, X) {
  const n = O.length;
  const m = X.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = O[i] === X[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (O[i] === X[j]) { pairs.push([i, j]); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1; else j += 1;
  }
  return pairs;
}

/**
 * What one side did to each line of the base: keep / delete / replace with a text, and the lines it
 * inserted after a base line (-1 = at the top). Unpaired lines in the same gap are paired in order.
 */
export function lineFates(O, X) {
  const fate = O.map(() => ({ t: 'keep' }));
  const ins = new Map();
  const pairs = lcsPairs(O, X).concat([[O.length, X.length]]);
  let pi = -1;
  let pj = -1;
  for (const [i, j] of pairs) {
    const gapO = [];
    for (let k = pi + 1; k < i; k += 1) gapO.push(k);
    const gapX = X.slice(pj + 1, j);
    const n = Math.min(gapO.length, gapX.length);
    for (let k = 0; k < gapO.length; k += 1) fate[gapO[k]] = k < n ? { t: 'rep', text: gapX[k] } : { t: 'del' };
    if (gapX.length > n) {
      const anchor = gapO.length ? gapO[gapO.length - 1] : pi;
      if (!ins.has(anchor)) ins.set(anchor, []);
      ins.get(anchor).push(...gapX.slice(n));
    }
    pi = i;
    pj = j;
  }
  return { fate, ins };
}

function mergeGoal(key, o, a, b, opt, newer) {
  const c = context(opt, newer);
  const O = o ? o.lines : [];
  const fa = lineFates(O, a.lines);
  const fb = lineFates(O, b.lines);
  const aFirst = compareVersions(opt.aName || '', opt.bName || '') <= 0;
  const out = [];
  const insert = (anchor) => {
    const x = fa.ins.get(anchor) || [];
    const y = fb.ins.get(anchor) || [];
    const [first, second] = aFirst ? [x, y] : [y, x];
    out.push(...first, ...second.filter((s) => !first.includes(s)));
  };
  insert(-1);
  O.forEach((line, i) => {
    const A = fa.fate[i];
    const B = fb.fate[i];
    const label = '目標の' + (i + 1) + '行目「' + line + '」';
    if (A.t === 'keep' && B.t === 'keep') out.push(line);
    else if (A.t === 'keep' && B.t === 'rep') out.push(B.text);
    else if (A.t === 'rep' && B.t === 'keep') out.push(A.text);
    else if (A.t === 'rep' && B.t === 'rep') {
      if (A.text === B.text) out.push(A.text);
      else out.push(c.conflict('line.' + i, label, A.text, B.text) === 'a' ? A.text : B.text);
    } else if ((A.t === 'del' && B.t === 'rep') || (A.t === 'rep' && B.t === 'del')) {
      // ★ deleted on one side, rewritten on the other
      const s = c.conflict('line.' + i, label + '（片方が消した）', A.t === 'rep' ? A.text : null, B.t === 'rep' ? B.text : null);
      const keep = s === 'a' ? A : B;
      if (keep.t === 'rep') out.push(keep.text);
    }
    // keep + del, del + del: deleted
    insert(i);
  });
  let lines = out;
  if (lines.length > GOAL_LIMITS.lines) {
    // ★ together more than 10 lines: which goals to keep
    c.conflicts.length = 0;
    lines = (c.conflict('over', '目標（合わせると' + GOAL_LIMITS.lines + '行を超える）', a.lines, b.lines) === 'a' ? a.lines : b.lines).slice();
  }
  return { content: { lines }, conflicts: c.conflicts, newer };
}

// ---------------------------------------------------------------- schedule (lines with ids)

function mergeSchedule(key, o, a, b, opt, newer) {
  const c = context(opt, newer);
  const O = o ? o.lines : [];
  const om = new Map(O.map((l) => [l.id, l]));
  const am = new Map(a.lines.map((l) => [l.id, l]));
  const bm = new Map(b.lines.map((l) => [l.id, l]));
  const ids = [...new Set([...O.map((l) => l.id), ...a.lines.map((l) => l.id), ...b.lines.map((l) => l.id)])];
  const out = new Map();
  for (const id of ids) {
    const ol = om.get(id);
    const al = am.get(id);
    const bl = bm.get(id);
    const label = '予定「' + ((ol || al || bl).text) + '」';
    if (al && bl) out.set(id, { id, text: c.ask('line.' + id, label, ol ? ol.text : NONE, al.text, bl.text) });
    else if (al || bl) {
      const x = al || bl;
      if (!ol) out.set(id, { id, text: x.text }); // added by one side
      else if (x.text !== ol.text) {
        // ★ deleted on one side, rewritten on the other
        const s = c.conflict('line.' + id, label + '（片方が消した）', al ? al.text : null, bl ? bl.text : null);
        if (s === (al ? 'a' : 'b')) out.set(id, { id, text: x.text });
      }
      // not rewritten: deleted
    }
  }
  const order = mergeOrder(O.map((l) => l.id), a.lines.map((l) => l.id), b.lines.map((l) => l.id), new Set(out.keys()), newer);
  let lines = order.map((id) => out.get(id));
  if (lines.length > SCHEDULE_LIMITS.lines) {
    // ★ together more than 30 lines: which day to keep
    c.conflicts.length = 0;
    lines = structuredClone(c.conflict('over', '予定（合わせると' + SCHEDULE_LIMITS.lines + '行を超える）', a.lines, b.lines) === 'a' ? a.lines : b.lines);
  }
  return { content: { lines }, conflicts: c.conflicts, newer };
}

function mergeDragon(key, o, a, b, opt, newer) {
  const c = context(opt, newer);
  return { content: { name: c.ask('name', '竜の名前', at(o, 'name'), a.name, b.name) }, conflicts: c.conflicts, newer };
}

/**
 * Put two versions of one item together.
 * opt: { aName, bName (version names, for "the newer one" and orders), prefer: 'a' | 'b' | undefined }
 * Returns { content, conflicts: [{ field, label, a, b }], newer }. Without conflicts the content is the automatic
 * result. With conflicts it is resolved toward `prefer` (the answer chosen), or toward the newer side while
 * nobody has chosen yet (shown for the time being, never sent).
 */
export function mergeItem(key, base, a, b, opt = {}) {
  const k = parseKey(key);
  if (!k) throw new Error('bad key ' + key);
  const newer = newerSide(key, a, b, opt.aName, opt.bName);
  switch (k.type) {
    case 'task': return mergeTask(key, base, a, b, opt, newer);
    case 'memo': return mergeMemo(key, base, a, b, opt, newer);
    case 'person': return mergePerson(key, base, a, b, opt, newer);
    case 'goal': return mergeGoal(key, base, a, b, opt, newer);
    case 'schedule': return mergeSchedule(key, base, a, b, opt, newer);
    default: return mergeDragon(key, base, a, b, opt, newer);
  }
}

