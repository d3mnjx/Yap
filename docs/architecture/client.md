# The client

The client is a set of static files in `wwwroot/`: one HTML file, CSS files, JavaScript modules, two vendored libraries, and a service worker. There is no build step. The browser loads the modules directly. This page gives the list of files, the role of each file, and the way they work together. The timeline, the composer, the pickers and the offline parts get their own pages later.

## The files

```
wwwroot/
  index.html              the one HTML page: <template> elements for the frame and every component, the icon set (t-icons),
                          the inline theme script; the server writes in the import map and the module preload list
  app.css                 fonts, the tokens of the default theme, resets, the body, the start screens, the emoji sizes
  themes.css              one block per theme
  themes/teahouse.css     the Tea House theme
  css/                    one file per part of the screen, then one per page (css/README.md is the map); in load order
    frame.css             header, sidebar, status menu, profile card
    pickers.css           the emoji picker, the GIF picker, the phone sheet
    timeline.css          the message list, the loading pill, the top note, the gallery viewer
    composer.css          the input box, the reply bar, the typing strip, the drop ring
    message.css           one message row: header, content, media, reactions, action bar, editor, cards
    signin.css            the login, invite and verify pages
    pages.css             the rules that several pages share, and the GIF library widget
    admin.css             Administration
    channel-settings.css  Create Channel and Channel Settings
    settings.css          Settings
  js/
    main.js               starts the app: the stored or fetched bootstrap, the router, the frame, the import of each page, the service worker
    update.js             the server's build against the page's: the new-version strip and the fresh load of a new build (SH-20, SH-50)
    store.js              the state object, the subscribe function, every function that changes the state, the derived values
    api.js                fetch for the HTTP routes
    hub.js                the SignalR connection, its retry loop, the hub messages, the heartbeat, the device id, the boot report
    router.js             URL to page, history, the last route
    session.js            sign-in and sign-out as the client sees them
    sender.js             the outbox: pending rows, uploads, the post loop, the rows on disk
    upload.js             files to the TUS endpoint, with progress
    notify.js             the sound, the tab title, the app badge
    push.js               the push subscription of this device and the prompt of the installed app
    pwa.js                the install dialog, the browser's install prompt, the add-to-home-screen guide
    scene.js              the place for the Tea House sun: the device's time zone city, stored for the inline script
    data/emoji-list.js    the emoji picker's list of Unicode emoji and their keywords, imported at the picker's first open
    render/dom.js         el(), clone(), replace(), classes(), and icon() for the icon set
    render/text.js        message text to DOM nodes: links, :shortcode: images, emoji images; the random pick of a
                          configured text; the retry of an image that did not load; safeHref
    render/time.js        timestamps with the account's zone, clock and date order
    render/avatar.js      the avatar and the gradient of a username
    ui/frame.js           the frame and its header: the title, the status chip and menu, the connection dot, the pin
                          button, the mailbox, the hamburger; the profile card
    ui/search.js          the message search (SR-01 to SR-32): the field of the header, the results in the place of
                          the sidebar, and at 768 px or less the search screen and the header of a result
    ui/entry.js           one message outside the timeline, as the pins panel and the search results draw it
    ui/sidebar.js         the sidebar of the frame: the rooms, and the people list, which draws only the rows in view
    ui/timeline.js        the list, the follow rule, the pills, older pages, the lobby lines, the read mark, jumpTo
    ui/message.js         one message row and its popups
    ui/composer.js        the input box, the pickers' host, the tray of picked files, the voice recorder's controls
    ui/emoji-picker.js    the emoji picker, for the composer and for reactions
    ui/gif-picker.js      the GIF picker
    ui/gallery.js         the image viewer
    ui/video.js           the video player of a row and of a pin, and the loop of a GIF that is a video file (MR-27, MR-29)
    ui/overlays.js        the layer stack, Escape, taps outside, popup placement
    ui/gif-library.js     the GIF library manager of Settings and of the admin's server library
    ui/confirm.js         the app's own dialogs in the theme, confirm() and notice(), never the browser's
    ui/pins.js            the pinned messages panel under the header's pin button (SH-47 to SH-49)
    ui/recorder.js        the microphone recorder of the input box and the waveform it measures (IB-67 to IB-69)
    ui/tooltip.js         the explanation bubbles of the admin pages (AD-25)
    ui/voice.js           the voice message player of a row, and the bars that it and the recorder draw (MR-76)
    offline/db.js         the IndexedDB database: the outbox, the snapshots and a small key-value store
    offline/snapshot.js   the stored bootstrap, the stored conversation tails and the drafts
    offline/outbox.js     the unsent messages on disk
    pages/chat.js         a room or a direct message
    pages/login.js        the login page
    pages/verify.js       the code for a known name
    pages/invite.js       an invite or a login link
    pages/settings.js     Settings
    pages/settings-debug.js   the DEBUG INFO card of Settings (ST-25)
    pages/channel-settings.js   Create Channel and Channel Settings
    pages/admin.js        Administration: a short mount, then one function per tab in screen order
  lib/signalr.min.js      vendored
  lib/tus.min.js          vendored
  service-worker.js       the shell cache by build, the emoji cache, the media cache, push, the notification tap
```

