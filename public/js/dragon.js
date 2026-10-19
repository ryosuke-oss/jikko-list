// The dragon: experience points, stages and the shapes it is drawn with.

export const XP_RULES = {
  add: 1, // adding a task (max addPerDay times a day)
  addPerDay: 10,
  A: 20,
  B: 10,
  C: 5,
  none: 5, // completing a task without a rank
  onTime: 3, // completed on or before the due date
  step: 2, // a route step done for the first time
};

export const STAGES = [
  { min: 0, name: 'たまご' },
  { min: 50, name: 'ちび竜' },
  { min: 300, name: '若竜' },
  { min: 1000, name: '成竜' },
  { min: 3000, name: '竜王' },
];

export const BUCKETS = ['A', 'B', 'C', 'other'];
const LOG_MAX = 300;

export function newDragon() {
  return { name: 'アオ', xp: { A: 0, B: 0, C: 0, other: 0 }, total: 0, addCount: { date: '', count: 0 }, log: [] };
}

export function totalOf(dragon) {
  return BUCKETS.reduce((sum, k) => sum + (dragon.xp[k] || 0), 0);
}

export function stageIndex(total) {
  let i = 0;
  STAGES.forEach((s, k) => {
    if (total >= s.min) i = k;
  });
  return i;
}

export function level(total) {
  return Math.floor(Math.sqrt(Math.max(0, total) / 5)) + 1;
}

/** Where the dragon stands: stage, next threshold and progress (0..1) inside the current stage. */
export function progress(total) {
  const i = stageIndex(total);
  const next = i < STAGES.length - 1 ? STAGES[i + 1] : null;
  const from = STAGES[i].min;
  return {
    stage: i,
    name: STAGES[i].name,
    level: level(total),
    next: next ? next.name : null,
    remaining: next ? next.min - total : 0,
    ratio: next ? (total - from) / (next.min - from) : 1,
  };
}

/** Points for completing a task today: base by rank + on-time bonus. */
export function xpForCompletion(task, today) {
  const bucket = task.rank === 'A' || task.rank === 'B' || task.rank === 'C' ? task.rank : 'other';
  const base = bucket === 'other' ? XP_RULES.none : XP_RULES[bucket];
  const onTime = task.due && today <= task.due ? XP_RULES.onTime : 0;
  return { amount: base + onTime, bucket, base, onTime };
}

/**
 * Add (or with a negative delta, take back) points.
 * Returns how much really changed and the stage it evolved to (-1 when it did not evolve).
 */
export function grant(dragon, bucket, delta, reason, at) {
  const key = BUCKETS.includes(bucket) ? bucket : 'other';
  const before = totalOf(dragon);
  const next = Math.max(0, (dragon.xp[key] || 0) + delta);
  const applied = next - (dragon.xp[key] || 0);
  dragon.xp[key] = next;
  dragon.total = totalOf(dragon);
  if (applied !== 0) {
    dragon.log.push({ at, delta: applied, reason, bucket: key });
    if (dragon.log.length > LOG_MAX) dragon.log.splice(0, dragon.log.length - LOG_MAX);
  }
  const s0 = stageIndex(before);
  const s1 = stageIndex(dragon.total);
  return { applied, before, after: dragon.total, evolvedTo: s1 > s0 ? s1 : -1 };
}

/** +1 for adding a task, at most addPerDay times a day. */
export function grantAdd(dragon, today, at) {
  if (!dragon.addCount || dragon.addCount.date !== today) dragon.addCount = { date: today, count: 0 };
  if (dragon.addCount.count >= XP_RULES.addPerDay) return { applied: 0, evolvedTo: -1 };
  dragon.addCount.count += 1;
  return grant(dragon, 'other', XP_RULES.add, '追加', at);
}

// ---- Shapes (same outlines as the first mock-up; colors follow the white design) ----

export const DRAGON_COLORS = {
  body: '#6155F5',
  belly: '#FFCC00',
  crown: '#FF8D28',
  shell: '#D1D1D6',
  spot: '#AEAEB2',
  line: '#8E8E93',
};

function eye(cx, cy, r) {
  return [
    ['circle', { cx, cy, r: r * 1.3, fill: '#FFFFFF' }],
    ['circle', { cx: cx + r * 0.3, cy: cy + r * 0.15, r: r * 0.65, fill: '#000000' }],
  ];
}

/** Shapes of one stage as [tag, attributes] pairs, drawn in a 120 x 100 box. */
export function dragonShapes(stage) {
  const C = DRAGON_COLORS;
  const c = C.body;
  const y = C.belly;
  const out = [['ellipse', { cx: 60, cy: 94, rx: 28, ry: 4, fill: C.line, opacity: 0.3 }]];
  if (stage === 0) {
    out.push(
      ['ellipse', { cx: 60, cy: 56, rx: 26, ry: 34, fill: C.shell }],
      ['circle', { cx: 50, cy: 44, r: 4, fill: C.spot }],
      ['circle', { cx: 68, cy: 62, r: 5, fill: C.spot }],
      ['circle', { cx: 55, cy: 75, r: 3, fill: C.spot }],
      ['polyline', { points: '44,38 50,45 56,38 62,46', fill: 'none', stroke: C.line, 'stroke-width': 1.5 }],
    );
  } else if (stage === 1) {
    out.push(
      ['circle', { cx: 60, cy: 48, r: 18, fill: c }],
      ['polygon', { points: '49,35 51,22 57,32', fill: y }],
      ['polygon', { points: '63,32 69,22 71,35', fill: y }],
      ...eye(54, 47, 3),
      ...eye(66, 47, 3),
      ['polygon', { points: '32,64 44,56 56,64 68,56 80,64 88,58 88,78 32,78', fill: C.shell }],
      ['ellipse', { cx: 60, cy: 78, rx: 28, ry: 13, fill: C.shell }],
    );
  } else if (stage === 2) {
    const g = [
      ['path', { d: 'M17 44 Q5 44 6 30 Q10 39 19 38 Z', fill: c }],
      ['polygon', { points: '26,30 14,12 34,24', fill: c, opacity: 0.75 }],
      ['ellipse', { cx: 30, cy: 42, rx: 14, ry: 11, fill: c }],
      ['ellipse', { cx: 32, cy: 45, rx: 8, ry: 6, fill: y }],
      ['circle', { cx: 44, cy: 27, r: 10, fill: c }],
      ['ellipse', { cx: 52, cy: 31, rx: 6, ry: 4.5, fill: c }],
      ['polygon', { points: '39,19 40,9 45,18', fill: y }],
      ['polygon', { points: '46,18 51,10 50,21', fill: y }],
      ...eye(47, 26, 2.2),
      ['rect', { x: 22, y: 50, width: 5, height: 8, rx: 2, fill: c }],
      ['rect', { x: 33, y: 50, width: 5, height: 8, rx: 2, fill: c }],
    ];
    out.push(['g', { transform: 'translate(24,14) scale(1.15)' }, g]);
  } else {
    out.push(
      ['path', { d: 'M32 70 Q8 72 6 50 Q16 64 34 62 Z', fill: c }],
      ['polygon', { points: '46,50 20,10 60,38', fill: c, opacity: 0.6 }],
      ['polygon', { points: '56,48 44,4 78,40', fill: c, opacity: 0.85 }],
      ['ellipse', { cx: 56, cy: 66, rx: 24, ry: 17, fill: c }],
      ['ellipse', { cx: 59, cy: 71, rx: 14, ry: 9, fill: y }],
      ['path', { d: 'M72 56 Q80 42 85 34', stroke: c, 'stroke-width': 11, fill: 'none', 'stroke-linecap': 'round' }],
      ['circle', { cx: 88, cy: 30, r: 11, fill: c }],
      ['ellipse', { cx: 98, cy: 34, rx: 8, ry: 5.5, fill: c }],
      ...eye(91, 28, 2.4),
      ['rect', { x: 44, y: 78, width: 7, height: 12, rx: 3, fill: c }],
      ['rect', { x: 62, y: 78, width: 7, height: 12, rx: 3, fill: c }],
    );
    if (stage === 3) {
      out.push(
        ['polygon', { points: '82,22 82,8 89,20', fill: y }],
        ['polygon', { points: '90,20 97,8 96,24', fill: y }],
      );
    } else {
      out.push(
        ['polygon', { points: '79,21 81,9 85,16 88,6 91,16 95,9 97,21', fill: C.crown }],
        ['polygon', { points: '106,34 118,27 114,34 118,41', fill: C.crown }],
        ['polygon', { points: '106,34 113,31 111,34 113,37', fill: y }],
      );
    }
  }
  return out;
}
