// The SignalR connection: keeps it alive, writes every hub message into the store, and offers invoke and
// send to the components. The components never see SignalR. The heartbeat lives here too, because it is
// the one message the client sends on its own clock (PR-10, AD-25).
//
// lib/signalr.min.js is a classic script loaded by index.html before this module; it defines `signalR`.

import * as store from './store.js';
import { api } from './api.js';
import { saveBootstrap } from './offline/snapshot.js';
import { installed } from './push.js';
import { retryFailedImages } from './render/text.js';

const DEVICE_KEY = 'yap.deviceId';

// A random id per browser, kept in localStorage: the tabs of one device share one row in Settings (AU-19).
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch { /* private mode: a new id per load */ }
  if (!id) {
    id = crypto.randomUUID();
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* same */ }
  }
  return id;
}

// A direct WebSocket, without the negotiate round trip (one less per connect, docs/performance-notes.md 5.4). SignalR
// has no fallback then: when the direct socket does not open, connect() builds the connection again with negotiation
// and every transport, as before, and the page keeps that for the rest of its life. The admin's Sessions table shows
// the transport in use (AD-25).
let negotiate = false;
let connection = build();

function build() {
  const c = new signalR.HubConnectionBuilder()
    .withUrl(`/hub?device=${deviceId()}${installed() ? '&pwa=1' : ''}`,   // pwa: the admin's Installed badge (AD-05)
      negotiate ? {} : { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets })
    .configureLogging(signalR.LogLevel.Warning)
    .build();
  c.on('message', m => { store.changed('incoming', m); store.addMessage(m); });   // 'incoming' feeds the sound and the title (NT-12, NT-13)
  c.on('messageEdited', m => store.replaceMessage(m));
  c.on('messageDeleted', (channelId, id) => store.removeMessage(channelId, id));
  c.on('reactions', (id, reactions) => store.setReactions(id, reactions));
  c.on('previews', (id, previews) => store.setPreviews(id, previews));
  c.on('typing', (channelId, username, on) => store.setTyping(channelId, username, on));
  c.on('unread', (channelId, count) => store.setUnread(channelId, count));
  c.on('presences', list => store.setPresences(list));   // one tick of changes, in order
  c.on('profile', u => store.setUser(u));
  c.on('accountDeleted', username => store.removeUser(username));   // AD-40
  c.on('rooms', rooms => store.setRooms(rooms));
  c.on('pins', (channelId, pins) => store.setPins(channelId, pins));
  c.on('dm', dm => store.addDm(dm));
  c.on('me', partial => store.mergeMe(partial));
  c.on('gifFavorites', ids => store.setFavoriteGifs(ids));
  c.on('pending', list => store.setRegistrations(list));
  c.on('gifImport', progress => store.changed('gifImport', progress));   // the library manager shows it (ST-22)
  c.on('signedOut', () => signedOut());
  c.onclose(() => onClose(c));
  return c;
}

// ---- the connection loop ----
// Our own retry instead of withAutomaticReconnect: SignalR's list of delays ends, and it has no "try now".
// The spec wants a retry forever, at once on `online`, on a visible tab, and on a tap of the dot (OF-13, SH-18).

let stopped = false;          // after a sign-out nothing reconnects
let attempts = 0;
let retryTimer = 0;
let everConnected = false;
let lostAt = 0;        // the start of the reconnect wait (AD-26), see noteLost
let visibleAt = 0;     // the tab's last return to visible
let hiddenAt = 0;      // Date.now() when the tab went hidden: a wall clock, because performance.now() may stand still through a sleep
const SERVER_TIMEOUT_MS = 30_000;   // SignalR's default on both sides; nothing overrides it (Program.cs, the builder above)
const connectedHooks = new Set();
// The first connect of this load has applied its bootstrap, or the first try failed: the boot report waits for it
// (AD-41), and the chat page waits for it before it calls a route unknown (the stored copy may not know a new room).
let settleFirst, firstDone = false;
const firstSettled = new Promise(r => { settleFirst = () => { firstDone = true; r(); }; });
export const firstSync = () => firstSettled;
export const synced = () => firstDone;
let signedOutHandler = () => {};

export function onSignedOut(fn) { signedOutHandler = fn; }

