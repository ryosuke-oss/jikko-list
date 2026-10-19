// Building the page with createElement / textContent only.
// innerHTML is never used, so nothing the user types can turn into markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Set as DOM properties; everything else becomes an attribute.
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'indeterminate']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === 'class') el.className = v;
      else if (key === 'text') el.textContent = v;
      else if (key === 'dataset') Object.assign(el.dataset, v);
      else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
      else if (PROPS.has(key)) el[key] = v;
      else el.setAttribute(key, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace the children (null / false are skipped, arrays are flattened). */
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** A line icon (Tabler Icons, drawn with a CSS mask so it takes the text color). */
export function icon(name, extra) {
  return h('span', { class: 'i i-' + name + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
}

function svgNode(tag, attrs, kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs || {})) el.setAttribute(k, String(attrs[k]));
  if (kids) for (const [t, a, k] of kids) el.append(svgNode(t, a, k));
  return el;
}

/** Draw [tag, attrs, children] shape lists as an inline SVG. */
export function shapesSvg(shapes, viewBox, cls) {
  const svg = svgNode('svg', { viewBox, class: cls || '', 'aria-hidden': 'true', focusable: 'false' });
  for (const [t, a, k] of shapes) svg.append(svgNode(t, a, k));
  return svg;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => {
    if (timer) { clearTimeout(timer); timer = null; fn(...args); }
  };
  return wrapped;
}

/** Enter that is not the IME confirming a Japanese conversion. */
export function isPlainEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey;
}
