// The outbox of this device: the messages the person sent that the server has not accepted yet. A send
// appears at once as a pending row (IB-24, MR-69) and is posted when the connection allows; a refusal makes
// the row a failed row with Retry and Remove (IB-26, MR-71). The rows live in memory and on disk
// (offline/outbox.js), so a closed tab's messages go out from the next open one (OF-08, OF-10).
//
// Two things run, both driven by events, never by a timer (offline-design-notes.md). The uploads: the files of
// the rows, oldest row first, a few at one time (SLOTS). The post loop: the oldest row that is ready, one POST at
// a time. A row with files is ready when its last file is done, so a text sent after a video does not wait for
// the video (IB-28). A network error stops both until a wake-up; a refusal marks the row failed. A Web Lock makes
// one tab the sender: the other tabs show the rows, and upload and post nothing.
//
// A wake-up during a run marks the run to go again when it ends. An upload whose socket died with the network
// may never report (the phone's Wi-Fi went away mid-upload): a wake-up gives up an upload with no progress for a
// few seconds, and the file goes on from the bytes the server has (OF-10).

import { state, changed, setPending, addMessage, on, hasMedia } from './store.js';
import { api, ApiError, away } from './api.js';
import * as hub from './hub.js';
import * as outbox from './offline/outbox.js';
import { keyOf } from './offline/snapshot.js';
import * as upload from './upload.js';

const DAY = 86_400_000;
const STALL_MS = 5000;   // no byte and no poll for this long when a wake-up comes: the socket is dead
// Files that upload at one time, over all rows and conversations. A browser opens six connections to one host over
// HTTP/1.1: with every file of every row at once, a slow up-link fills all six with upload chunks, and the POST of
// a text message waits for one of them, the very wait the post loop no longer has. Three leaves room for the POST
// and for the pictures the timeline loads.
const SLOTS = 3;
let queue = [];        // every pending row, all conversations, oldest first
let posting = false;
let again = false;     // a wake-up came during a run
const running = new Set();   // the parts whose file uploads now
// Nobody answered an upload: no upload starts until a wake-up, a send or a Retry. Without this the end of that
// upload would start the same file again at once, a retry loop every nine seconds against a server that is down,
// which is the timer this design does not have.
let paused = false;
let holder = !navigator.locks;   // without Web Locks every tab posts; the server's clientId dedupe copes
let loaded = null;

// A row names its conversation like the snapshots do: a room by its id, a direct message by its partner. A
// direct message that was never opened on the device has no channel id until the server answers (OF-08).
function rowsOf(key) { return queue.filter(r => keyOf(r) === key); }
function publish(row, detail) {
  if (row) outbox.save(row).then(() => outbox.announce());
  setPending(state.open ? rowsOf(keyOf(state.open)) : [], detail);
}

function quoteOf(id) {
  const m = state.open?.messages.find(x => x.id === id);
  return m ? { id, username: m.username, text: m.text, hasMedia: hasMedia(m), voice: !!m.voice } : { id, unavailable: true };
}

// One GIF of a pending row: the fields the row renderer draws, plus what the server needs to resolve the
// GIF (an entry of the library, or a provider item and the search text that becomes its tag, PK-20).
function gifEntry(pick) {
  return { entryId: pick.entryId ?? null, src: pick.preview ?? null, isImage: pick.isImage ?? true, width: pick.width ?? 0, height: pick.height ?? 0, uploader: null,
           provider: pick.provider ?? null, searchText: pick.searchText ?? null };
}
const gifRequest = g => g.entryId ? { entryId: g.entryId, searchText: g.searchText } : { provider: g.provider, searchText: g.searchText };

// A row with files has `parts`, one for each file in the order of row.files: how far that file is.
//   state  'waiting' (for a slot, or for a wake-up), 'uploading', 'done', 'failed' (the server refused the file)
//   url    the upload URL the server gave: a later try goes on from the bytes it has
//   info   the server's result for the processed file;  error  the refusal, as a line for the person
//   sent   the bytes the server has, for the bar;  at  the last sign of life;  job  the upload in flight
// url, info and error are also on disk (outbox.saveUploads), so a reload or a restart sends no finished file
// again. row.files keeps every Blob until the row leaves: the thumbnails draw from them, and the record on disk
// names the files by their place in that list.
function partsOf(files, saved = null) {
  return files.map((file, i) => {
    const { url = null, info = null, error = null } = saved?.[i] ?? {};
    return { url, info, error, state: info ? 'done' : error ? 'failed' : 'waiting', sent: info ? file.size : 0, at: 0, job: null };
  });
}
const settled = row => row.parts.every(p => p.state === 'done' || p.state === 'failed');
const expired = row => Date.now() - row.queuedAt > DAY;   // MR-71, OF-11

