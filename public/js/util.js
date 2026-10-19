// Small helpers shared by every module.
// No DOM access here, so the same code runs in the browser and in `node --test`.

export const WEEKDAYS = '日月火水木金土';

/** 'YYYY-MM-DD' of a Date, in local time. */
export function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Local-midnight Date from 'YYYY-MM-DD', or null when the string is not a real date. */
export function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  const d = new Date(y, mo, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
  return d;
}

export function isYmd(s) {
  return parseYmd(s) !== null;
}

/** Calendar date for (year, month 1-12, day), or null when it does not exist (e.g. 2/30). */
export function makeYmd(y, m, d) {
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return ymd(dt);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Whole days from a to b (b - a). Computed in UTC so daylight saving never shifts the result. */
export function diffDays(a, b) {
  const da = parseYmd(a);
  const db = parseYmd(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86400000);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(s) {
  return parseYmd(s).getDay();
}

/** Monday of the week that contains s (weeks start on Monday). */
export function mondayOf(s) {
  return addDays(s, -((weekday(s) + 6) % 7));
}

/** 'M/D(曜)'. The year is added in front when it differs from baseYear. */
export function fmtMD(s, baseYear) {
  const d = parseYmd(s);
  const md = (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAYS[d.getDay()] + ')';
  if (baseYear != null && d.getFullYear() !== baseYear) return d.getFullYear() + '/' + md;
  return md;
}

/** 'YYYY/M/D HH:MM' for an ISO timestamp (local time). */
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function todayStr(now) {
  return ymd(now || new Date());
}

let fallbackCounter = 0;

export function uid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  fallbackCounter += 1;
  return Date.now().toString(36) + '-' + fallbackCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Length in characters (code points), so emoji count as one. */
export function textLength(s) {
  return Array.from(String(s)).length;
}

/** Cut to max characters without breaking emoji in half. */
export function clampText(s, max) {
  const str = String(s == null ? '' : s);
  const chars = Array.from(str);
  return chars.length > max ? chars.slice(0, max).join('') : str;
}

export const URL_MAX = 2000;

/**
 * Only http:// and https:// links are kept.
 * Returns '' for empty input, the normalized URL when allowed, or null when rejected.
 */
export function cleanUrl(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return '';
  if (s.length > URL_MAX) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href;
}

export function isIsoTime(s) {
  return typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));
}
