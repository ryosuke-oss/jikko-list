// The app's line of writes (S.queue): the person's saves and the sync's writes, one at a time, in order.
// Kept apart from app.js so that the order can be tested without a screen (tests/savequeue.test.js).
// S: { queue: Promise, waiting: number, data, rev } (app.js's state object).
// A step that fails never stops the line: the next one runs anyway (each step runs after the one before it,
// whatever its outcome), and the line itself never ends in an error.

import { ConflictError } from './store.js';

/** Run fn after everything queued before it. Returns fn's own result (or error); the line goes on either way. */
export function queueRun(S, fn) {
  const p = S.queue.then(fn, fn);
  S.queue = p.then(() => true, () => false);
  return p;
}

/**
 * Queue a save of the given keys: the data of this moment is written after everything queued before it. When the
 * app's data was replaced meanwhile (another tab's change was read), nothing is written.
 * io: { write(data, keys, rev) -> rev, saved(rev), stale(), conflict(), failed(error) }.
 * Resolves to true when it was written (never rejects).
 */
export function queueSave(S, keys, io) {
  const data = S.data;
  S.waiting += 1;
  const run = async () => {
    S.waiting -= 1;
    if (data !== S.data) {
      io.stale();
      return false;
    }
    try {
      const rev = await io.write(data, keys, S.rev);
      S.rev = rev;
      io.saved(rev);
      return true;
    } catch (e) {
      try {
        if (e instanceof ConflictError) await io.conflict();
        else io.failed(e);
      } catch (e2) {
        console.error(e2);
      }
      return false;
    }
  };
  S.queue = S.queue.then(run, run);
  return S.queue;
}

/**
 * The sync's write (data and sync records in one transaction) in the same line. The person's own changes go first:
 * when a save is waiting behind it, or something is typed and not queued yet, or the data on the screen is not
 * the one the sync started from, the write is refused (ConflictError: the sync reads again and tries again).
 * From the moment the write starts, the new data is the app's data, so whatever the person does meanwhile lands
 * in it and is saved right after. When the write fails (rare: a full disk...), the data before it comes back: the
 * new data may hold a question's content for the time being, which must never be saved without the sync's
 * records (it would be sent as this device's choice). A save of the person made during that moment is then not
 * written, and they are told (io.stale) to do it again.
 * hooks: { typing(), flushTyping(), after(rev) }.
 */
export function queueCommit(S, data, expectedRev, write, hooks) {
  hooks.flushTyping();
  return queueRun(S, async () => {
    if (S.waiting > 0 || hooks.typing() || S.rev !== expectedRev) throw new ConflictError('the app has changes waiting');
    const before = S.data;
    S.data = data;
    let rev;
    try {
      rev = await write();
    } catch (e) {
      if (S.data === data) S.data = before;
      throw e;
    }
    S.rev = rev;
    hooks.after(rev);
    return rev;
  });
}
