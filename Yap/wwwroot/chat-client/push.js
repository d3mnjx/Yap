// Compatible with both the module worker and the one-time classic upgrade bridge.
// Push delivery shares the root module worker with the offline shell.
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
        if (
            destination.origin === self.location.origin &&
            globalThis.yapWorkerCommon.isChatNavigation(destination.pathname)
        )
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
            applicationServerKey: globalThis.yapWorkerCommon.urlBase64ToUint8Array(publicKey),
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
