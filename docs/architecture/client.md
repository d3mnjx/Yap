# The client

The client is a set of static files in `wwwroot/`: one HTML file, CSS files, JavaScript modules, one vendored library, and a service worker. There is no build step. The browser loads the modules directly. This page gives the list of files, the role of each file, and the way they work together. The timeline, the composer, the pickers and the offline parts get their own pages later.

## The files

```
wwwroot/
  index.html              the one HTML page: the frame's markup, <template> elements for every component, the module preload list
  app.css                 fonts, CSS variables, resets, the body, and the rules the flattened files do not have
  themes.css, themes/     one block per theme (as today)
  css/
    frame.css             header, sidebar, status menu, profile card (flattened from the old scoped files; css/README.md)
    timeline.css          the message list, the loading pill, the top note, the gallery viewer
    message.css           one message row: header, content, media, reactions, action bar, editor, cards
    composer.css          the input box, the reply bar, the typing strip, the drop ring
    pickers.css           the emoji picker, the GIF picker, the phone sheet
    pages.css             login, settings, channel settings, admin
  js/
    main.js               starts the app: the bootstrap, the router, the frame, the service worker, the new-version strip
    store.js              the state object, the subscribe function, the local-first edits
    api.js                fetch for the HTTP routes
    hub.js                the SignalR connection, its retry loop, the hub messages, the heartbeat
    router.js             URL to page, history, the last route
    session.js            sign-in and sign-out as the client sees them
    sender.js             the outbox: pending rows, uploads, the post loop, the rows on disk
    upload.js             files to the TUS endpoint, with progress
    notify.js             the sound, the tab title, the app badge
    push.js               the push subscription of this device and the prompt of the installed app
    pwa.js                the install dialog, the browser's install prompt, the add-to-home-screen guide
    scene.js              the place for the Tea House sun: the device's time zone city, stored for the inline script
    render/dom.js         el(), clone(), replace()
    render/text.js        message text to DOM nodes: links, :shortcode: images, emoji images
    render/time.js        timestamps with the account's zone, clock and date order
    render/avatar.js      the avatar and the gradient of a username
    ui/frame.js           header, status chip and menu, connection dot, sidebar, profile card
    ui/timeline.js        the list, the follow rule, the pill, older pages, the lobby lines
    ui/message.js         one message row and its popups
    ui/composer.js        the input box and the pickers' host
    ui/emoji-picker.js    the emoji picker, for the composer and for reactions
    ui/gif-picker.js      the GIF picker
    ui/gallery.js         the image viewer
    ui/overlays.js        the layer stack, Escape, taps outside, popup placement
    ui/gif-library.js     the GIF library manager of Settings and of the admin's server library
    ui/confirm.js         the app's own dialogs in the theme, confirm() and notice(), never the browser's
    ui/pins.js            the pinned messages panel under the header's pin button (SH-47 to SH-49)
    ui/recorder.js        the microphone recorder of the input box and the waveform it measures (IB-67 to IB-69)
    ui/tooltip.js         the explanation bubbles of the admin pages (AD-25)
    ui/voice.js           the voice message player of a row, and the bars that it and the recorder draw (MR-76)
    offline/db.js         the IndexedDB database
    offline/snapshot.js   the stored bootstrap and the stored conversation tails
    offline/outbox.js     the unsent messages on disk
    pages/chat.js         a room or a direct message
    pages/login.js        the login page
    pages/verify.js       the code for a known name
    pages/invite.js       an invite or a login link
    pages/settings.js     Settings
    pages/channel-settings.js   Create Channel and Channel Settings
    pages/admin.js        Administration
  lib/signalr.min.js      vendored
  lib/tus.min.js          vendored
  service-worker.js       the shell cache by build, the emoji cache, the media cache, push, the notification tap
```

Four kinds of module:

| Kind | Modules | Role |
| --- | --- | --- |
| core | `store`, `api`, `hub`, `router` | hold the state and talk to the server. They know nothing about the DOM. |
| render | `render/*` | turn a value into DOM nodes or strings. No DOM state; `text` keeps the emoji image rules it was given and `time` the account's format, nothing else. |
| ui | `ui/*` | one visible component each. A component reads the store, draws itself, and reacts to input. |
| pages | `pages/*` | one route each. A page mounts the components it needs and removes them when the route changes. |