// The bootstrap request names the emoji image rules the device holds, by their stamp. The server leaves them out of
// its answer when they are current (wire contract, "Bootstrap"): the custom packs are the largest part of the document
// and change only with a deploy, while this request goes out after every connect, on a phone many times a day.
function bootstrapUrl() {
  const stamp = store.state.emojiImages?.stamp;
  return stamp ? `/api/bootstrap?emojiStamp=${encodeURIComponent(stamp)}` : '/api/bootstrap';
}

// A hook runs after every connect, in parallel with the bootstrap request: the chat page re-opens its
// conversation here, the sender posts the outbox (wire contract, "Bootstrap").
export function onConnected(fn) { connectedHooks.add(fn); return () => connectedHooks.delete(fn); }

export async function connect() {
  if (stopped || connection.state !== signalR.HubConnectionState.Disconnected) return;
  clearTimeout(retryTimer);
  if (!navigator.onLine) { store.setConnection('offline'); scheduleRetry(); return; }   // the online event tries at once
  store.setConnection(everConnected ? 'reconnecting' : 'connecting');
  try { await connection.start(); }
  catch (e) {
    if (/401|Unauthorized/.test(String(e?.message ?? e))) { signedOut(); return; }   // the cookie is dead: the login page, not a loop (AU-21)
    // The direct socket did not open: a dead cookie shows as a plain socket error here, and so does a proxy that
    // blocks WebSockets. The negotiated connection tells the two apart (a 401 above) or finds another transport.
    if (!negotiate) { negotiate = true; connection = build(); connect(); return; }
    if (!everConnected) settleFirst();   // the first try failed: whoever waits for the first sync goes on without it
    store.setConnectionFailed(true);   // the catching-up pill stops spinning (TL-39)
    store.setConnection(navigator.onLine ? (everConnected ? 'reconnecting' : 'connecting') : 'offline'); scheduleRetry(); return;
  }
  const wasReconnect = everConnected;
  everConnected = true;
  attempts = 0;
  store.setConnection('connected');
  store.setConnectionFailed(false);
  if (!wasReconnect) performance.mark('socket');   // the boot report (AD-41): the first connect of the load
  retryFailedImages();   // emoji pictures that the CDN did not deliver while the network was poor (MR-15)

  const results = await Promise.allSettled([
    api.get(bootstrapUrl()),
    ...[...connectedHooks].map(fn => fn()),
  ]);
  const bootstrap = results[0];
  if (bootstrap.status === 'fulfilled') {
    if (bootstrap.value.user) {
      const doc = bootstrap.value;
      store.applyBootstrap(doc);
      saveBootstrap({ ...doc, emojiImages: store.state.emojiImages });   // the answer left the rules out when they matched (bootstrapUrl); the stored copy needs them
      beacon(doc.config);
      if (!wasReconnect && !performance.getEntriesByName('bootstrap', 'mark').length) performance.mark('bootstrap');   // the server's bootstrap of this load (AD-41); a first load marked it in main.js
    }
    else signedOut();                      // the cookie died while we were away
  }
  if (!wasReconnect) settleFirst();
  // Back in sync: the room is re-opened and the bootstrap applied. A reconnect nobody watched is nobody's wait.
  if (wasReconnect && lostAt && document.visibilityState === 'visible') report('reconnect', performance.now() - lostAt);
  lostAt = 0;
}

function onClose(c) {
  if (c !== connection || stopped) return;   // a connection that restart() replaced: its late close is not ours
  noteLost();
  store.setConnection(navigator.onLine ? 'reconnecting' : 'offline');
  scheduleRetry();
}

// The reconnect wait (AD-26) starts when the person could notice the loss. After a short sleep the socket may be
// dead, and the client learns it only when its first call fails, up to SignalR's 30 s server timeout (a long sleep
// is handled at once, see the visibility handler): a loss noticed within 35 s of the tab's return counts from the
// return. The visibility handler restarts a wait noticed while hidden.
function noteLost() {
  if (lostAt) return;
  const now = performance.now();
  lostAt = visibleAt && now - visibleAt < 35_000 ? visibleAt : now;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  attempts++;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5));   // 1, 2, 4, 8, 16, 30, 30 ... seconds
  retryTimer = setTimeout(connect, delay);
}