Four kinds of module:

| Kind | Modules | Role |
| --- | --- | --- |
| core | `store`, `api`, `hub`, `router` | hold the state and talk to the server. They draw nothing. `hub` listens to document events (input and visibility, for the heartbeat and the reconnect) and asks `render/text.js` to load again the images that failed while the network was poor (MR-15). |
| render | `render/*` | turn a value into DOM nodes or strings. They hold no component. `dom` keeps the templates it looked up, `text` keeps the emoji image rules it was given and the images that failed to load, and `time` keeps the account's format. |
| ui | `ui/*` | one visible component each. A component reads the store, draws itself, and reacts to input. `overlays` (the layer stack) and `recorder` (the microphone) serve the components and are not components themselves. |
| pages | `pages/*` | one route each. A page mounts the components it needs and removes them when the route changes. `settings-debug` is one card of the Settings page. |

`session`, `sender`, `upload`, `notify`, `push`, `pwa`, `update`, `scene` and the offline modules are services. Each one owns a task of the app that is not a component. `main`, the pages, the ui modules, `hub` and the other services call them. Two services draw: `update` shows the new-version strip, and `pwa` shows the install dialog. `data/emoji-list.js` holds data only, and the emoji picker imports it at its first open.

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
  <text x="400" y="268" class="s">read, subscribe, change</text>

  <rect x="680" y="200" width="150" height="44" class="core"/>
  <text x="755" y="227" class="t">hub.js</text>
  <path d="M510 150 L 720 198" class="e"/>
  <path d="M680 230 H 622" class="e"/>
  <text x="651" y="250" class="s">writes</text>

  <rect x="470" y="290" width="150" height="44" class="core"/>
  <text x="545" y="317" class="t">api.js</text>
  <path d="M410 320 H 468" class="e"/>

  <rect x="680" y="290" width="150" height="44" class="box"/>
  <text x="755" y="317" class="t">sender.js</text>
  <path d="M680 312 H 622" class="e"/>
  <path d="M755 288 V 246" class="e"/>
  <text x="790" y="268" class="s">wakes on connect</text>

  <text x="430" y="410" class="s">Arrows mean "calls". Every change of the state goes through a function of store.js, which tells the listeners.</text>
</svg>
<figcaption>The one cycle in the graph is between ui/message.js and ui/timeline.js, which import each other: the reply quote of a row calls jumpTo, and the timeline draws its rows with renderRow. It works because neither module uses the other while it loads. The core modules draw nothing. The ui modules know nothing about SignalR.</figcaption>
</figure>

## The store

The store is one plain object and one function. The object holds all data the client has. The function lets a component ask for a call when a part of the data changes.

Every change of the object goes through a function of `store.js`, and that function calls `changed(part, detail)`. The hub module, the sender, `session`, `update`, `main`, the pages and the ui modules call these functions. A ui module calls them for its local-first edits. The one direct write is in `main.js`, which assigns the stored drafts to `state.drafts` at start, before any page is mounted, and fires no change.

