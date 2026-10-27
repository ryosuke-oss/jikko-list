// One-line parser for the quick-add box, and the multi-line paste.
// "案内文の作成 金曜 B 経理部に依頼" -> title / due date / rank / route steps.

import { addDays, weekday, mondayOf, makeYmd, clampText, textLength } from './util.js';

export const TITLE_MAX = 120;
export const NOTE_MAX = 60;
export const ROUTE_MAX = 5;

const WD = '日月火水木金土';

const DURATION_WORDS = new Map([
  ['1日', '1d'],
  ['3日', '3d'],
  ['1週間', '1w'], ['一週間', '1w'], ['1週', '1w'],
  ['1ヶ月', '1m'], ['1か月', '1m'], ['1カ月', '1m'], ['1ヵ月', '1m'], ['1ケ月', '1m'],
  ['一ヶ月', '1m'], ['一か月', '1m'], ['一カ月', '1m'], ['ひと月', '1m'],
]);

const STAR_WORDS = new Set(['★', '☆', '重要']);

// Spaces (half / full width) and the punctuation voice input tends to add.
const SPLIT_RE = /[\s　、。,，]+/;

function norm(w) {
  return w.normalize('NFKC');
}

/** Due date from one word, or null. Weekdays mean the nearest one (today counts). */
export function parseDateWord(word, today) {
  const w = norm(word);
  if (w === '今日') return today;
  if (w === '明日') return addDays(today, 1);
  if (w === '明後日' || w === 'あさって') return addDays(today, 2);

  let m = /^([日月火水木金土])(?:曜(?:日)?)?$/.exec(w);
  if (m) {
    const target = WD.indexOf(m[1]);
    return addDays(today, (target - weekday(today) + 7) % 7);
  }
  m = /^(今週|来週)の?([日月火水木金土])(?:曜(?:日)?)?$/.exec(w);
  if (m) {
    const offset = (WD.indexOf(m[2]) + 6) % 7; // Monday = 0
    return addDays(mondayOf(today), (m[1] === '来週' ? 7 : 0) + offset);
  }
  m = /^(\d{4})[/年](\d{1,2})[/月](\d{1,2})日?$/.exec(w);
  if (m) return makeYmd(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})\/(\d{1,2})$/.exec(w) || /^(\d{1,2})月(\d{1,2})日?$/.exec(w);
  if (m) {
    const y = Number(today.slice(0, 4));
    const d = makeYmd(y, Number(m[1]), Number(m[2]));
    if (!d) return null;
    // A date that has already passed this year means next year.
    return d < today ? makeYmd(y + 1, Number(m[1]), Number(m[2])) : d;
  }
  return null;
}

/** Match keys for each registered person: the name itself, and the parts around （ ）. */
export function personKeys(people) {
  const out = [];
  for (const p of people || []) {
    const name = norm(String(p.name || '')).trim();
    if (!name) continue;
    const keys = new Set([name]);
    const m = /^(.*?)\((.+?)\)$/.exec(name);
    if (m) {
      if (m[1].trim()) keys.add(m[1].trim());
      if (m[2].trim()) keys.add(m[2].trim());
    }
    for (const key of keys) out.push({ key, id: p.id });
  }
  // Longest first, so a longer name wins over a shorter one it starts with.
  out.sort((a, b) => b.key.length - a.key.length);
  return out;
}

const HONORIFIC_RE = /^(?:さん|様|さま|くん|君|ちゃん|殿)/;
const UNIT_RE = /^(?:部|課|室|チーム)/; // "総務" + "部に確認"
const PARTICLE_RE = /^(?:に|へ|と|から|まで|の)/;

