// The service worker: the shell from the device, the emoji and media caches, push and notification taps
// (offline.md, offline-design-notes.md). It never serves the API from a cache and never reloads a page.
//
// The server writes this file out with the build stamp, the list of shell files and the client routes
// (ShellEndpoints, ShellAssets): a new build is a new worker, which precaches the new shell into its own cache and
// deletes the old ones at activate. The shell and its files are cache-first (OF-18): a page runs the build its
// worker installed, with no round trip before the paint, and the new-version strip asks for a reload when the server
// has a newer build (SH-20). Every script and stylesheet URL carries the build stamp (?v=), so an entry in the cache
// never means something else later. Emoji images and content-addressed media are cache-first too: their names never
// change meaning. The browser fetches this file at every registration and installs it anew when a byte changed.

const BUILD = '{{build}}';
const SHELL_CACHE = `yap-shell-${BUILD}`;
// One emoji cache, cache-first, for every emoji image: the rows', the names', the reactions' and the picker's grid.
// The emoji set itself bounds it (a few thousand small files), it is never pruned, and it is what lets the picker
// work without a network. A repeated image is answered from the worker's memory (rememberedFirst), so a redraw of
// the rows costs no storage read. Two detours of 2026-10-31 are gone: a cache of its own for the picker changed
// nothing, and the picker bypassing the worker for the browser's HTTP cache left it to a cache the browser may drop;
// both gave a picked emoji a path of its own, and the row drew an empty box until the CDN answered. The caches of
// earlier builds (yap-emoji-v1, yap-emoji-picker-v1) go at activate.
const EMOJI_CACHE = 'yap-emoji-v2';
const MEDIA_CACHE = 'yap-media-v1';

// What the shell needs to paint without a network, from one scan of wwwroot at startup. The page itself is stored
// under /login: every client route answers the same document, and /login is the one that never redirects.
const SHELL_URLS = {{shell}};
// The client routes (ShellEndpoints.Routes) and the installed app's launch URL. The root, the login page, the
// verification page and an invite ask the server first: it answers a signed-out visitor differently there (the
// welcome page, AD-36; the visitor log, AD-20). The stored shell is their fallback without a network (OF-06).
const ROUTES = new RegExp('^(?:{{routes}}|/pwa-launch)$');
const SERVER_FIRST = /^\/(?:login|verify\/[^/]+|invite\/[^/]+)?$/;
const EMOJI_HOSTS = ['cdn.jsdelivr.net'];
const EMOJI_PATHS = ['/emoji-fallback/', '/emoji-packs/', '/custom-emojis/'];
const MEDIA_PATHS = ['/uploads/', '/gif-cache/', '/media-cache/'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(SHELL_CACHE).then(cache =>
        // One missing file must not stop the install: add what the server has.
        Promise.all(SHELL_URLS.map(url => cache.add(url).catch(() => {})))));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(names => Promise.all(names.filter(n => ![SHELL_CACHE, EMOJI_CACHE, MEDIA_CACHE].includes(n)).map(n => caches.delete(n))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        if (EMOJI_HOSTS.includes(url.host)) event.respondWith(rememberedFirst(request));
        return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub')) return;   // live data, never cached

    // A navigation to a client route: the stored shell, whatever the path. The installed app launches at
    // /pwa-launch: the shell answers it too, and the page finishes the sign-in hand-off itself (main.js). Any
    // other navigation (an upload opened in a new tab, an unknown path) goes to the server.
    if (request.mode === 'navigate') {
        if (SERVER_FIRST.test(url.pathname)) event.respondWith(fetch(request).catch(() => shell()));
        else if (ROUTES.test(url.pathname)) event.respondWith(shell(request));
        return;
    }
    if (isShellAsset(url.pathname)) { event.respondWith(cacheFirst(request, SHELL_CACHE)); return; }
    if (EMOJI_PATHS.some(p => url.pathname.startsWith(p))) { event.respondWith(rememberedFirst(request)); return; }
    // Content-addressed media. Profile pictures keep a stable URL and are left to the HTTP cache; range
    // requests cannot be served from the Cache API.
    if (MEDIA_PATHS.some(p => url.pathname.startsWith(p)) && !url.pathname.startsWith('/uploads/profiles/') && !request.headers.has('range')) {
        event.respondWith(cacheFirst(request, MEDIA_CACHE));
    }
});

function isShellAsset(pathname) {
    return /\.(js|css|woff2|svg|png|webp|mp3)$/.test(pathname) && !MEDIA_PATHS.some(p => pathname.startsWith(p)) && !EMOJI_PATHS.some(p => pathname.startsWith(p));
}

