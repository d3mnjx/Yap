// Recent emoji of the account (PK-07): one path for a picker tap, a sent message and an edit.
//
// Keeps unsent uses under 'pendingEmoji' in IndexedDB kv. offline-design-notes.md ("No operation queue") rules out
// general operation queues; this list is a safe exception because moving an emoji to the front is idempotent —
// sending the list twice gives the same Recent row, with no operation id and no conflict rule.

import * as store from './store.js';
import * as hub from './hub.js';
import * as db from './offline/db.js';
import { extractPickerEmojis } from './render/text.js';

const PENDING_KEY = 'pendingEmoji';
let pendingEmojis = [];
let flushing = false;

store.on('user', () => { if (!store.state.user) pendingEmojis = []; });

// Runs beside GET /api/bootstrap on every connect (hub.js:132-135), so a pending flush adds no round trip.
// Resets ownEmojiUses synchronously first: uses from an earlier session are on the server already, while
// pendingEmojis (and anything added while bootstrap is in flight) stays protected in store.applyBootstrap.
hub.onConnected(() => {
  store.setOwnEmojiUses(pendingEmojis);
  return flushPendingEmojis();
});

async function flushPendingEmojis() {
  if (flushing || !pendingEmojis.length || !hub.connected()) return;
  flushing = true;
  const batch = pendingEmojis;
  const result = await hub.invoke('emojisUsed', batch);   // returns { error }, never throws
  flushing = false;
  if (result?.error || !store.state.user) return;         // stays in pendingEmojis for the next connect
  if (pendingEmojis === batch) { pendingEmojis = []; db.del(db.STORES.kv, PENDING_KEY); }
  else flushPendingEmojis();                              // a use arrived during the call: send the newer list
}

// Called from picker click, composer send() and message edit: catches its own errors so it can never abort a send or tap.
export function recordEmojis(emojis) {
  try {
    const list = store.compactEmojis(emojis);
    if (!store.state.user || !list.length) return;
    const changed = store.recordRecentEmojis(list);
    // When the page's list did not change and nothing waits for the server, the server already has this order:
    // sending a message right after picking its emoji in the picker sends nothing a second time.
    if (!changed && store.state.emoji && !pendingEmojis.length) return;
    pendingEmojis = store.compactEmojis([...pendingEmojis, ...list]);
    db.put(db.STORES.kv, pendingEmojis, PENDING_KEY);     // db.js resolves null on failure and never rejects
    flushPendingEmojis();
  } catch (e) { console.warn('recordEmojis', e); }
}

export async function recordTextEmojis(text) {
  try {
    const emojis = await extractPickerEmojis(text);
    if (emojis.length) recordEmojis(emojis);
  } catch (e) { console.warn('recordTextEmojis', e); }
}

export async function recordEditedEmojis(before, after) {
  try {
    const next = await extractPickerEmojis(after);
    if (!next.length) return;
    const had = new Set(await extractPickerEmojis(before));
    const added = next.filter(e => !had.has(e));
    if (added.length) recordEmojis(added);
  } catch (e) { console.warn('recordEditedEmojis', e); }
}

// Called once by main.js after applyBootstrap of the stored copy, rather than in hub.connect(), so reconnect
// retries never wait on disk and no await stands between connect()'s state check and connection.start().
export async function restorePendingEmojis() {
  try {
    const stored = await db.get(db.STORES.kv, PENDING_KEY);
    if (!Array.isArray(stored) || !stored.length || !store.state.user) return;
    pendingEmojis = store.compactEmojis([...stored, ...pendingEmojis]);
    store.recordRecentEmojis(pendingEmojis);              // also adds them to ownEmojiUses if connect() started already
    flushPendingEmojis();                                 // connect() may have finished while db.get was in flight
  } catch (e) { console.warn('restorePendingEmojis', e); }
}
