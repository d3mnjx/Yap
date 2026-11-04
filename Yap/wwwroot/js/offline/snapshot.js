// What the device keeps for reading without a connection (OF-06, TL-02): the last bootstrap document and
// the last tail of each conversation the person opened. One record per conversation, written whole,
// never merged (offline-design-notes.md, "Reading"). A sign-out deletes everything (GEN-05, OF-16).
//
// The records follow the store: a message that arrives, a person who joins, a count that changes, all
// reach the disk a moment later, so an offline reload shows what the page last showed.

import * as db from './db.js';
import { state, on, atTail } from '../store.js';

const BOOTSTRAP = 'bootstrap';
const tail = key => `tail:${key}`;

// A conversation's key: the room id, or "dm:" and the partner, because a direct message has no id before it opens.
export const keyOf = open => open.partner ? `dm:${open.partner}` : open.channelId;

export async function saveBootstrap(doc) { await db.put(db.STORES.snapshots, { doc, at: Date.now() }, BOOTSTRAP); }

// The stored document, when it belongs to the account that is signed in (a different account starts empty). A copy
// from a build before 2026-10-31 has no emoji image rules and counts all the same: its paint draws emoji as text
// once, and the hub's bootstrap brings the rules. Treating it as no copy made main.js fetch, and offline the failed
// fetch read as "nobody signed in", which cleared the outbox and the drafts.
export async function loadBootstrap() {
  const row = await db.get(db.STORES.snapshots, BOOTSTRAP);
  return row?.doc?.user ? row.doc : null;
}

// The drafts, one per conversation, kept through a reload (IB-53, GEN-21).
export async function loadDrafts() { return (await db.get(db.STORES.kv, 'drafts')) ?? {}; }

// The tail only: a page of older messages is not stored (OF-14 keeps the promise modest). No emoji pictures with
// it: the builds of 2026-10-31 that stored them (Blobs, then data URLs) made every open jerk on the phone, because
// WebKit decodes a data URL again for each <img> that carries it, at each rebuild of the rows (offline-design-notes.md,
// "Reading"). A row's image carries its network URL, and the worker's cache answers it a frame or two after the text.
async function saveTail(key, conversation) {
  const messages = conversation.messages.slice(-50);
  await db.put(db.STORES.snapshots, { channelId: conversation.channelId, partner: conversation.partner ?? null, messages, hasMore: conversation.hasMore && messages.length === conversation.messages.length, restricted: conversation.restricted, typists: [], pins: conversation.pins ?? [], at: Date.now() }, tail(key));
}

export async function loadTail(key) {
  const row = await db.get(db.STORES.snapshots, tail(key));
  return row ?? null;
}

export async function clearAll() {
  await db.clear(db.STORES.snapshots);
  await db.clear(db.STORES.outbox);
  await db.clear(db.STORES.kv);
}

// ---- following the store ----

let tailTimer = 0, bootTimer = 0, draftTimer = 0;

function queueTail() {
  clearTimeout(tailTimer);
  // the empty placeholder shown while the first answer loads (TL-02) must not replace a stored tail, and neither must a
  // window after a jump (OF-14, TL-41): the stored copy is always the newest messages
  tailTimer = setTimeout(() => { if (state.open?.messages && !state.open.loading && atTail()) saveTail(keyOf(state.open), state.open); }, 800);
}

// The bootstrap document, rebuilt from the store: the same shape the server sends.
function docFromState() {
  const { user, config, texts, rooms, users, presence, dms, unread, mutes, emoji, favoriteGifIds, emojiImages } = state;
  if (!user) return null;
  return { user, config, texts, rooms, users: Object.values(users), presence, dms, unread, mutes, emoji, favoriteGifIds: [...favoriteGifIds], emojiImages };
}

function queueBootstrap() {
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => { const doc = docFromState(); if (doc) saveBootstrap(doc); }, 2000);
}

on('messages', queueTail);
on('drafts', () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => db.put(db.STORES.kv, { ...state.drafts }, 'drafts'), 500); });
for (const part of ['users', 'presence', 'rooms', 'dms', 'unread', 'mutes', 'emoji', 'favoriteGifIds', 'emojiImages']) on(part, queueBootstrap);