// The stored page, or the server's when the install has not stored one yet (a first visit). The install is the only
// writer of the /login entry: a navigation's own answer is never stored, because the server answers some paths with
// something else (the welcome page at the root).
async function shell(request = null) {
    const cached = await (await open(SHELL_CACHE)).match('/login');
    if (cached) return cached;
    return request ? fetch(request).catch(() => Response.error()) : Response.error();
}

// The cache, and the network for a miss, with a copy into the cache for later. An opaque entry (a script tag's
// no-cors fetch) is no answer for a CORS request such as an emoji <img crossorigin>: the browser would show a
// broken picture. Such a pair fetches again and the real answer wins.
async function cacheFirst(request, cacheName) {
    const cache = await open(cacheName);
    const cached = await cache.match(request);
    if (cached && !(cached.type === 'opaque' && request.mode === 'cors')) return cached;
    try {
        const response = await fetch(request);
        // a 206 range answer cannot be cached
        if (response.status === 200 || response.type === 'opaque') cache.put(request, response.clone()).catch(() => {});
        return response;
    } catch {
        return Response.error();
    }
}

// One open per cache for the life of the worker: the emoji of a cold open all ask in the same moment, and each
// caches.open is a round trip to the storage process.
const opened = new Map();
function open(name) {
    if (!opened.has(name)) opened.set(name, caches.open(name));
    return opened.get(name);
}

// Every emoji image, answered from the worker's own memory after the first time. On the iPhone every <img> element is
// a request of its own, the same emoji four times within a millisecond, and a cold open asked for 876 of them; each
// read of the storage took about 3 ms and they ran one after another, 2.6 s until the last emoji showed (2026-10-31,
// the Settings debug card). The first request of a URL reads the storage, or the network, once; the requests that
// follow, concurrent or later, share its answer for the life of the worker. A failed answer is not kept: the next
// request tries again. The picker's grid passes through here too, each emoji once, so the memory fills as the
// person scrolls; when it is full it starts over, and the rows read the storage once more.
const remembered = new Map();   // url -> Promise<{ status, headers, body } | null>
const REMEMBER_MAX = 1000;      // a few kilobytes each
function rememberedFirst(request) {
    if (!remembered.has(request.url)) {
        if (remembered.size >= REMEMBER_MAX) remembered.clear();
        remembered.set(request.url, cacheFirst(request, EMOJI_CACHE)
            .then(async response => response.ok && response.type !== 'opaque' ? { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() } : null)
            .catch(() => null));
    }
    return remembered.get(request.url).then(answer => {
        if (answer) return new Response(answer.body, { status: answer.status, headers: answer.headers });
        remembered.delete(request.url);
        return Response.error();
    });
}

// ---- push (NT-23 to NT-29) ----

self.addEventListener('push', event => {
    let data = { title: 'New Message', body: 'You have a new message', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'chat-message', url: '/', unreadCount: 0 };
    if (event.data) {
        try { data = { ...data, ...event.data.json() }; }
        catch { data.body = event.data.text(); }
    }
    const work = [];
    // The badge: the server already left out the muted conversations (NT-11).
    if ('setAppBadge' in self.navigator && data.unreadCount > 0) work.push(self.navigator.setAppBadge(data.unreadCount).catch(() => {}));
    // A new notification of a conversation replaces the previous one and alerts again (NT-27).
    work.push(self.registration.showNotification(data.title, {
        body: data.body, icon: data.icon, badge: data.badge, tag: data.tag, renotify: true, requireInteraction: false, data: { url: data.url },
    }));
    // A delivery receipt, best effort: Settings shows the last confirmed delivery per device.
    work.push(self.registration.pushManager.getSubscription()
        .then(sub => sub && fetch('/api/push/delivered', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, tag: data.tag, shown: true }) }))
        .catch(() => {}));
    event.waitUntil(Promise.all(work));
});

// A tap opens the conversation in an open window, or in a new one (NT-28).
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
        for (const client of windows) {
            if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                client.postMessage({ type: 'NOTIFICATION_CLICK', url });
                return client.focus();
            }
        }
        return clients.openWindow(url);
    }));
});

// Browsers rotate push subscriptions (iOS often, and after the server prunes a dead one). The worker
// subscribes again and tells the server, so notifications keep working without a new permission prompt.
self.addEventListener('pushsubscriptionchange', event => { event.waitUntil(resubscribe()); });

async function resubscribe() {
    try {
        const keyResponse = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
        if (!keyResponse.ok) return;
        const { publicKey } = await keyResponse.json();
        if (!publicKey) return;
        const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
        const sub = subscription.toJSON();
        await fetch('/api/push/subscribe', {   // the cookie names the account
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint, p256dh: sub.keys?.p256dh, auth: sub.keys?.auth }),
        });
    } catch { /* best effort */ }
}

function base64UrlToBytes(value) {
    const padded = value + '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}