`session`, `sender`, `upload`, `notify` and the offline modules are helpers. They are called by the ui modules, by `main` and by `hub`.

## How the modules depend on each other

<figure class="diagram">
<svg viewBox="0 0 860 420" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, Segoe UI, system-ui, sans-serif" font-size="13">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker>
  </defs>
  <style>
    .box { fill: var(--surface-2); stroke: var(--line-strong); rx: 6; }
    .core { fill: var(--surface); stroke: var(--accent); stroke-width: 1.5; rx: 6; }
    .t { fill: currentColor; text-anchor: middle; }
    .s { fill: var(--muted); text-anchor: middle; font-size: 11px; }
    .e { stroke: var(--muted); stroke-width: 1.4; fill: none; marker-end: url(#a); }
  </style>

  <rect x="30" y="30" width="800" height="60" class="box"/>
  <text x="430" y="54" class="t">index.html</text>
  <text x="430" y="72" class="s">markup, templates, preload list, inline theme script; loads main.js</text>

  <rect x="350" y="120" width="160" height="44" class="box"/>
  <text x="430" y="147" class="t">main.js</text>
  <path d="M430 90 V 118" class="e"/>

  <rect x="60" y="200" width="150" height="44" class="box"/>
  <text x="135" y="227" class="t">router.js</text>
  <path d="M370 164 L 150 198" class="e"/>

  <rect x="60" y="290" width="150" height="44" class="box"/>
  <text x="135" y="317" class="t">pages/*</text>
  <path d="M135 244 V 288" class="e"/>

  <rect x="260" y="290" width="150" height="44" class="box"/>
  <text x="335" y="317" class="t">ui/*</text>
  <path d="M210 312 H 258" class="e"/>

  <rect x="260" y="360" width="150" height="44" class="box"/>
  <text x="335" y="387" class="t">render/*</text>
  <path d="M335 334 V 358" class="e"/>

  <rect x="470" y="200" width="150" height="44" class="core"/>
  <text x="545" y="227" class="t">store.js</text>
  <path d="M450 164 L 520 198" class="e"/>
  <path d="M410 300 L 470 240" class="e"/>
  <text x="400" y="268" class="s">read, subscribe</text>

  <rect x="680" y="200" width="150" height="44" class="core"/>
  <text x="755" y="227" class="t">hub.js</text>
  <path d="M510 150 L 720 198" class="e"/>
  <path d="M680 230 H 622" class="e"/>
  <text x="651" y="250" class="s">writes</text>

  <rect x="470" y="290" width="150" height="44" class="core"/>
  <text x="545" y="317" class="t">api.js</text>
  <path d="M410 320 H 468" class="e"/>
  <path d="M545 288 V 246" class="e"/>
  <text x="590" y="268" class="s">writes</text>

  <rect x="680" y="290" width="150" height="44" class="box"/>
  <text x="755" y="317" class="t">sender.js</text>
  <path d="M680 312 H 622" class="e"/>
  <path d="M755 288 V 246" class="e"/>
  <text x="790" y="268" class="s">wakes on connect</text>

  <text x="430" y="410" class="s">Arrows mean "calls". The ui modules read the store and call api and hub. Only hub, api and the sender write to the store.</text>
</svg>
<figcaption>The dependency graph has no cycles. The core modules know nothing about the DOM. The ui modules know nothing about SignalR or fetch.</figcaption>
</figure>

## The store

The store is one plain object and one function. The object holds all data the client has. The function lets a component ask for a call when a part of the data changes.

```js
// js/store.js (sketch)
export const state = {
  connection: 'connecting',    // 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'signedOut'
  user: null, config: null, texts: null,
  rooms: [], users: {}, presence: {}, dms: [], unread: {}, mutes: null, emoji: null, favoriteGifIds: new Set(),
  open: null,                  // { channelId, messages: [], hasMore, hasNewer, restricted, typists: [], following: true }
  pending: [],                 // outbox rows of the open conversation, drawn as faded rows
  drafts: {},                  // conversation key -> { text, replyToId }; a room by its id, a direct message by 'dm:' and the partner
};

const listeners = new Map();   // part name -> Set of functions

export function on(part, fn) {           // call fn when this part changes; returns the function that stops it
  if (!listeners.has(part)) listeners.set(part, new Set());
  listeners.get(part).add(fn);
  return () => listeners.get(part).delete(fn);
}

export function changed(...parts) {      // the writer calls this after it changed state
  for (const part of parts) for (const fn of listeners.get(part) ?? []) fn();
}

export function applyBootstrap(doc) {    // replaces the shared data as a whole; see the wire contract, "Bootstrap"
  const emojiImages = doc.emojiImages ?? state.emojiImages;   // null when the rules the client holds are current
  Object.assign(state, { user: doc.user, config: doc.config, texts: doc.texts, rooms: doc.rooms,
    users: Object.fromEntries(doc.users.map(u => [u.username, u])), presence: doc.presence, dms: doc.dms,
    unread: doc.unread, mutes: doc.mutes, emoji: doc.emoji, favoriteGifIds: new Set(doc.favoriteGifIds), emojiImages });
  changed('emojiImages', 'user', 'rooms', 'users', 'presence', 'dms', 'unread', 'mutes', 'emoji', 'favoriteGifIds');   // the rules first: the others draw names with them
}
```

The part names are the field names of the bootstrap document, plus `connection`, `open`, `pending` and `drafts`. There is no diffing. A component that listens to `rooms` redraws its room list. A room list has at most a few dozen rows, so a full redraw is cheap. The message list is the one component that updates rows in place, because it can hold hundreds of rows. The timeline page describes that.

`open.messages` is one range of the conversation with no gap. After an open it ends at the newest message (a tail). After a jump to a row that is not loaded (`setWindow`, TL-41) it is the window from the hub's `around`, and `open.hasNewer` is true. Other modules ask `atTail()` and do not read the field. In a window the store inserts no live message: `addMessage` signals `{ type: 'missed' }` and the timeline shows the pill. Edits, reactions, cards and deletes reach only the rows of the window. The way back is a fresh open (the chat page's `open`, the same as after a reconnect), and `setOpen` always makes a tail. The device stores no window (OF-14).

## The hub module

`hub.js` owns the SignalR connection. It does three things: it keeps the connection alive, it writes hub messages into the store, and it offers `invoke` to the ui modules.

```js
// js/hub.js (sketch)
import * as store from './store.js';
import { api } from './api.js';
import * as sender from './sender.js';

const connection = new signalR.HubConnectionBuilder()
  .withUrl(`/hub?device=${deviceId()}`)          // the device id is a random id in localStorage (AU-19)
  .build();

connection.on('message',        m => store.addMessage(m));
connection.on('messageEdited',  m => store.replaceMessage(m));
connection.on('messageDeleted', (channelId, id) => store.removeMessage(channelId, id));
connection.on('pins',           (channelId, pins) => store.setPins(channelId, pins));
connection.on('reactions',      (id, reactions) => store.setReactions(id, reactions));
connection.on('previews',       (id, previews) => store.setPreviews(id, previews));
connection.on('typing',         (channelId, username, on) => store.setTyping(channelId, username, on));
connection.on('unread',         (channelId, count) => store.setUnread(channelId, count));
connection.on('presence',       (username, status, kind) => store.setPresence(username, status, kind));
connection.on('profile',        u => store.setUser(u));
connection.on('accountDeleted', username => store.removeUser(username));
connection.on('rooms',          rooms => store.setRooms(rooms));
connection.on('dm',             dm => store.addDm(dm));
connection.on('me',             partial => store.mergeMe(partial));
connection.on('gifFavorites',   ids => store.setFavoriteGifs(ids));
connection.on('signedOut',      () => signedOut());   // stop, then the handler main.js installs: session.signedOut({ elsewhere: true }) (AU-21)

connection.onclose(() => { setState(navigator.onLine ? 'reconnecting' : 'offline'); retryLater(); });

export async function connect() {
  setState(state.connection === 'connecting' ? 'connecting' : 'reconnecting');
  try { await connection.start(); } catch { retryLater(); return; }
  setState('connected');
  const [doc] = await Promise.all([api.get('/api/bootstrap'), reopen()]);   // one round trip; the hub is already connected
  store.applyBootstrap(doc);
  sender.wake();                                                            // post what queued while offline (OF-10)
}

export async function invoke(method, ...args) {        // the ui calls this; a refusal comes back as { error }
  if (state.connection !== 'connected') return { error: 'Needs a connection' };
  return connection.invoke(method, ...args);
}

// Reconnect: a timer with a growing delay, capped at 30 s, plus an attempt at once on each of these (OF-13).
addEventListener('online', retryNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryNow(); });
export { retryNow as reconnectNow };                   // the connection dot calls this on tap (SH-18)
```

The client runs its own retry loop instead of SignalR's automatic reconnect. SignalR's reconnect stops after its list of delays ends, and it has no function for "try now". The spec wants a retry on `online`, on a visible tab, and on a tap of the dot, with no end (OF-13).

## The api module

`api.js` is a thin function over `fetch`. It sends and receives JSON, sends the cookie, and converts a refusal into a reason the ui can show.

```js
// js/api.js (sketch)
export class ApiError extends Error { constructor(status, reason) { super(reason); this.status = status; } }

async function request(method, url, body) {
  let res;
  try { res = await fetch(url, { method, credentials: 'same-origin', headers: body && { 'content-type': 'application/json' },
                                 body: body && JSON.stringify(body) }); }
  catch { throw new ApiError(0, 'Needs a connection'); }                       // network error (GEN-10)
  if (res.ok) return res.status === 204 ? null : res.json();
  if (res.status === 401) signedOutHandler();                                  // main.js installs session.signedOut({ elsewhere: true }): the login page says so (AU-21)
  const problem = await res.json().catch(() => null);
  throw new ApiError(res.status, problem?.detail ?? 'Something went wrong');   // ProblemDetails (GEN-02)
}

export const api = { get: url => request('GET', url), post: (url, body) => request('POST', url, body),
                     put: (url, body) => request('PUT', url, body), patch: (url, body) => request('PATCH', url, body),
                     delete: url => request('DELETE', url) };
```

## How a component is written

A component is a function. It receives the element it draws into. It draws from the store, subscribes to the parts it needs, and returns a function that removes the subscriptions. Example: the room list in the sidebar.

```js
// js/ui/frame.js (sketch of one component)
import { state, on } from '../store.js';
import { el, clone } from '../render/dom.js';
import { navigate } from '../router.js';

export function RoomList(root) {
  function render() {
    root.replaceChildren(...state.rooms.map(room => {
      const row = clone('t-room-row');                                   // <template id="t-room-row"> in index.html
      row.querySelector('.name').textContent = room.name;
      row.classList.toggle('open', room.id === state.open?.channelId);
      row.classList.toggle('muted', isMuted(room.id));
      const count = state.unread[room.id] ?? 0;
      row.querySelector('.badge').textContent = isMuted(room.id) || !count ? '' : String(count);   // SH-22, SH-23
      row.querySelector('.dot').hidden = !(isMuted(room.id) && count);
      row.querySelector('.bell').hidden = !state.mutes.channels[room.id];
      row.querySelector('.gear').hidden = !state.user.isAdmin;
      row.addEventListener('click', () => navigate(`/room/${room.id}`));
      return row;
    }));
  }
  const offs = ['rooms', 'unread', 'mutes', 'open', 'user'].map(part => on(part, render));
  render();
  return () => offs.forEach(off => off());
}
```

Rules every component follows:

- Text goes into the DOM with `textContent` or through `render/text.js`. No component uses `innerHTML` with data from the server. This is the whole XSS story.
- A component draws from the store only. It does not keep a second copy of the data.
- A user action changes the store first, then calls `api` or `hub`. The component redraws from the store at once (GEN-01). When the call fails, the action puts the store back and shows the reason (GEN-02). Example, a reaction:

```js
async function toggleReaction(message, emoji) {
  store.toggleReactionLocally(message.id, emoji, state.user.username);     // the pill changes now (MR-40)
  const result = await hub.invoke('react', message.id, emoji);
  if (result?.error) { store.toggleReactionLocally(message.id, emoji, state.user.username); showReason(rowOf(message), result.error); }
}
```

- A component never talks to SignalR or `fetch` directly. It calls `hub.invoke` or `api.*`.

## The router and the pages

`router.js` maps the URL to a page module (SH-42). It listens to `popstate` for the back button (SH-44) and offers `navigate(path)` for links. It stores the last conversation route in localStorage, and `/` opens it (SH-43).

| Route | Page | Inside the frame |
| --- | --- | --- |
| `/`, `/lobby`, `/room/{id}`, `/dm/{username}` | `pages/chat.js` | yes |
| `/settings` | `pages/settings.js` | yes (ST-03) |
| `/channel/new`, `/channel/{id}/settings` | `pages/channel-settings.js` | yes |
| `/admin` | `pages/admin.js` | no (AD-01) |
| `/login`, `/verify/{username}`, `/invite/{code}` | `pages/login.js`, `verify.js`, `invite.js` | no |
| anything else | `pages/not-found.js` | no |

A page module exports one function, `mount(root, params)`. It returns the function that unmounts the page. The frame is mounted once and stays while the route moves between chat, settings and channel settings. Only the content column changes. This keeps the sidebar, the header and the hub connection alive across these pages (SH-01, ST-03).

```js
// js/pages/chat.js (sketch)
export function mount(root, { roomId, dmUser }) {
  const unmounts = [ Timeline(root.querySelector('.timeline')), Composer(root.querySelector('.composer')) ];
  openConversation(roomId, dmUser);           // paints the snapshot, invokes openRoom or openDm, replaces
  return () => unmounts.forEach(u => u());
}
```

## Start-up

1. The browser loads `index.html`. The service worker answers it, and every file of the shell, from the device's copy (OF-18), so nothing waits for the network before the first paint; a first visit and a new build fetch them. An inline script reads the cached theme and text size from localStorage and sets them on `<html>`, before the first paint. Without this the page would flash the default theme. The same script sets the Tea House scene (ST-09): it computes sunrise and sunset for the place `scene.js` stored (the device's time zone city) and divides the day among seven scenes and the night among five.
2. The browser loads `main.js` and its imports. The server writes an import map and a `<link rel="modulepreload">` for every module into `index.html` (`ShellAssets`), so every module has a URL with the build stamp and the browser requests all of them at once instead of one level at a time.
3. `main.js` reads the stored bootstrap document from IndexedDB and applies it: the frame paints with the last known state, and the chat page paints the stored tail of the conversation (TL-02), under a "Catching up…" pill until the server answers (TL-39). `hub.connect()` starts at once. Without a stored document (a first load, or after a sign-out) `main.js` requests `GET /api/bootstrap` first: without `user` in the answer, the router shows the login, verify or invite page with the texts from the answer.
4. The hub connects over a direct WebSocket, without the negotiate round trip. When that socket does not open, it builds the connection again with negotiation and every transport, and keeps that for the page.
5. When the hub is connected, the hub module requests the bootstrap and opens the current conversation, in parallel. The document replaces the stored one, and no change can fall between it and the first hub message (wire contract, "Bootstrap"). A load with a stored copy makes this one bootstrap request and no other.
6. The sender wakes and posts the outbox.

A reconnect runs step 5 and 6 only. The view keeps its position, the draft and the pending rows stay (TL-35).

## Overlays and input rules

`ui/overlays.js` owns one stack of open layers: menus, pickers, sheets, dialogs, the gallery. Escape closes the top layer only (GEN-17). A tap outside a layer closes it. On a window of 600 px or less, a menu or a picker opens as a bottom sheet over a dimmed page (GEN-18). The width tier is a CSS media query; the JavaScript reads the same query with `matchMedia` where it must choose a behaviour (IB-08, GEN-14).

## What is not in the client

- No framework, no virtual DOM, no bundler, no transpiler. The files in `wwwroot/js` are what the browser runs.
- No HTML from the server. The server sends data.
- No second copy of history. The timeline holds the open conversation only. The snapshot store holds the last tail per conversation for offline reads (OF-06). The outbox holds unsent messages (OF-08). Nothing else is stored.
- No merge logic. The bootstrap replaces, the events update.
