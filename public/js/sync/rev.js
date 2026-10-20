// Versions of one item (a task, a memo, ...), linked like a family tree.
// A version is named "generation-fingerprint": the fingerprint comes from the item key, the parent versions
// and the content, so the same change made twice (sent twice, or made on two devices) gets the same name
// and is counted once. Nothing here talks to the network; it runs the same in the browser and in Node.

/** JSON with the keys of every object sorted, so the same content always gives the same text. */
export function canonical(v) {
  if (v === undefined || v === null || typeof v === 'function') return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** A quick 53-bit hash (not for security): tells whether an item still has the content it had. */
export function fastHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function contentHash(content) {
  return fastHash(canonical(content));
}

const HEX = [];
for (let i = 0; i < 256; i += 1) HEX.push(i.toString(16).padStart(2, '0'));

/** SHA-256 of a text (UTF-8) as 64 hex characters (the browser's own WebCrypto, also in Node 20+). */
export async function sha256hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i += 1) out += HEX[b[i]];
  return out;
}

export const FP_LENGTH = 16;
const NAME_RE = /^([1-9]\d{0,8})-([0-9a-f]{16})$/;

export function isVersionName(s) {
  return typeof s === 'string' && NAME_RE.test(s);
}

/** { gen, fp } of "3-9f2c...", or null. */
export function parseVersion(name) {
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null;
  return m ? { gen: Number(m[1]), fp: m[2] } : null;
}

export function genOf(name) {
  const p = parseVersion(name);
  return p ? p.gen : 0;
}

/** Versions in the order "smaller first": generation as a number, then the fingerprint. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.gen !== pb.gen) return pa.gen - pb.gen;
  return pa.fp < pb.fp ? -1 : pa.fp > pb.fp ? 1 : 0;
}

/** Parents sorted and without repeats (the order never changes the name). */
export function normParents(parents) {
  return [...new Set(parents || [])].sort(compareVersions);
}

/** New item = 1; otherwise one more than the largest generation of the parents. */
export function nextGen(parents) {
  let g = 0;
  for (const p of parents || []) g = Math.max(g, genOf(p));
  return g + 1;
}

export async function fingerprint(key, parents, content) {
  return (await sha256hex(canonical([key, normParents(parents), content]))).slice(0, FP_LENGTH);
}

/** The name of a new version: "generation-fingerprint". */
export async function versionName(key, parents, content) {
  const ps = normParents(parents);
  return nextGen(ps) + '-' + (await fingerprint(key, ps, content));
}

/** Does the name match the key, the parents and the content (a row changed by hand does not)? */
export async function checkVersion(key, name, parents, content) {
  const p = parseVersion(name);
  if (!p) return false;
  const ps = normParents(parents);
  if (ps.length !== (parents || []).length) return false;
  if (!ps.every(isVersionName)) return false;
  if (p.gen !== nextGen(ps)) return false;
  return p.fp === (await fingerprint(key, ps, content));
}

// ---- the family tree of one item ----
// versions: { [name]: { p: [parent names], c: content, ... } }  (only the versions this device knows)

/** Versions that are nobody's parent: the current ends. Sorted (smaller first). */
export function tips(versions) {
  const names = Object.keys(versions);
  const used = new Set();
  for (const n of names) for (const p of versions[n].p || []) used.add(p);
  return names.filter((n) => !used.has(n)).sort(compareVersions);
}

/** Every known version reachable through the parents (the version itself not included). */
export function ancestors(versions, name) {
  const out = new Set();
  const stack = [...((versions[name] && versions[name].p) || [])];
  while (stack.length) {
    const n = stack.pop();
    if (out.has(n) || !versions[n]) continue;
    out.add(n);
    for (const p of versions[n].p || []) stack.push(p);
  }
  return out;
}

export function isAncestor(versions, older, newer) {
  return ancestors(versions, newer).has(older);
}

/**
 * The version to compare both sides with ("before the two changes"), or null (= empty) when they share none.
 * With several equally low common ancestors (two devices resolved the same question in different ways),
 * their own common ancestor is used, so that the different answers are compared and asked again.
 */
export function mergeBase(versions, a, b) {
  const ancA = ancestors(versions, a);
  ancA.add(a);
  const ancB = ancestors(versions, b);
  ancB.add(b);
  const common = [...ancA].filter((x) => ancB.has(x) && versions[x]);
  if (!common.length) return null;
  const anc = new Map(common.map((x) => [x, ancestors(versions, x)]));
  const lowest = common.filter((x) => !common.some((y) => y !== x && anc.get(y).has(x))).sort(compareVersions);
  let base = lowest[0];
  for (let i = 1; i < lowest.length && base; i += 1) base = mergeBase(versions, base, lowest[i]);
  return base || null;
}
