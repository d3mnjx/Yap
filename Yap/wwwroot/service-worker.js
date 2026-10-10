importScripts('/chat-client/worker.js');
// Service Worker for Yap PWA
// Handles: push notifications, badge updates, notification clicks
// Blazor Server requires live connection, so minimal caching

const CACHE_NAME = 'yap-v2';
// Separate cache for content-addressed media (user uploads, cached gifs/media). GUID/hash
// filenames are never reused, so these are served cache-first and intentionally survive SW updates.
const MEDIA_CACHE = 'yap-media-v1';

// Install: cache essential assets and activate immediately
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache
                .addAll(['/icon.svg', '/icon-192.png', '/icon-512.png', '/notif.mp3'])
                .catch(() => {
                    // Ignore cache failures for missing files
                });
        }),
    );
    self.skipWaiting();
});

// Activate: clean up old caches and take control
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker');
    event.waitUntil(
        caches
            .keys()
            .then((cacheNames) => {
                const keep = [CACHE_NAME, MEDIA_CACHE];
                return Promise.all(
                    cacheNames
                        .filter((name) => !keep.includes(name) && !name.startsWith('yap-chat-'))
                        .map((name) => caches.delete(name)),
                );
            })
            .then(() => self.clients.claim()),
    );
});

// Fetch: network-first (Blazor Server needs live connection)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    // The client worker owns these fetches; responding twice would break media/range recovery.
    if (
        url.origin === self.location.origin &&
        (CHAT_ASSETS.includes(url.pathname) ||
            isChatNavigation(url.pathname) ||
            url.pathname === '/' ||
            url.pathname === '/pwa-launch' ||
            url.pathname.startsWith('/auth/') ||
            /^\/(uploads|gif-cache|gif-uploads|media-cache|chat-client\/emoji|emoji-packs|emoji-fallback|custom-emojis)\//.test(
                url.pathname,
            ))
    )
        return;
    if (event.request.method !== 'GET' || event.request.headers.has('X-Yap-Chat-Media')) return;
    if (url.pathname.includes('_blazor')) return;

    // App-shell icons + notification sound: cache-first against the versioned app cache.
    const staticAssets = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/notif.mp3'];
    if (staticAssets.some((asset) => url.pathname.endsWith(asset))) {
        event.respondWith(cacheFirst(event.request, CACHE_NAME));
        return;
    }

    // Content-addressed media (uploads, cached gifs/media). GUID/hash filenames are immutable, so
    // cache-first lets cold PWA launches paint instantly without re-downloading multi-MB files.
    // Excludes: profile pictures (stable url, overwritten on avatar change — let the network's
    // short max-age handle freshness) and range requests (the Cache API can't serve partial
    // content for video/audio seeking; the HTTP immutable cache covers those instead).
    const mediaPrefixes = ['/uploads/', '/gif-cache/', '/media-cache/'];
    if (
        url.origin === self.location.origin &&
        mediaPrefixes.some((p) => url.pathname.startsWith(p)) &&
        !url.pathname.startsWith('/uploads/profiles/') &&
        !event.request.headers.has('range')
    ) {
        event.respondWith(cacheFirst(event.request, MEDIA_CACHE));
        return;
    }
});

// Cache-first: serve from the named cache, else fetch and cache successful responses.
// On network failure, fall back to any cached copy (or a network error).
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch (err) {
        return (await cache.match(request)) || Response.error();
    }
}