```js
// js/store.js (sketch)
export const state = {
  connection: 'connecting',    // 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'signedOut'
  connectionFailed: false,     // the last connect attempt failed: the catching-up pill stops spinning (TL-39)
  user: null, config: null, texts: null,
  rooms: [], users: {}, presence: {}, dms: [], unread: {}, mutes: null, emoji: null, favoriteGifIds: new Set(),
  emojiImages: null,           // where emoji pictures come from (render/text.js useImages)
  open: null,                  // { channelId, partner, messages, hasMore, hasNewer, restricted, typists: { username: expiresAt },
                               //   pins, fromDevice, loading }
  pending: [],                 // outbox rows of the open conversation, drawn as faded rows
  drafts: {},                  // conversation key -> { text, replyToId, replyToName }; a room by its id, a direct message by 'dm:' and the partner
  registrations: [],           // admins: the waiting list (AD-11)
  updateAvailable: false,      // the server runs a newer build (SH-20)
};

const listeners = new Map();   // part name -> Set of functions

export function on(part, fn) {           // call fn(detail) when this part changes; returns the function that stops it
  if (!listeners.has(part)) listeners.set(part, new Set());
  listeners.get(part).add(fn);
  return () => listeners.get(part).delete(fn);
}

export function changed(part, detail) {  // the writer calls this after it changed state
  for (const fn of listeners.get(part) ?? []) {
    try { fn(detail); } catch (e) { console.error(e); }   // one bad listener never stops the others
  }
}

export function applyBootstrap(doc) {    // replaces the shared data as a whole; see the wire contract, "Bootstrap"
  const emojiImages = doc.emojiImages ?? state.emojiImages;   // null when the rules the client holds are current
  Object.assign(state, { user: doc.user, config: doc.config, texts: doc.texts, rooms: doc.rooms,
    users: Object.fromEntries(doc.users.map(u => [u.username, u])), presence: doc.presence, dms: doc.dms,
    unread: doc.unread, mutes: doc.mutes, emoji: doc.emoji, favoriteGifIds: new Set(doc.favoriteGifIds), emojiImages });
  for (const part of ['emojiImages', 'user', 'config', 'texts', 'rooms', 'users', 'presence', 'dms', 'unread',
                      'mutes', 'emoji', 'favoriteGifIds']) changed(part);   // the rules first: the others draw names with them
}
```

The part names are the fields of the bootstrap document, plus `connection`, `open`, `messages`, `typists`, `pins`, `pending`, `drafts` and `registrations`. The parts `messages`, `typists` and `pins` are fields of `state.open`. The part `connection` also announces `updateAvailable` and `connectionFailed`. Two parts are events with no state: `incoming` (a hub message arrived) and `gifImport` (the progress of a GIF import). The header of `store.js` has the table of the parts and the detail that each part carries; for example, the detail of `messages` says what changed in the rows. There is no diffing. A component that listens to `rooms` redraws its room list. A room list has at most a few dozen rows, so a full redraw is cheap. The message list is the one component that updates rows in place, because it can hold hundreds of rows. The timeline page describes that.

`open.messages` is one range of the conversation with no gap. After an open it ends at the newest message (a tail). After a jump to a row that is not loaded (`setWindow`, TL-41) it is the window from the hub's `around`, and `open.hasNewer` is true. Other modules ask `atTail()` and do not read the field. In a window the store inserts no live message: `addMessage` signals `{ type: 'missed' }` and the timeline shows the pill. Edits, reactions, cards and deletes reach only the rows of the window. The way back is a fresh open (the chat page's `open`, the same as after a reconnect), and `setOpen` always makes a tail. The device stores no window (OF-14).

## The hub module

`hub.js` owns the SignalR connection. It keeps the connection alive, writes the hub messages into the store, and offers `invoke` and `send` to the ui modules. It also holds the device id, the heartbeat, the boot report (AD-41) and `looking()`, which says whether the person reads the open conversation (NT-07).

```js
// js/hub.js (sketch)
import * as store from './store.js';
import { api } from './api.js';

const connection = new signalR.HubConnectionBuilder()
  .withUrl(`/hub?device=${deviceId()}`,           // the device id is a random id in localStorage (AU-19)
    { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets })
  .build();

connection.on('message',        m => { store.changed('incoming', m); store.addMessage(m); });   // 'incoming' feeds the sound (NT-13)
connection.on('messageEdited',  m => store.replaceMessage(m));
connection.on('messageDeleted', (channelId, id) => store.removeMessage(channelId, id));
connection.on('reactions',      (id, reactions) => store.setReactions(id, reactions));
connection.on('previews',       (id, previews) => store.setPreviews(id, previews));
connection.on('typing',         (channelId, username, on) => store.setTyping(channelId, username, on));
connection.on('unread',         (channelId, count) => store.setUnread(channelId, count));
connection.on('presences',      list => store.setPresences(list));        // one tick of changes, in order
connection.on('profile',        u => store.setUser(u));
connection.on('accountDeleted', username => store.removeUser(username));
connection.on('rooms',          rooms => store.setRooms(rooms));
connection.on('pins',           (channelId, pins) => store.setPins(channelId, pins));
connection.on('dm',             dm => store.addDm(dm));
connection.on('me',             partial => store.mergeMe(partial));
connection.on('gifFavorites',   ids => store.setFavoriteGifs(ids));
connection.on('pending',        list => store.setRegistrations(list));    // the admins' waiting list (AD-11)
connection.on('gifImport',      progress => store.changed('gifImport', progress));
connection.on('signedOut',      () => signedOut());   // stop, then the handler main.js installs: session.signedOut({ elsewhere: true }) (AU-21)

connection.onclose(() => { store.setConnection(navigator.onLine ? 'reconnecting' : 'offline'); scheduleRetry(); });

export function onConnected(fn) { connectedHooks.add(fn); }   // the chat page re-opens its conversation, the sender posts the outbox

export async function connect() {
  store.setConnection(everConnected ? 'reconnecting' : 'connecting');
  try { await connection.start(); } catch { scheduleRetry(); return; }
  store.setConnection('connected');
  const [bootstrap] = await Promise.allSettled([api.get('/api/bootstrap'), ...[...connectedHooks].map(fn => fn())]);   // one round trip
  if (bootstrap.status === 'fulfilled') store.applyBootstrap(bootstrap.value);
}

export async function invoke(method, ...args) {        // the ui calls this; a refusal comes back as { error }
  if (!connected()) return { error: 'Needs a connection' };
  try { return await connection.invoke(method, ...args); }
  catch { return { error: 'Something went wrong' }; }
}

// Reconnect: a timer with a growing delay, capped at 30 s, plus an attempt at once on each of these (OF-13).
addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconnectNow(); });
export function reconnectNow() { ... }                 // the connection dot calls this on tap (SH-18)
```

The hub module does not import the sender. `sender.js` registers `hub.onConnected(wake)`, and the chat page registers its re-open the same way. After every connect the hooks run in parallel with the bootstrap request.

The client runs its own retry loop instead of SignalR's automatic reconnect. SignalR's reconnect stops after its list of delays ends, and it has no function for "try now". The spec wants a retry on `online`, on a visible tab, and on a tap of the dot, with no end (OF-13).

## The api module

`api.js` is a thin function over `fetch`. It sends and receives JSON, sends the cookie, and converts a refusal into a reason the ui can show. A `FormData` body goes as it is. The module imports nothing: `main.js` installs the handler of a 401, so `api.js` needs neither the router nor the store.

```js
// js/api.js (sketch)
export class ApiError extends Error { constructor(status, reason) { super(reason); this.status = status; } }

async function request(method, url, body) {
  const init = { method, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;                              // the browser sets the multipart boundary
  else if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError(0, 'Needs a connection'); }                       // network error (GEN-10)
  if (res.ok) return res.status === 204 ? null : res.json();
  if (res.status === 401) signedOutHandler();                                  // main.js installs session.signedOut({ elsewhere: true }): the login page says so (AU-21)
  const problem = await res.json().catch(() => null);
  throw new ApiError(res.status, problem?.detail ?? problem?.title ?? 'Something went wrong');   // ProblemDetails (GEN-02)
}

export const api = { get: url => request('GET', url), post: (url, body) => request('POST', url, body),
                     put: (url, body) => request('PUT', url, body), patch: (url, body) => request('PATCH', url, body),
                     delete: (url, body) => request('DELETE', url, body) };
```

