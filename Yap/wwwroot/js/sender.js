// The outbox of this device: the messages the person sent that the server has not accepted yet. A send
// appears at once as a pending row (IB-24, MR-69) and is posted when the connection allows; a refusal makes
// the row a failed row with Retry and Remove (IB-26, MR-71). The rows live in memory and on disk
// (offline/outbox.js), so a closed tab's messages go out from the next open one (OF-08, OF-10).
//
// One loop, driven by events, never by a timer (offline-design-notes.md): the oldest queued row, its files
// uploaded if still Blobs, then the POST. A network error stops the loop until a wake-up; a refusal marks
// the row failed. A Web Lock makes one tab the sender: the other tabs show the rows and post nothing.
//
// A wake-up during a run marks the run to go again when it ends. An upload whose socket died with the network
// may never report (the phone's Wi-Fi went away mid-upload): a wake-up gives up an upload with no progress for a
// few seconds, and the run that follows sends the files that are not done.

import { state, changed, setPending, addMessage, on, hasMedia } from './store.js';
import { api, ApiError } from './api.js';
import * as hub from './hub.js';
import * as outbox from './offline/outbox.js';
import { keyOf } from './offline/snapshot.js';
import * as upload from './upload.js';

const DAY = 86_400_000;
const STALL_MS = 5000;   // no byte and no poll for this long when a wake-up comes: the socket is dead
let queue = [];        // every pending row, all conversations, oldest first
let posting = false;
let again = false;     // a wake-up came during a run
let current = null;    // the upload in flight: { job, lastProgressAt }
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

// The names a pending row shows while its files upload (IB-34). A voice message is one Blob with a made-up name.
const namesOf = row => row.voice ? ['Voice message'] : row.files.map(f => f.name ?? 'file');

// One GIF of a pending row: the fields the row renderer draws, plus what the server needs to resolve the
// GIF (an entry of the library, or a provider item and the search text that becomes its tag, PK-20).
function gifEntry(pick) {
  return { entryId: pick.entryId ?? null, src: pick.preview ?? null, isImage: pick.isImage ?? true, width: pick.width ?? 0, height: pick.height ?? 0, uploader: null,
           provider: pick.provider ?? null, searchText: pick.searchText ?? null };
}
const gifRequest = g => g.entryId ? { entryId: g.entryId, searchText: g.searchText } : { provider: g.provider, searchText: g.searchText };

// A pending row has the shape of a message plus pending, failed, uploading and files, so the row renderer
// draws both. `files` are the picked Blobs until the sender uploads them (OF-08). A voice message is the one
// file plus `voice` { durationMs, peaks }; its `src` is the Blob's URL until the upload gives the file's (IB-70).
export function queueMessage({ channelId = null, partner = null, text = '', replyToId = null, files = [], gif = null, voice = null }) {
  const row = {
    id: crypto.randomUUID(), clientId: crypto.randomUUID(), channelId, partner,
    username: state.user.username, text, timestamp: new Date().toISOString(), edited: false,
    replyTo: replyToId ? quoteOf(replyToId) : null, replyToId,
    files, images: [], videos: [], gifs: gif ? [gifEntry(gif)] : [], voice: voice ? { ...voice, url: null, src: URL.createObjectURL(files[0]) } : null, reactions: [], previews: [],
    pending: true, failed: null, queuedAt: Date.now(),
  };
  row.uploading = files.length ? { names: namesOf(row), percent: 0 } : null;
  queue.push(row);
  // 'queued' moves the timeline to the bottom, for a send only (TL-14) and only for a send into the open conversation:
  // an uploaded GIF may go to a conversation that the person left during the upload (composer.js gifUpload, PK-41).
  publish(row, state.open && keyOf(row) === keyOf(state.open) ? { type: 'queued' } : undefined);
  flush();
  return row;
}

export function remove(row) {
  row.cancel?.();
  queue = queue.filter(r => r !== row);
  outbox.remove(row).then(() => outbox.announce());
  publish();
  flush();   // the rows behind a cancelled upload go on
}

export function retry(row) {
  row.failed = null; row.queuedAt = Date.now();
  if (row.files?.length) row.uploading = { names: namesOf(row), percent: 0 };
  publish(row);
  flush();
}

// Edit on a pending text row acts on the device (MR-72). A failed row goes again with the corrected text:
// the refusal was about the text, so the old reason no longer applies (U02 of the 2026-10-15 user test).
export function edit(row, text) { row.text = text; if (row.failed) retry(row); else publish(row); }

function fail(row, reason) {
  if (!queue.includes(row)) return;   // removed meanwhile: nothing goes back to disk
  row.uploading = null; row.cancel = null; row.failed = reason;
  publish(row);
}

// One post at a time, in order (IB-28, OF-10). A network error keeps the row pending; a refusal marks it failed.
async function flush() {
  if (!holder) return;
  if (posting) { again = true; return; }
  posting = true;
  try {
    await ready();
    for (const row of [...queue]) {
      if (!holder) break;   // the lock went to another tab mid-run (yieldLock): the rest is its to post
      if (row.failed || !queue.includes(row)) continue;
      if (Date.now() - row.queuedAt > DAY) { fail(row, 'Waited more than a day'); continue; }   // MR-71, OF-11
      if (!navigator.onLine) break;
      if (row.files?.length && !(await uploadFiles(row))) break;   // the network went away, or the row was removed
      if (row.failed || !queue.includes(row)) continue;
      try {
        // A direct message goes by its partner, so the server finds or creates the channel (message-path.md).
        const url = row.partner ? `/api/dm/${encodeURIComponent(row.partner)}/messages` : `/api/channels/${row.channelId}/messages`;
        const message = await api.post(url, {
          clientId: row.clientId, text: row.text || null, replyToId: row.replyToId,
          images: row.images.length ? row.images : null, videos: row.videos.length ? row.videos : null,
          gifs: row.gifs.length ? row.gifs.map(gifRequest) : null,
          voice: row.voice?.url ? { url: row.voice.url, durationMs: row.voice.durationMs, peaks: row.voice.peaks } : null,
        });
        queue = queue.filter(r => r !== row);
        await outbox.remove(row);
        outbox.announce();
        addMessage(message);                 // the POST answer and the hub event are the same confirmation
        if (row.tappedAt) hub.report('send', performance.now() - row.tappedAt);   // AD-26: tap to own row rendered; a tap of this tab only
        publish();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status === 409)) break;   // no network, or the first copy is still being stored
        fail(row, e instanceof ApiError ? e.message : 'Could not send');
      }
    }
  } finally { posting = false; if (again) { again = false; flush(); } }
}

// The connection is back, or the tab is visible again. An upload that made no progress for a while is on a
// dead socket: the browser may never report it. It is given up, and the run that follows takes the rest.
function wake() {
  if (current && Date.now() - current.lastProgressAt > STALL_MS) current.job.giveUp();
  flush();
}

// The files of one row, with one progress figure (IB-34). The results replace the Blobs; a refusal marks the row.
// A file the server never answered for stays a Blob on the row, and the loop stops until a wake-up: the browser
// can be online while the server is down, and that is a wait, not a failure (OF-08), the same as for a text send.
async function uploadFiles(row) {
  if (!navigator.onLine) return false;
  const live = { job: null, lastProgressAt: Date.now() };
  current = live;
  live.job = upload.upload(row.files, state.config?.uploadUrl || '/api/tus', (percent, done, total) => {
    live.lastProgressAt = Date.now();
    row.uploading = { ...row.uploading, percent, label: `${done}/${total}` };
    changed('pending');
  }, row.voice ? { kind: 'voice' } : {});   // the server transcodes a voice recording instead of sorting it by extension
  row.cancel = live.job.cancel;
  const result = await live.job.promise;
  current = null;
  if (result.cancelled || !queue.includes(row)) return false;   // removed meanwhile
  row.cancel = null;
  for (const f of result.files) {
    if (f.type === 'gif') row.gifs.push(gifEntry({ entryId: f.gifEntryId, width: f.width, height: f.height }));   // every GIF of the pick, one message (IB-33)
    else if (f.type === 'video') row.videos.push(f.url);
    else if (f.type === 'voice') {
      if (row.voice?.src?.startsWith('blob:')) URL.revokeObjectURL(row.voice.src);
      row.voice = { ...row.voice, url: f.url, src: f.url, durationMs: f.durationMs };   // the file's own length, read by the server
    }
    else row.images.push(f.url);
  }
  row.files = result.retry;
  if (row.files.length) { row.uploading = { names: namesOf(row), percent: 0 }; publish(row); return false; }
  if (!result.files.length) { row.files = result.refused; fail(row, result.errors[0] ?? 'Upload failed'); return true; }   // the files stay: Retry sends them again (a server that got its converter meanwhile), and a voice row has nothing else to send
  row.uploading = null;
  publish(row);
  return true;
}

// The rows on disk become the rows in memory (OF-08): a reload, or a change in another tab. A row this tab
// is uploading keeps its upload; a row older than a day is failed (OF-11).
function ready() {
  loaded ??= outbox.loadAll().then(rows => {
    const mine = new Map(queue.map(r => [r.clientId, r]));
    queue = rows.map(r => {
      const live = mine.get(r.clientId);
      if (live?.cancel) return live;   // mid-upload here: the disk copy is older
      const row = { ...r, edited: false, gifs: r.gifs ?? [], reactions: [], previews: [], pending: true,
        tappedAt: live?.tappedAt, cancel: null,
        // a voice row plays its file once uploaded, else the Blob it still holds (the disk keeps no Blob URL)
        voice: r.voice ? { ...r.voice, src: r.voice.url ?? (r.files?.[0] ? URL.createObjectURL(r.files[0]) : null) } : null,
        failed: r.failed ?? (Date.now() - r.queuedAt > DAY ? 'Waited more than a day' : null) };
      row.uploading = r.files?.length ? { names: namesOf(row), percent: 0 } : null;
      return row;
    });
    queue.sort((a, b) => a.queuedAt - b.queuedAt);
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
  navigator.locks.request('yap-outbox-sender', { mode: 'exclusive' }, () => new Promise(resolve => { holder = true; release = resolve; flush(); }));
}
function yieldLock() {
  if (!holder || !release) return;   // not the holder, or no Web Locks: nothing to hand over
  holder = false; release(); release = null;
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
export async function clearAll() { queue = []; loaded = null; await outbox.clear(); publish(); }
