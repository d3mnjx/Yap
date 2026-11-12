// URL to page (SH-42). The back button works because every navigation is a history entry (SH-44). The
// last conversation route is kept in localStorage, and '/' opens it (SH-43). A part of a page can add history
// entries of its own, the steps below (SR-27).

const LAST_ROUTE = 'yap.lastRoute';
const FRESH_LOAD_TO = 'yap.freshLoadTo';   // one route for the next load only: a fresh load of a new build comes in through '/'

// A route lives in more places than this table. main.js loads a page from `pages` and puts it in `framed` or in
// `anonymous`. session.js keeps a list of the account's pages that a sign-in returns to (signedOut). The server
// answers only the paths in Endpoints/ShellEndpoints.cs Routes with the shell, and the service worker gets its route
// list from there. A sign-in page, which the server answers differently for a signed-out visitor, is also in
// SERVER_FIRST of update.js and of service-worker.js.
const patterns = [
  [/^\/$/, () => ({ page: 'chat', lobby: true })],
  [/^\/lobby$/, () => ({ page: 'chat', lobby: true })],
  [/^\/room\/([0-9a-f-]{36})$/, m => ({ page: 'chat', roomId: m[1] })],
  [/^\/dm\/([^/]+)$/, m => ({ page: 'chat', dmUser: decodeURIComponent(m[1]) })],
  [/^\/settings$/, () => ({ page: 'settings' })],
  [/^\/channel\/new$/, () => ({ page: 'channel-settings', isNew: true })],
  [/^\/channel\/([0-9a-f-]{36})\/settings$/, m => ({ page: 'channel-settings', channelId: m[1] })],
  [/^\/admin$/, () => ({ page: 'admin' })],
  [/^\/login$/, () => ({ page: 'login' })],
  [/^\/verify\/([^/]+)$/, m => ({ page: 'verify', username: decodeURIComponent(m[1]) })],
  [/^\/invite\/([^/]+)$/, m => ({ page: 'invite', code: m[1] })],
];

function parse(full) {
  const [path, hash = ''] = full.split('#');
  for (const [pattern, build] of patterns) {
    const m = pattern.exec(path);
    if (m) return { path, hash, ...build(m) };
  }
  return { path, hash, page: 'not-found' };
}

let handler = () => {};
export let current = parse(location.pathname + location.hash);   // the hash picks a tab (AD-02), so a load keeps it

export function onRoute(fn) { handler = fn; }

// '/' means "where I was" (SH-43). The URL is rewritten so a reload lands on the same conversation.
export function start() {
  current = parse(location.pathname + location.hash);   // main.js rewrites the installed app's launch address to '/' before this
  if (current.path === '/') {
    const last = takeFreshLoadRoute() || read(LAST_ROUTE) || '/lobby';
    history.replaceState(null, '', last); current = parse(last);
  }
  // A reload keeps the state of the entry it happened on, but not the callbacks of the steps. A step state from
  // before the reload would count as an open step: the first search after the reload would add a second entry with
  // the same depth, and the first Back would land on it and close nothing.
  if (history.state?.step) history.replaceState(null, '');
  addEventListener('popstate', e => {
    const next = parse(location.pathname + location.hash);
    if (next.path === current.path && next.hash === current.hash) { moveInPage(e.state?.step ?? 0); return; }
    steps = [];   // another page: its mount ends whatever had steps, and their entries stay behind in the history
    current = next; handler(current);
  });
  handler(current);
}

// ---- steps: history entries that are not pages (SR-27) ----
// A page is drawn again on every history move (the handler above unmounts and mounts it), which would reset an open
// conversation. A step is an entry with the same address and a callback for Back: the narrow search adds one for
// its result list and one for the message of a result, so the Back of the phone and of the browser go one screen
// back, as the header's arrow does. The entry carries its depth in the history state; the callbacks live here.
// This module owns the count and the removal: a caller never moves the history itself.
let steps = [];   // the Back callbacks of the open steps, the oldest first

export function pushStep(onBack) {
  steps.push(onBack);
  history.pushState({ step: steps.length }, '');
}

// The owner of the steps ended by another way than Back: its entries leave the history. Nothing moves when no step
// is open, which is also the case after a navigation: navigate() and a move to another page forget the steps first,
// and a history.go from here would then walk off the new page.
export function dropSteps() {
  const count = steps.length;
  steps = [];
  if (count) history.go(-count);
}

// A history move that stays on the page. Back closes the steps above the new depth, the newest first. Forward can
// land on the entry of a step that is closed (its callback is gone): the history goes back to the open depth, so
// the next Back is not a press that does nothing.
function moveInPage(depth) {
  if (depth > steps.length) { history.go(steps.length - depth); return; }
  while (steps.length > depth) steps.pop()();
}

export function navigate(path, { replace = false } = {}) {
  if (path === '/') path = read(LAST_ROUTE) || '/lobby';   // SH-43
  if (path === location.pathname + location.hash && !replace) return;
  steps = [];   // see dropSteps: the page that had steps is about to unmount
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  current = parse(path);
  handler(current);
}

export function rememberRoute(path) { write(LAST_ROUTE, path); }

// The route a fresh load of a new build comes back to. The load goes in through '/' so that the server answers it
// (update.js reloadForNewBuild), and '/' alone would open the last conversation (SH-43), not the settings page the
// person was on. Session storage: the same tab, the next load only.
export function keepForFreshLoad(route) { try { sessionStorage.setItem(FRESH_LOAD_TO, route); } catch { /* private mode: '/' opens the last conversation */ } }
function takeFreshLoadRoute() {
  try { const route = sessionStorage.getItem(FRESH_LOAD_TO); if (route) sessionStorage.removeItem(FRESH_LOAD_TO); return route; }
  catch { return null; }
}

export function roomPath(room, lobbyId) { return room.id === lobbyId ? '/lobby' : `/room/${room.id}`; }
export function dmPath(username) { return `/dm/${encodeURIComponent(username)}`; }

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ } }
