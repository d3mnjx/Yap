// The outbox on disk (offline-design-notes.md, "The outbox"): one IndexedDB row per unsent message, with
// the picked files as Blobs until the message is sent. sender.js owns the rows in memory and mirrors every
// change here, so the next open tab sends what this one could not (OF-08, OF-10).

import * as db from './db.js';

// Only data goes to disk: no functions, no DOM, no upload handles. A direct message is addressed by its
// partner; its channelId is null when the conversation was never opened on the device (OF-08).
function serialisable(row) {
  const { id, clientId, channelId, partner, username, text, timestamp, replyToId, replyTo, files, images, videos, gifs, voice, failed, queuedAt } = row;
  // A voice row's `src` is a Blob URL of this page while the file is not uploaded: sender.js makes a new one on load.
  return { id, clientId, channelId, partner, username, text, timestamp, replyToId, replyTo, files: files ?? [], images, videos, gifs,
           voice: voice ? { durationMs: voice.durationMs, peaks: voice.peaks, url: voice.url ?? null } : null, failed, queuedAt };
}

export const save = row => db.put(db.STORES.outbox, serialisable(row));
export const remove = row => Promise.all([db.del(db.STORES.outbox, row.clientId), db.del(db.STORES.kv, uploadsKey(row))]);
export const clear = () => db.clear(db.STORES.outbox);   // the upload states go with the key-value store (snapshot.js clearAll, at the same sign-out)

// How far the files of a row are: for each file, in the order of row.files, { url, info, error } (sender.js). It is
// a record of its own, not a field of the row: IndexedDB writes a record whole, and a save of the row after every
// file would write the row's Blobs again each time, up to a gigabyte for one message.
const uploadsKey = row => `upload:${row.clientId}`;
export const saveUploads = (row, parts) => db.put(db.STORES.kv, parts, uploadsKey(row));
export const loadUploads = row => db.get(db.STORES.kv, uploadsKey(row));

// The rows of this device, oldest first, as plain data; sender.js turns them into pending rows again.
export async function loadAll() {
  const rows = (await db.getAll(db.STORES.outbox)) ?? [];
  return rows.sort((a, b) => a.queuedAt - b.queuedAt);
}

// A cross-tab note: another tab changed the outbox (the Web Lock makes one tab the sender).
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('yap-outbox') : null;
export function announce() { channel?.postMessage('changed'); }
export function onChange(fn) { channel?.addEventListener('message', () => fn()); }
