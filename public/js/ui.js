// Sheets (centered on a PC, from the bottom on a phone), alerts, toasts and simple pickers.

import { h, icon, fill } from './dom.js';

const stack = [];
let seq = 0;

function layer() {
  return document.getElementById('layer');
}

export function isPhone() {
  return window.matchMedia('(max-width: 767.98px)').matches;
}

export function topOverlay() {
  return stack[stack.length - 1] || null;
}

export function overlayOpen() {
  return stack.length > 0;
}

function lockScroll() {
  document.documentElement.classList.toggle('has-overlay', stack.length > 0);
}

/**
 * opts: title, content, doneLabel / onDone (right button), cancelLabel / onCancel (left button, null = none),
 * onDismiss (backdrop / Esc; defaults to cancel), onClose, className
 * onDone / onCancel may return false to keep the sheet open.
 */
export function openSheet(opts) {
  seq += 1;
  const titleId = 'sheet-title-' + seq;
  const phone = isPhone();
  const returnFocus = document.activeElement;
  const api = {};

  const left = opts.cancelLabel === null
    ? h('span', { class: 'sheet-btn-space' })
    : h('button', { type: 'button', class: 'sheet-btn', onclick: () => api.cancel() }, opts.cancelLabel || 'キャンセル');
  const right = opts.onDone
    ? h('button', { type: 'button', class: 'sheet-btn strong', onclick: () => api.done() }, opts.doneLabel || '完了')
    : h('span', { class: 'sheet-btn-space' });
  const head = h('div', { class: 'sheet-head' }, left, h('h2', { class: 'sheet-title', id: titleId }, opts.title || ''), right);
  const body = h('div', { class: 'sheet-body' }, opts.content || null);
  const sheet = h('div', {
    class: 'sheet ' + (phone ? 'sheet-bottom' : 'sheet-center') + (opts.className ? ' ' + opts.className : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  }, phone ? h('div', { class: 'grabber', 'aria-hidden': 'true' }) : null, head, body);
  const backdrop = h('div', { class: 'backdrop', onclick: () => api.dismiss() });
  const wrap = h('div', { class: 'overlay' }, backdrop, sheet);

  let closed = false;
  Object.assign(api, {
    el: sheet,
    body,
    close() {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      wrap.classList.remove('open');
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 220);
      lockScroll();
      if (opts.onClose) opts.onClose();
      if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
        try { returnFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    },
    cancel() {
      if (opts.onCancel && opts.onCancel() === false) return;
      api.close();
    },
    done() {
      if (opts.onDone && opts.onDone() === false) return;
      api.close();
    },
    dismiss() {
      if (opts.onDismiss) {
        if (opts.onDismiss() === false) return;
        api.close();
        return;
      }
      api.cancel();
    },
    setContent(...nodes) {
      fill(body, ...nodes.flat());
    },
  });

  stack.push(api);
  layer().append(wrap);
  lockScroll();
  // Force a layout so the slide-in transition starts (works even when the tab is in the background).
  void wrap.offsetWidth;
  wrap.classList.add('open');
  return api;
}

/** Alert dialog. buttons: [{ label, value, style: 'cancel' | 'destructive' | 'default' }] -> Promise(value) */
export function alertDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const list = buttons && buttons.length ? buttons : [{ label: 'OK', value: true, style: 'default' }];
    const returnFocus = document.activeElement;
    const api = {};
    const btns = list.map((b) => h('button', {
      type: 'button',
      class: 'alert-btn' + (b.style ? ' ' + b.style : ''),
      onclick: () => api.finish(b.value),
    }, b.label));
    seq += 1;
    const titleId = 'alert-title-' + seq;
    const box = h('div', { class: 'alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'alert-text' },
        h('h2', { class: 'alert-title', id: titleId }, title || ''),
        message ? h('p', { class: 'alert-msg' }, message) : null),
      h('div', { class: 'alert-btns' + (btns.length > 2 ? ' vertical' : '') }, btns));
    const wrap = h('div', { class: 'overlay overlay-alert' }, h('div', { class: 'backdrop' }), box);
    let done = false;
    Object.assign(api, {
      finish(v) {
        if (done) return;
        done = true;
        const i = stack.indexOf(api);
        if (i >= 0) stack.splice(i, 1);
        wrap.remove();
        lockScroll();
        if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
          try { returnFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
        resolve(v);
      },
      dismiss() {
        const c = list.find((b) => b.style === 'cancel');
        api.finish(c ? c.value : undefined);
      },
      cancel() { api.dismiss(); },
    });
    stack.push(api);
    layer().append(wrap);
    lockScroll();
    void wrap.offsetWidth;
    wrap.classList.add('open');
    // When a button deletes or replaces something, Enter alone must not trigger it: start on the cancel button.
    const cancelBtn = btns.find((b) => b.classList.contains('cancel'));
    const primary = btns.find((b) => !b.classList.contains('cancel')) || btns[0];
    (list.some((b) => b.style === 'destructive') && cancelBtn ? cancelBtn : primary).focus();
  });
}

export function confirmDialog({ title, message, okLabel, cancelLabel, destructive }) {
  return alertDialog({
    title,
    message,
    buttons: [
      { label: cancelLabel || 'キャンセル', value: false, style: 'cancel' },
      { label: okLabel || 'OK', value: true, style: destructive ? 'destructive' : 'default' },
    ],
  });
}

/** Pick one option from a list. Resolves with the value, or undefined when cancelled. */
export function pickFrom({ title, options, current, note }) {
  return new Promise((resolve) => {
    let picked;
    const rows = options.map((o) => h('li', {},
      h('button', {
        type: 'button',
        class: 'menu-row',
        'aria-pressed': String(o.value === current),
        onclick: () => { picked = { v: o.value }; sheet.close(); },
      },
      h('span', { class: 'menu-check' }, o.value === current ? icon('check') : null),
      h('span', { class: 'menu-label' }, o.label),
      o.detail ? h('span', { class: 'menu-count' }, o.detail) : null)));
    const sheet = openSheet({
      title,
      className: 'sheet-small',
      content: [note ? h('p', { class: 'sheet-note' }, note) : null, h('ul', { class: 'card menu' }, rows)],
      onClose: () => resolve(picked ? picked.v : undefined),
    });
  });
}

// ---- Toast (one at a time, at the bottom) ----

let toastTimer = null;

export function toast(message, opts) {
  const o = opts || {};
  const host = document.getElementById('toast');
  clearTimeout(toastTimer);
  const parts = [h('span', { class: 'toast-msg' }, message)];
  if (o.actionLabel && o.onAction) {
    parts.push(h('button', {
      type: 'button',
      class: 'toast-act',
      onclick: () => { hideToast(); o.onAction(); },
    }, o.actionLabel));
  }
  fill(host, h('div', { class: 'toast-box' }, parts));
  host.classList.add('show');
  toastTimer = setTimeout(hideToast, o.duration || 3000);
}

export function hideToast() {
  const host = document.getElementById('toast');
  clearTimeout(toastTimer);
  host.classList.remove('show');
}

// Esc closes the top-most sheet or alert.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = topOverlay();
  if (!top) return;
  e.preventDefault();
  top.dismiss();
});