## How a component is written

A component is a function. It receives the element it draws into. It draws from the store, subscribes to the parts it needs, and returns a function that removes the subscriptions. When its owner needs more, it returns an object with that function: the sidebar also returns `toggle`. Example: the room list of the sidebar.

```js
// js/ui/sidebar.js (sketch: the rooms of the sidebar)
import { state, on, isMuted, showsBell } from '../store.js';
import { clone, replace, classes } from '../render/dom.js';
import { inline } from '../render/text.js';
import * as router from '../router.js';

export function Sidebar(frame, profile) {           // frame.js passes the frame and the functions of its profile card
  function renderRooms() {
    replace(frame.querySelector('.rooms-list'), state.rooms.map(room => {
      const row = clone('t-room-row');                                   // <template id="t-room-row"> in index.html
      replace(row.querySelector('.room-name'), inline(room.name));       // an emoji in a name is an image too
      const isOpen = state.open?.channelId === room.id;
      const count = isOpen ? 0 : (state.unread[room.id] ?? 0);           // the open room shows no mark (SH-22)
      const muted = isMuted(room.id);
      classes(row, { active: isOpen, 'has-unread': count > 0 && !muted });
      row.querySelector('.mute-bell').hidden = !showsBell(room.id);
      row.querySelector('.unread-dot').hidden = !(count > 0 && muted);
      const badge = row.querySelector('.unread-badge');
      badge.hidden = !(count > 0 && !muted);
      badge.textContent = String(count);
      row.querySelector('.room-settings').hidden = !state.user.isAdmin;  // the gear
      row.addEventListener('click', () => router.navigate(router.roomPath(room, lobbyId())));
      return row;
    }));
  }
  const offs = ['rooms', 'unread', 'mutes', 'open', 'user'].map(part => on(part, renderRooms));
  renderRooms();
  return { toggle, unmount: () => offs.forEach(off => off()) };
}
```

`frame.js` mounts the frame once. Its `mount(appRoot)` clones `t-frame`, wires the header (the title, the status chip and its menu, the connection dot, the pin button, the mailbox and the hamburger), and returns the content column for the page. It also mounts the message search (`Search(frame, …)` of `search.js`), whose field is in the header. It calls `Sidebar(frame, profile)`, which draws the rooms and the people and returns `{ toggle, unmount }`. The profile card stays in `frame.js`. The sidebar gets the card's functions (`openProfile`, `closeProfile`, `toggleProfile`) as an argument, because an import of `frame.js` from `sidebar.js` would make a cycle. The people list does not draw every row: it lists every account (two thousand on the test server), so it draws the rows in view plus a margin, at most every 250 ms.

Rules every component follows:

- Text goes into the DOM with `textContent` or through `render/text.js`. No module of the client assigns `innerHTML`, and an icon comes from the icon set (below), not from a string of SVG. This is the whole XSS story.
- A component draws from the store only. It does not keep a second copy of the data.
- A user action changes the store first, then calls `api` or `hub`. The component redraws from the store at once (GEN-01). When the call fails, the action puts the store back and shows the reason (GEN-02). Example, a reaction:

```js
async function toggleReaction(message, emoji) {
  store.toggleReactionLocally(message.id, emoji, state.user.username);     // the pill changes now (MR-40)
  const result = await hub.invoke('react', message.id, emoji);
  if (result?.error) { store.toggleReactionLocally(message.id, emoji, state.user.username); showReason(rowOf(message), result.error); }
}
```