// DNS forces the request over IPv4, so the server learns the v4 address of a client that connected over v6.
// no-cors: the request only has to arrive. The nonce is single-use and bound to this connection; the hub mints
// it, because a client that skipped the negotiate step does not know its connection id.
async function beacon(config) {
  if (!config?.beaconUrl) return;
  const nonce = await invoke('beaconNonce');
  if (typeof nonce !== 'string') return;   // no session for this connection, or a refusal
  try { fetch(`${config.beaconUrl.replace(/\/+$/, '')}/api/ipv4-beacon?n=${encodeURIComponent(nonce)}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); }
  catch { /* best effort */ }
}

export function reconnectNow() {
  if (connection.state === signalR.HubConnectionState.Disconnected) { attempts = 0; connect(); }
}

addEventListener('online', reconnectNow);
// The browser knows before SignalR does: an open WebSocket stays open until the 30 s server timeout.
// Closing it now shows the grey ring at once (SH-17) and lets the retry loop wait for `online`.
addEventListener('offline', () => {
  if (stopped) return;
  noteLost();
  store.setConnection('offline');
  if (connection.state !== signalR.HubConnectionState.Disconnected) connection.stop().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { hiddenAt = Date.now(); return; }
  visibleAt = performance.now();
  if (lostAt) lostAt = visibleAt;   // a loss noticed while hidden: the wait starts now (AD-26)
  // After a background longer than the server's timeout the socket is dead and nobody has told the client: the
  // server dropped it, and the client's own timer did not run while the page was frozen. Waiting for that timer
  // costs up to 30 s of old rows. Drop the socket now and connect again. A desktop tab whose socket lived through
  // the background pays one connect for it: the client cannot tell the two apart (docs/performance-notes.md, 4).
  const longBackground = hiddenAt && Date.now() - hiddenAt > SERVER_TIMEOUT_MS;
  hiddenAt = 0;
  if (longBackground && !stopped && connection.state !== signalR.HubConnectionState.Disconnected) { restart(); return; }
  reconnectNow();
});

// The connect at once, without the 30 s timeout and without the 1 s retry delay, on a fresh connection object. Not
// stop() on the old one first: stop() clears the old connection's own timeout and then waits for a close handshake
// that a socket nobody answers never completes, up to the browser's closing timeout (measured: 3 s more, not less).
// The old connection closes in the background, and onClose ignores it. Not the exported stop() either: that one is
// the sign-out and blocks every later connect.
function restart() {
  clearTimeout(retryTimer);
  noteLost();   // the reconnect wait counts from this return (AD-26)
  const old = connection;
  connection = build();
  old.stop().catch(() => {});
  attempts = 0;
  connect();
}

// The server said signedOut: stop, then tell the page.
function signedOut() {
  if (stopped) return;
  stop();
  signedOutHandler();
}

// The page signs out: stop only. The page already knows.
export function stop() {
  stopped = true;
  clearTimeout(retryTimer);
  store.setConnection('signedOut');
  connection.stop().catch(() => {});
}

// A new sign-in on the same page: the loop may run again.
export function resume() { stopped = false; everConnected = false; attempts = 0; }

// ---- calls ----

export const connected = () => connection.state === signalR.HubConnectionState.Connected;

// A refusal comes back as { error }; a success as the method's result or null (wire contract, conventions).
export async function invoke(method, ...args) {
  if (!connected()) return { error: 'Needs a connection' };
  try { return await connection.invoke(method, ...args); }
  catch (e) {
    console.warn(method, e);
    // A connection that closed under the call is no refusal: the caller treats it as no connection, and the connected
    // hook runs the call again. The chat page would otherwise read it as an unknown room and leave for the lobby.
    if (/connection being closed|'Connected' State/i.test(String(e?.message ?? e))) return { error: 'Needs a connection' };
    return { error: 'Something went wrong' };
  }
}

// Fire and forget, for typing, markRead and emojiUsed. Silently dropped without a connection.
export function send(method, ...args) {
  if (connected()) connection.send(method, ...args).catch(() => {});
}

// ---- the heartbeat (PR-10, PR-13, AD-25, AD-26) ----
// Every 10 s while visible, every 60 s while hidden. Carries the idle time, the last round trip, and the waits
// the client measured since the last beat: send, open, older, start, reconnect, jump (AD-26).

let lastInputAt = Date.now();
let lastRttMs = null;
let samples = [];
let ticks = 0;

// A wait the person felt, by name, for the admin's latency table (AD-26). Capped: the beat does not run without
// a connection, and a tab offline for an hour must not queue an hour of samples.
export function report(name, ms) {
  if (samples.length >= 50) samples.shift();
  samples.push({ name, ms: Math.round(ms) });
}

// The boot report (AD-41): the phases of this page load in ms from the navigation start, and what the network did.
// The marks: scripts and bootstrap in main.js, socket above, paint and rows in the chat page, which sends the report
// once, when the server's rows of the first conversation are on screen. Same-origin files only: a cross-origin file
// without Timing-Allow-Origin reports transferSize 0 and would count as cached. The page itself counts as a file.
// A hidden tab still measures (Navigation Timing is not throttled) and says so, so the admin can set it aside.
let hiddenDuringLoad = document.visibilityState !== 'visible';
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') hiddenDuringLoad = true; });
export async function reportLoad() {
  await firstSettled;   // the server's bootstrap may land a moment after the rows: the report carries both
  const phase = name => { const [m] = performance.getEntriesByName(name, 'mark'); return m ? Math.round(m.startTime) : null; };
  const [nav] = performance.getEntriesByType('navigation');
  const files = performance.getEntriesByType('resource').filter(r => r.name.startsWith(location.origin));
  if (nav) files.push(nav);
  send('reportLoad', {
    html: nav ? Math.round(nav.responseEnd) : null,
    scripts: phase('scripts'), bootstrap: phase('bootstrap'), paint: phase('paint'), socket: phase('socket'), rows: phase('rows'),
    protocol: nav?.nextHopProtocol || null,
    requests: files.length,
    cached: files.filter(r => r.transferSize === 0).length,
    bytes: files.reduce((sum, r) => sum + (r.transferSize || 0), 0),
    hidden: hiddenDuringLoad,
    build: document.documentElement.dataset.build ?? null,   // the build this page runs: a device left behind after a deploy shows here
    worker: workerStamp(),
  });
}

// The build that registered the controlling service worker (the ?v= of its address, main.js), or null when no worker
// controls the page. It differs from the page's build when the worker stayed on an older registration: on 2026-10-30
// an iPhone's installed app stayed on an old build and nothing on the server could show it (AD-41).
const workerStamp = () => { const url = navigator.serviceWorker?.controller?.scriptURL; return url ? new URL(url).searchParams.get('v') || 'unstamped' : null; };

const idleSeconds = () => Math.round((Date.now() - lastInputAt) / 1000);

async function beat() {
  if (!connected()) return;
  const visible = document.visibilityState === 'visible';
  const batch = samples; samples = [];
  const started = performance.now();
  try {
    await connection.invoke('heartbeat', visible, idleSeconds(), lastRttMs, batch.length ? batch : null);
    // A hidden tab's timers are throttled, so its round trip measures the throttle, not the wire: no sample.
    lastRttMs = visible ? Math.round(performance.now() - started) : null;
  } catch { /* the connection is going down; onclose follows */ }
}

setInterval(() => {
  ticks++;
  if (document.visibilityState === 'visible' || ticks % 6 === 0) beat();
}, 10_000);

// Input ends an idle away at once (PR-13): a beat goes out when input follows a long pause, instead of
// waiting for the next tick.
function noteInput() {
  const wasIdle = Date.now() - lastInputAt > 60_000;
  lastInputAt = Date.now();
  if (wasIdle) beat();
}
for (const type of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) document.addEventListener(type, noteInput, { capture: true, passive: true });

// A beat on every visibility change, so the server's view of the tab is current within one round trip.
// The server reads it for unread counts (a hidden tab is not reading, NT-07), for push (a message to a hidden
// tab needs one) and for the away sweep. Without this a hidden tab is reported at the next 60 s tick.
// A return to the tab also counts as input (PR-13); the stamp is set here, not via noteInput, so one beat goes out.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') lastInputAt = Date.now();
  beat();
});

// The person is looking at the open conversation (NT-07): the page is visible, the account is not away (chosen or
// automatic, PR-24), and this device saw input within five minutes (PR-10). The server learns of this device's
// idle time with the next heartbeat only, and a device nobody touches must not read for the person.
export const looking = () => !!store.state.open?.channelId && document.visibilityState === 'visible' && !store.isAway() && idleSeconds() < 300;
