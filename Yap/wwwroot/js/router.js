// URL to page (SH-42). The back button works because every navigation is a history entry (SH-44). The
// last conversation route is kept in localStorage, and '/' opens it (SH-43).

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
  addEventListener('popstate', () => { current = parse(location.pathname + location.hash); handler(current); });
  handler(current);
}

export function navigate(path, { replace = false } = {}) {
  if (path === '/') path = read(LAST_ROUTE) || '/lobby';   // SH-43
  if (path === location.pathname + location.hash && !replace) return;
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