- A component never talks to SignalR. It calls `hub.invoke` or `hub.send`.
- A component sends HTTP through `api.*`. The sign-in pages (`login.js`, `verify.js`, `invite.js`) are the exception: they post the sign-in with `fetch`. The server refuses a wrong code with a 401, and `api.js` reads a 401 as a dead cookie and runs the signed-out handler. `login.js` also reads the status itself, because a 202 means that the sign-in waits for an admin's approval (AU-05), and `api.js` gives the caller the body only. The gallery also calls `fetch`, for the file that the share sheet sends. Outside the components, `upload.js` asks the TUS server for the state of a file, `scene.js` loads the time zone table, `hub.js` sends the IPv4 beacon, and `main.js` makes the installed app's hand-off (OF-03).

## The router and the pages

`router.js` maps the URL to a page module (SH-42). It listens to `popstate` for the back button (SH-44) and offers `navigate(path)` for links. It stores the last conversation route in localStorage, and `/` opens it (SH-43). A part of a page can add history entries that are not pages: `pushStep(onBack)` adds an entry with the same address, Back runs its callback and no page is mounted again, and `dropSteps()` removes the entries when their owner ends in another way. The message search at 768 px or less uses two steps, one for its result list and one for the message of a result (SR-27).

| Route | Page | Inside the frame |
| --- | --- | --- |
| `/`, `/lobby`, `/room/{id}`, `/dm/{username}` | `pages/chat.js` | yes |
| `/settings` | `pages/settings.js` | yes (ST-03) |
| `/channel/new`, `/channel/{id}/settings` | `pages/channel-settings.js` | yes |
| `/admin` | `pages/admin.js` | no (AD-01) |
| `/login`, `/verify/{username}`, `/invite/{code}` | `pages/login.js`, `verify.js`, `invite.js` | no |
| anything else | no page module; `main.js` draws the `t-not-found` template | no |

A page module exports one function, `mount(root, params)`. It returns the function that unmounts the page. The frame is mounted once and stays while the route moves between chat, settings and channel settings. Only the content column changes. This keeps the sidebar, the header and the hub connection alive across these pages (SH-01, ST-03).

```js
// js/pages/chat.js (sketch)
export function mount(root, params) {
  const timelineRoot = el('div', { class: 'timeline-root', style: { display: 'contents' } });
  const composerRoot = el('div', { class: 'composer-root', style: { display: 'contents' } });
  root.replaceChildren(timelineRoot, composerRoot);
  const unmounts = [Timeline(timelineRoot, { reopen: () => open() }), Composer(composerRoot)];
  const target = resolve(params);               // a room or a direct message; an unknown one leads to the lobby (SH-43)
  paintStored(target);                          // the device's copy of the tail at once (TL-02)
  const open = () => openConversation(target);  // openRoom or openDm on the hub; the answer replaces the copy
  open();
  const offConnected = hub.onConnected(open);   // after a reconnect: the newest messages again (TL-35)
  return () => { offConnected(); unmounts.forEach(u => u()); closeOpen(); };
}
```

A new route goes into more places than the table of `router.js`. The comment at that table names them: `main.js` (`pages`, and `framed` or `anonymous`), the pages that `session.js` returns to after a sign-in, and the server's `Routes` in `Endpoints/ShellEndpoints.cs`, which also gives the service worker its route list.

## Start-up

1. The browser loads `index.html`. The service worker answers it, and every file of the shell, from the device's copy (OF-18), so nothing waits for the network before the first paint; a first visit and a new build fetch them. The root, the login page, the verification page and an invite are different: the worker asks the server first there, because the server answers a signed-out visitor differently (the welcome page, AD-36), and the stored page is the fallback without a network. An inline script reads the cached theme and text size from localStorage and sets them on `<html>`, before the first paint. Without this the page would flash the default theme. The same script sets the Tea House scene (ST-09): it computes sunrise and sunset for the place `scene.js` stored (the device's time zone city) and divides the day among seven scenes and the night among five.
2. The browser loads `main.js` and its imports. The server writes an import map and a `<link rel="modulepreload">` for every module into `index.html` (`ShellAssets`), so every module has a URL with the build stamp and the browser requests all of them at once instead of one level at a time.
3. `main.js` reads the stored bootstrap document from IndexedDB and applies it: the frame paints with the last known state, and the chat page paints the stored tail of the conversation (TL-02), under a "Catching up…" pill until the server answers (TL-39). `hub.connect()` starts at once. Without a stored document (a first load, or after a sign-out) `main.js` requests `GET /api/bootstrap` first: without `user` in the answer, the router shows the login, verify or invite page with the texts from the answer.
4. The hub connects over a direct WebSocket, without the negotiate round trip. When that socket does not open, it builds the connection again with negotiation and every transport, and keeps that for the page.
5. When the hub is connected, the hub module requests the bootstrap and runs the connected hooks, in parallel. The chat page's hook opens the current conversation. The document replaces the stored one, and no change can fall between it and the first hub message (wire contract, "Bootstrap"). A load with a stored copy makes this one bootstrap request and no other.
6. The sender's hook wakes the sender, and it posts the outbox (OF-10).

A reconnect runs step 5 and 6 only. The view keeps its position, the draft and the pending rows stay (TL-35).

## Overlays and input rules

`ui/overlays.js` owns one stack of open layers: menus, the reaction picker, the pins panel, sheets, dialogs, the gallery. Escape closes the top layer only (GEN-17). A tap outside a layer closes it. On a window of 600 px or less, a menu or a picker opens as a bottom sheet over a dimmed page (GEN-18). The width tier is a CSS media query; the JavaScript reads the same query with `matchMedia` where it must choose a behaviour (IB-08, GEN-14).

The emoji picker and the GIF picker of the input box are not on the stack. `composer.js` closes them by the rules of IB-42 and IB-43. Its own Escape handler closes a picker only while the stack is empty, so a dialog above the picker closes first (IB-17).

## The icon set

Every drawing of an icon exists once, as `<symbol id="i-name">` inside `<template id="t-icons">` in `index.html`. A template uses an icon with `<svg data-icon="name">`. The first `clone()` of a template copies the symbol's attributes and drawing into each such `<svg>` of the template itself, so every later clone is plain inline SVG at no extra cost. JavaScript that builds a node calls `icon(name, attrs)` from `render/dom.js`. An attribute that the use sets stays: the theme card draws the check with a heavier stroke than the symbol's.

A use is a copy, not a `<use href="#i-name">` reference. The page has `<base href="/">`, so a fragment reference means the document "/". That document is this page on the root route only, and browsers differ in whether they look for the target in the page. A copy also leaves nothing to resolve.

## Templates and JavaScript

`index.html` holds a `<template>` for the frame and for every component, and `clone(id)` returns a copy of its first element. The JavaScript finds the parts of a copy by these conventions:

- A class finds a part of a template, for example `row.querySelector('.room-name')`.
- A `data-` attribute picks one item of a set: the actions of a menu (`[data-action="settings"]`), the statuses of the status menu (`[data-status]`), the tabs of a picker (`data-tab`, `data-combined-tab`).
- An id is for a label and its `for` attribute, or for a single element at the body level (`#app`, `#notice`, `#start-loading`). Two more uses exist. The hash of a route names a section (`/settings#notification-settings`), and a message row has the id `msg-{id}`, so a late answer finds the row after a redraw replaced its node.
- A bare tag selector finds an element only when the template, or the part of it, has one element of that kind: the `h3` of `t-header-back`, the `strong` of the reply bar.
- The browser tests in `tests/browser` select many elements by class name. A change of a class name must also change the tests.

## What is not in the client

- No framework, no virtual DOM, no bundler, no transpiler. The files in `wwwroot/js` are what the browser runs.
- No HTML from the server. The server sends data.
- No second copy of history. The timeline holds the open conversation only. The snapshot store holds the last tail per conversation for offline reads (OF-06). The outbox holds unsent messages (OF-08). The key-value store holds the drafts (IB-53). Nothing else of the conversations is stored in IndexedDB. The service worker keeps the pictures and videos of the conversations in its media cache, for reading offline.
- No merge logic. The bootstrap replaces, the events update.