function saveParts(row) {
  // A row that left (removed, sent, or the person signed out) saves nothing: an upload that ends after a sign-out
  // must not write its record back into the store the sign-out emptied (GEN-05).
  if (!queue.includes(row)) return Promise.resolve();
  return outbox.saveUploads(row, row.parts.map(({ url, info, error }) => ({ url, info, error })));
}

// The Blob URLs of a row's files, for the thumbnails of its pending row (IB-34): made once for a row, kept over a
// reload of the outbox (ready), and revoked when the row leaves.
export function thumbsOf(row) { return row.thumbs ??= row.files.map(f => URL.createObjectURL(f)); }
function forget(row) {
  row.thumbs?.forEach(url => URL.revokeObjectURL(url));
  if (row.voice?.src?.startsWith('blob:')) URL.revokeObjectURL(row.voice.src);
}

// Stops the upload of one part and keeps what the server has, or with `discard` deletes it there (IB-34).
function halt(part, discard) {
  part.job.abort(discard);
  part.job = null;   // start() ignores the end of a job that is no longer the part's
  running.delete(part);
  part.state = 'waiting';
}
function stop(row, discard) { for (const part of row.parts ?? []) if (part.job) halt(part, discard); }

// A pending row has the shape of a message plus pending, failed, files and parts, so the row renderer draws
// both. `files` are the picked Blobs (OF-08). A voice message is the one file plus `voice` { durationMs, peaks };
// its `src` is the Blob's URL while the row is pending (IB-70).
function newRow({ channelId = null, partner = null, text = '', replyToId = null, files = [], gif = null, voice = null }) {
  return {
    id: crypto.randomUUID(), clientId: crypto.randomUUID(), channelId, partner,
    username: state.user.username, text, timestamp: new Date().toISOString(), edited: false,
    replyTo: replyToId ? quoteOf(replyToId) : null, replyToId,
    files, parts: files.length ? partsOf(files) : null,
    images: [], videos: [], gifs: gif ? [gifEntry(gif)] : [], voice: voice ? { ...voice, url: null, src: URL.createObjectURL(files[0]) } : null, reactions: [], previews: [],
    pending: true, failed: null, queuedAt: Date.now(),
  };
}

export function queueMessage(message) {
  const row = newRow(message);
  queue.push(row);
  paused = false;   // a send is a wake-up (offline-design-notes.md)
  // 'queued' moves the timeline to the bottom, for a send only (TL-14) and only for a send into the open conversation:
  // an uploaded GIF may go to a conversation that the person left during the upload (composer.js gifUpload, PK-41).
  publish(row, state.open && keyOf(row) === keyOf(state.open) ? { type: 'queued' } : undefined);
  flush();
  return row;
}

export function remove(row) {
  stop(row, true);
  queue = queue.filter(r => r !== row);
  outbox.remove(row).then(() => outbox.announce());
  forget(row);
  publish();
  flush();   // the slots of a cancelled upload go to the files that wait
}

export function retry(row) {
  row.failed = null; row.queuedAt = Date.now();
  for (const part of row.parts ?? []) if (part.state === 'failed') Object.assign(part, { state: 'waiting', error: null, url: null, sent: 0 });
  paused = false;
  // The parts go to disk before the row: the tab that sends reads both at the announce, and a row that is no
  // longer failed beside parts that still are would fail again at once.
  (row.parts ? saveParts(row) : Promise.resolve()).then(() => outbox.save(row)).then(() => outbox.announce());
  publish();
  flush();
}

// Edit on a pending text row acts on the device (MR-72). A failed row goes again with the corrected text:
// the refusal was about the text, so the old reason no longer applies (U02 of the 2026-10-15 user test).
export function edit(row, text) { row.text = text; if (row.failed) retry(row); else publish(row); }

function fail(row, reason) {
  if (!queue.includes(row)) return;   // removed meanwhile: nothing goes back to disk
  stop(row, false);   // a row that waited a day: what the server has stays for a Retry
  row.failed = reason;
  publish(row);
}

// What the POST carries of a row's media: what the row has already (a GIF from the picker, and the files a build
// before the parts had uploaded) and then the results of its files, in the order of the pick.
function mediaOf(row) {
  const images = [...row.images], videos = [...row.videos], gifs = row.gifs.map(gifRequest);
  let voice = row.voice?.url ? row.voice : null;
  for (const { info } of row.parts ?? []) {
    if (!info) continue;
    if (info.type === 'gif') gifs.push({ entryId: info.gifEntryId, searchText: null });   // every GIF of the pick, one message (IB-33)
    else if (info.type === 'video') videos.push(info.url);
    else if (info.type === 'voice') voice = { ...row.voice, url: info.url, durationMs: info.durationMs };   // the file's own length, read by the server
    else images.push(info.url);
  }
  return { images: images.length ? images : null, videos: videos.length ? videos : null, gifs: gifs.length ? gifs : null,
           voice: voice ? { url: voice.url, durationMs: voice.durationMs, peaks: voice.peaks } : null };
}