// ==========================================
// Push Notification Handler
// ==========================================
self.addEventListener('push', (event) => {
    console.log('[SW] Push received:', event);

    let data = {
        title: 'New Message',
        body: 'You have a new message',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'chat-message',
        url: '/',
        unreadCount: 0,
    };

    // Parse push payload
    if (event.data) {
        try {
            const payload = event.data.json();
            data = { ...data, ...payload };
        } catch (e) {
            console.error('[SW] Error parsing push data:', e);
            data.body = event.data.text();
        }
    }

    const promises = [];

    // Update badge count. The server already excluded muted channels from this number.
    if ('setAppBadge' in self.navigator && data.unreadCount > 0) {
        promises.push(
            self.navigator
                .setAppBadge(data.unreadCount)
                .catch((err) => console.error('[SW] Badge error:', err)),
        );
    }

    // Show the banner. There is no badge-only mode any more: muting is decided on the server,
    // and a muted channel sends no push at all (it only keeps its unread dot in the app).
    promises.push(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon,
            badge: data.badge,
            tag: data.tag,
            renotify: true,
            requireInteraction: false,
            data: { url: data.url },
        }),
    );

    // Delivery receipt (best-effort): closes the gap between "push service accepted the send" and
    // "this device actually received it" — Settings shows the last confirmed delivery per device.
    promises.push(
        self.registration.pushManager
            .getSubscription()
            .then(
                (sub) =>
                    sub &&
                    fetch('/api/push/delivered', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            endpoint: sub.endpoint,
                            tag: data.tag,
                            shown: true,
                        }),
                    }),
            )
            .catch(() => {}), // a failed receipt must never affect the notification itself
    );

    event.waitUntil(Promise.all(promises));
});

// ==========================================
// Notification Click Handler
// ==========================================
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event);
    event.notification.close();

    let urlToOpen = '/lobby';
    try {
        const destination = new URL(event.notification.data?.url || '/lobby', self.location.origin);
        if (destination.origin === self.location.origin && isChatNavigation(destination.pathname))
            urlToOpen = destination.pathname + destination.search;
    } catch {}

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Check if app is already open
            for (const client of windowClients) {
                if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                    // Navigate existing window
                    client.postMessage({
                        type: 'NOTIFICATION_CLICK',
                        url: urlToOpen,
                    });
                    return client.focus();
                }
            }
            // Open new window
            return clients.openWindow(urlToOpen);
        }),
    );
});

// ==========================================
// Message Handler (from main app)
// ==========================================
self.addEventListener('message', (event) => {
    console.log('[SW] Message received:', event.data);

    if (event.data?.type === 'SKIP_WAITING') {
        event.waitUntil(self.skipWaiting());
    }

    if (event.data?.type === 'SET_BADGE') {
        const count = event.data.count;
        if ('setAppBadge' in self.navigator) {
            if (count > 0) {
                self.navigator.setAppBadge(count);
            } else {
                self.navigator.clearAppBadge();
            }
        }
    }

    if (event.data?.type === 'CLEAR_BADGE') {
        if ('clearAppBadge' in self.navigator) {
            self.navigator.clearAppBadge();
        }
    }
});

// ==========================================
// Subscription Change Handler
// ==========================================
// Browsers rotate/expire push subscriptions (common on iOS, and after the server prunes a 410/404).
// When that happens the browser fires `pushsubscriptionchange`; we re-subscribe and re-register with
// the server so notifications keep working WITHOUT the user re-granting permission. Best-effort —
// support is limited on iOS Safari but present on Chromium/Android.
self.addEventListener('pushsubscriptionchange', (event) => {
    console.log('[SW] pushsubscriptionchange — re-subscribing');
    event.waitUntil(resubscribeToPush());
});

async function resubscribeToPush() {
    try {
        // Service workers can't use Blazor services, so fetch the VAPID key over HTTP.
        const keyResp = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
        if (!keyResp.ok) {
            console.warn('[SW] resubscribe: VAPID key unavailable', keyResp.status);
            return;
        }
        const { publicKey } = await keyResp.json();
        if (!publicKey) return;

        const subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        const sub = subscription.toJSON();
        // /api/push/subscribe authenticates via the auth cookie and reads the username from it.
        const resp = await fetch('/api/push/subscribe', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: sub.endpoint,
                p256dh: sub.keys?.p256dh,
                auth: sub.keys?.auth,
            }),
        });
        console.log('[SW] resubscribe: server responded', resp.status);
    } catch (e) {
        console.error('[SW] resubscribe failed:', e);
    }
}

// Helper: Convert a base64url VAPID key to Uint8Array (mirrors urlBase64ToUint8Array in chat.js).
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