/** A route step from a word that starts with a registered name, or null. */
export function stepFromWord(word, keys) {
  const w = norm(word);
  for (const { key, id } of keys) {
    if (!w.startsWith(key)) continue;
    const rest = w.slice(key.length).replace(UNIT_RE, '').replace(HONORIFIC_RE, '').replace(PARTICLE_RE, '');
    let kind = 'confirm';
    if (/依頼/.test(rest)) kind = 'request';
    else if (/返信|連絡/.test(rest)) kind = 'reply';
    const note = /^(?:確認|依頼|返信|連絡)?(?:する|して|します)?$/.test(rest) ? '' : rest;
    return { kind, whoId: id, note: clampText(note, NOTE_MAX) };
  }
  return null;
}

/** "来週" + "月曜" (split by a space or a comma) is read as one date word. */
function joinWeekWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = norm(words[i]);
    const next = i + 1 < words.length ? norm(words[i + 1]) : '';
    if (/^(?:今週|来週)の?$/.test(w) && /^[日月火水木金土](?:曜(?:日)?)?$/.test(next)) {
      out.push(words[i] + ' ' + words[i + 1]);
      i += 1;
    } else {
      out.push(words[i]);
    }
  }
  return out;
}

/**
 * "word#n" for each word (the n-th time the same word appears in the line): how a word the person turned back into
 * the title is remembered while the line is being edited.
 */
export function signatures(raws) {
  const seen = new Map();
  return raws.map((r) => {
    const n = (seen.get(r) || 0) + 1;
    seen.set(r, n);
    return r + '#' + n;
  });
}

/**
 * Split one line into classified tokens. opts.removed: signatures of words the person turned back into the title
 * (they stay in the title and leave the field to a later word).
 */
export function tokenize(text, opts) {
  const today = opts.today;
  const keys = personKeys(opts.people);
  const words = joinWeekWords(String(text || '').split(SPLIT_RE).filter(Boolean));
  const removed = opts.removed && opts.removed.size ? opts.removed : null;
  const sigs = removed ? signatures(words) : null;
  const tokens = [];
  const seen = { rank: false, due: false, duration: false };
  let steps = 0;

  for (let k = 0; k < words.length; k += 1) {
    const raw = words[k];
    if (removed && removed.has(sigs[k])) {
      tokens.push({ raw, type: 'title', value: null });
      continue;
    }
    const w = norm(raw).replace(/\s+/g, '');
    const up = w.toUpperCase();
    if (!seen.rank && /^[ABC]$/.test(up)) {
      seen.rank = true;
      tokens.push({ raw, type: 'rank', value: up });
      continue;
    }
    if (STAR_WORDS.has(w)) {
      tokens.push({ raw, type: 'star', value: true });
      continue;
    }
    if (!seen.duration && DURATION_WORDS.has(w)) {
      seen.duration = true;
      tokens.push({ raw, type: 'duration', value: DURATION_WORDS.get(w) });
      continue;
    }
    if (!seen.due) {
      const due = parseDateWord(w, today);
      if (due) {
        seen.due = true;
        tokens.push({ raw, type: 'due', value: due });
        continue;
      }
    }
    if (steps < ROUTE_MAX) {
      const step = stepFromWord(w, keys);
      if (step) {
        steps += 1;
        tokens.push({ raw, type: 'step', value: step });
        continue;
      }
    }
    tokens.push({ raw, type: 'title', value: null });
  }
  return tokens;
}

/** Build the task fields from tokens (the title is every token that was not understood). */
export function summarize(tokens, today) {
  const r = { title: '', due: null, rank: null, duration: null, star: false, steps: [], dueOtherYear: false, tokens };
  const titleParts = [];
  for (const t of tokens) {
    if (t.type === 'rank') r.rank = t.value;
    else if (t.type === 'star') r.star = true;
    else if (t.type === 'duration') r.duration = t.value;
    else if (t.type === 'due') r.due = t.value;
    else if (t.type === 'step') r.steps.push(t.value);
    else if (t.raw) titleParts.push(t.raw);
  }
  r.title = titleParts.join(' ').trim();
  r.dueOtherYear = Boolean(r.due && today && r.due.slice(0, 4) !== today.slice(0, 4));
  return r;
}