// The message went out without the files the server refused. They stay behind as a failed row of their own: the
// person sees which files did not go, in their conversation, in every tab and after a restart, and Retry sends
// them. A new clientId: the server has the old one for the message that went out.
function keepRefused(row) {
  const left = newRow({ channelId: row.channelId, partner: row.partner, files: row.files.filter((f, i) => row.parts[i].error) });
  left.failed = row.parts.filter(p => p.error).map(p => p.error).join('\n');
  queue.push(left);
  publish(left);
}

// Something changed: the files that wait may start, and the rows that are ready may go. The uploads do not wait
// for a POST in flight, and the POSTs do not wait for an upload.
function flush() {
  if (!holder) return;
  ready().then(pump);
  post();
}

// One post at a time, the rows that are ready in their order (IB-28, OF-10). A network error keeps the row
// pending; a refusal marks it failed.
async function post() {
  if (posting) { again = true; return; }
  posting = true;
  try {
    await ready();
    for (const row of [...queue]) {
      if (!holder) break;   // the lock went to another tab mid-run (yieldLock): the rest is its to post
      if (row.failed || !queue.includes(row)) continue;
      if (expired(row)) { fail(row, 'Waited more than a day'); continue; }
      if (!navigator.onLine) break;
      if (row.parts) {
        if (!settled(row)) continue;   // its files still upload: the rows behind it go first, and it goes when its last file is done
        if (!row.parts.some(p => p.info)) { fail(row, row.parts.map(p => p.error).join('\n')); continue; }   // every file refused: Retry sends them again, and a voice row has nothing else to send
      }
      try {
        // A direct message goes by its partner, so the server finds or creates the channel (message-path.md).
        const url = row.partner ? `/api/dm/${encodeURIComponent(row.partner)}/messages` : `/api/channels/${row.channelId}/messages`;
        const message = await api.post(url, { clientId: row.clientId, text: row.text || null, replyToId: row.replyToId, ...mediaOf(row) });
        queue = queue.filter(r => r !== row);
        await outbox.remove(row);
        if (row.parts?.some(p => p.error)) keepRefused(row);
        outbox.announce();
        addMessage(message);                 // the POST answer and the hub event are the same confirmation
        forget(row);
        if (row.tappedAt) hub.report('send', performance.now() - row.tappedAt);   // AD-26: tap to own row rendered; a tap of this tab only
        publish();
      } catch (e) {
        // No network, a proxy that answers for a server that restarts, or the first copy is still being stored:
        // the row waits for the next wake-up. A failed row here would ask the person to press Retry after each deploy.
        if (e instanceof ApiError && (e.status === 0 || e.status === 409 || away(e.status))) break;
        fail(row, e instanceof ApiError ? e.message : 'Could not send');
      }
    }
  } finally { posting = false; if (again) { again = false; post(); } }
}

// The connection is back, or the tab is visible again. An upload with no sign of life for a while is on a dead
// socket: the browser may never report it. It is given up, and the run that follows takes it up again.
function wake() {
  for (const row of queue) for (const part of row.parts ?? []) {
    if (!part.job || Date.now() - part.at <= STALL_MS) continue;
    halt(part, false);
    changed('upload', row);   // without a network the pump starts nothing, and the square would stay "uploading"
  }
  paused = false;
  flush();
}

// Starts the files that wait, oldest row first and in the order of the pick, while a slot is free.
function pump() {
  if (!holder || paused || !navigator.onLine) return;
  for (const row of queue) {
    if (row.failed || !row.parts || expired(row)) continue;
    for (const part of row.parts) {
      if (running.size >= SLOTS) return;
      if (part.state === 'waiting') start(row, part);
    }
  }
}

function start(row, part) {
  const job = upload.uploadFile(row.files[row.parts.indexOf(part)], state.config?.uploadUrl || '/api/tus', {
    metadata: row.voice ? { kind: 'voice' } : {},   // the server transcodes a voice recording instead of sorting it by extension
    url: part.url,
    onUrl: url => {
      if (part.job !== job || url === part.url) return;
      part.url = url;
      if (!url) part.sent = 0;   // the server lost the upload: the file goes from zero
      saveParts(row);
    },
    onProgress: bytes => {   // none comes after an abort (upload.js), so this is still the part's job
      if (bytes !== null) part.sent = bytes;
      part.at = Date.now();
      changed('upload', row);
    },
  });
  Object.assign(part, { state: 'uploading', job, at: Date.now() });
  running.add(part);
  changed('upload', row);
  job.promise.then(outcome => { if (part.job === job) ended(row, part, outcome); });   // not the part's job any more: halt() took it
}

// A file is done, refused, or nobody answered. A file with no answer waits, with its URL and its bar: the browser
// can be online while the server is down, and that is a wait, not a failure (OF-08), the same as for a text send.
function ended(row, part, outcome) {
  running.delete(part);
  part.job = null;
  if (outcome.retry) { part.state = 'waiting'; paused = true; changed('upload', row); return; }
  paused = false;   // the server answered: the files that waited for it can go
  if (outcome.info) Object.assign(part, { state: 'done', info: outcome.info, url: null });
  else Object.assign(part, { state: 'failed', error: outcome.error, url: null });
  saveParts(row).then(() => outbox.announce());   // the other tabs draw the file as done
  changed('upload', row);
  flush();   // the slot goes to the next file, and a row whose last file this was is posted
}

// The rows on disk become the rows in memory (OF-08): a reload, or a change in another tab. A row this tab
// is uploading keeps its uploads; a row older than a day is failed (OF-11).
function ready() {
  loaded ??= outbox.loadAll().then(async rows => {
    const saved = await Promise.all(rows.map(r => r.files?.length ? outbox.loadUploads(r) : null));
    const mine = new Map(queue.map(r => [r.clientId, r]));
    const next = rows.map((r, i) => {
      const live = mine.get(r.clientId);
      if (live?.parts?.some(p => p.job)) return live;   // mid-upload here: the disk copy is older
      return { ...r, edited: false, gifs: r.gifs ?? [], reactions: [], previews: [], pending: true,
        tappedAt: live?.tappedAt, thumbs: live?.thumbs,
        // A row of a build before the parts has only the files that were not done, and no record: they all wait.
        parts: r.files?.length ? partsOf(r.files, saved[i]) : null,
        // a voice row plays its file once uploaded, else the Blob it still holds (the disk keeps no Blob URL)
        voice: r.voice ? { ...r.voice, src: r.voice.url ?? live?.voice?.src ?? (r.files?.[0] ? URL.createObjectURL(r.files[0]) : null) } : null,
        failed: r.failed ?? (expired(r) ? 'Waited more than a day' : null) };
    });
    for (const old of queue) if (!next.some(r => r.clientId === old.clientId)) { stop(old, true); forget(old); }   // another tab removed it
    queue = next.sort((a, b) => a.queuedAt - b.queuedAt);
    publish();
  }).catch(() => {});
  return loaded;
}

// Another tab changed the outbox: this tab reads it again; the holder posts what is new.
outbox.onChange(() => { if (state.updateAvailable) yieldLock(); loaded = null; ready().then(flush); });

// The lock: one tab posts at a time (offline-design-notes.md, "Tabs"). The holder keeps it until it closes, with
// one exception. A tab on an old build (the notice of SH-20 shows) does not know what a newer tab's row carries:
// on 2026-10-18 an old sender uploaded a new composer's voice recording as a plain file, and the memo arrived as
// a video. So an old tab leaves the line and joins it again at the back, at the notice and at every change of
// the outbox: a current tab, if one waits, posts instead; with no other tab the old one gets the lock back at
// once and keeps sending (OF-17).
let release = null;
function requestLock() {
  navigator.locks.request('yap-outbox-sender', { mode: 'exclusive' }, () => new Promise(resolve => {
    holder = true; release = resolve; paused = false;
    // The rows in memory are as old as the last announce, and the tab that sent before does not announce an upload
    // URL it saved. Without a fresh read this tab would send a half-uploaded file from zero.
    loaded = null;
    flush();
  }));
}
function yieldLock() {
  if (!holder || !release) return;   // not the holder, or no Web Locks: nothing to hand over
  holder = false; release(); release = null;
  // The uploads in flight stop here and keep what the server has: the tab that gets the lock goes on with them,
  // and two tabs never send the same file.
  for (const part of [...running]) halt(part, false);
  publish();
  requestLock();
}
if (navigator.locks) requestLock();
on('connection', () => { if (state.updateAvailable) yieldLock(); });   // setUpdateAvailable announces on this event (SH-17)

hub.onConnected(wake);                                     // what queued while offline goes out (OF-10)
addEventListener('online', wake);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });

export function showFor(key) { ready().then(() => setPending(rowsOf(key))); }
export const hasQueued = () => queue.length > 0;   // the sign-out confirmation (SH-15)

// A sign-out empties the outbox (GEN-05, OF-16).
export async function clearAll() {
  for (const row of queue) { stop(row, true); forget(row); }   // an upload must not go on, or end, under the next account
  queue = []; loaded = null; await outbox.clear(); publish();
}