export function parseLine(text, opts) {
  return summarize(tokenize(text, opts), opts.today);
}

/** The user removed a chip: that word goes back into the title (synthetic chips just disappear). */
export function withTokenAsTitle(parsed, index, today) {
  const tokens = parsed.tokens
    .map((t, i) => (i === index ? (t.synthetic ? null : { raw: t.raw, type: 'title', value: null }) : t))
    .filter(Boolean);
  return summarize(tokens, today);
}

/** Add a suggested step (not typed by the user) to a parsed line. */
export function withSuggestedStep(parsed, step, today) {
  const tokens = parsed.tokens.concat([{ raw: '', type: 'step', value: step, synthetic: true }]);
  return summarize(tokens, today);
}

// What every new task needs besides its name (2026-10-27): chosen when it is added, not afterwards.
export const REQUIRED = Object.freeze([
  { key: 'due', label: '期日' },
  { key: 'rank', label: 'ランク' },
  { key: 'duration', label: '所要期間' },
]);

/** The labels of what is still missing, in that order (empty when the task can be added). */
export function missingFields(fields) {
  return REQUIRED.filter((f) => !fields || !fields[f.key]).map((f) => f.label);
}

/** The word written into the line for each duration (read back by the parser). */
export const DURATION_WORD = Object.freeze({ '1d': '1日', '3d': '3日', '1w': '1週間', '1m': '1ヶ月' });

/**
 * The word for a due date: M/D, or Y/M/D when M/D would be read as another day. Always the date itself (not 今日 /
 * 明日), so a line that waits past midnight keeps the day that was chosen. null for a date it cannot write.
 */
export function dueWord(ymd, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const short = Number(m[2]) + '/' + Number(m[3]);
  const word = parseDateWord(short, today) === ymd ? short : m[1] + '/' + Number(m[2]) + '/' + Number(m[3]);
  return parseDateWord(word, today) === ymd ? word : null;
}

/**
 * Where a button's word goes in the line (type: due / rank / duration): in place of the word read for that field, or
 * at the end. raws: the new words; from[k]: where word k was before (-1 for the button's word); index: the button's word.
 */
export function placeFieldWord(tokens, type, word) {
  const raws = tokens.map((t) => t.raw);
  const from = raws.map((_, k) => k);
  let index = tokens.findIndex((t) => t.type === type);
  if (index >= 0) {
    raws[index] = word;
  } else {
    index = raws.length;
    raws.push(word);
  }
  from[index] = -1;
  return { raws, from, index };
}

/** The line with one field chosen by a button: the word read for that field is replaced, or the word is added at the end. */
export function withFieldWord(text, type, word, opts) {
  return placeFieldWord(tokenize(text, opts), type, word).raws.join(' ');
}

/** Why this line cannot be added ('' when it can). */
export function lineError(parsed) {
  if (!parsed.title) return 'タスク名がありません（日付・ランク以外の言葉を入れてください）';
  const n = textLength(parsed.title);
  if (n > TITLE_MAX) return 'タスク名は' + TITLE_MAX + '字までです（いま' + n + '字）';
  return '';
}

// Bullets at the start of pasted lines: "- ", "・", "□", "1." and friends.
const BULLET_RE = /^\s*(?:[-*・•□☐■●◯○◆◇▪▫]\s*(?:\[[ xX]\]\s*)?|\[[ xX]\]\s*|[0-9０-９]+[.)．）、](?![0-9０-９])\s*|[①-⑳]\s*)/;

export function stripBullet(line) {
  return String(line).replace(BULLET_RE, '').trim();
}

/** Non-empty lines of a paste, bullets removed. */
export function pastedLines(text) {
  return String(text || '')
    .split(/\r\n|\r|\n/)
    .map(stripBullet)
    .filter((s) => s.length > 0);
}

export function parseBulk(text, opts) {
  return pastedLines(text).map((line) => {
    const parsed = parseLine(line, opts);
    return { line, parsed, error: lineError(parsed) };
  });
}
