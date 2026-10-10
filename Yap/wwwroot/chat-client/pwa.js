import { get, post } from './api.js';
import * as storage from './storage.js';
const installed = () =>
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const chatPath = (path) => /^\/(chat|lobby)\/?$/.test(path) || /^\/(room|dm)\/[^/]+\/?$/.test(path);
const safeRoute = (value) => {
    try {
        const url = new URL(value, location.origin);
        return url.origin === location.origin && chatPath(url.pathname)
            ? url.pathname + url.search
            : null;
    } catch {
        return null;
    }
};
let deferredInstall, guide;
window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
});
export async function installGuide(nativePrompt) {
    nativePrompt ||= deferredInstall;
    if (nativePrompt) deferredInstall = nativePrompt;
    sessionStorage.setItem('pwa-banner-dismissed', 'true');
    // An old manifest ID cannot be reliably detected from a browser tab. Let someone
    // keep using their existing icon instead of driving a second installation prompt.
    const dialog = document.createElement('dialog');
    dialog.className = 'install-guide';
    dialog.setAttribute('aria-labelledby', 'install-guide-title');
    const title = document.createElement('h2');
    title.id = 'install-guide-title';
    title.textContent = installed() ? 'Yap is already installed' : 'Add Yap to your home screen';
    const text = document.createElement('p');
    text.textContent = installed()
        ? 'Keep using this app. You do not need to install it again.'
        : 'Already have a Yap icon? Open it to keep using your app. To replace an older install, save your login link in Settings, remove the old icon, then install here.';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = installed() ? 'Close' : 'Use existing app';
    const choice = new Promise((resolve) => {
        close.onclick = () => {
            dialog.close();
            resolve(false);
        };
        dialog.addEventListener('cancel', () => resolve(false));
        dialog.append(title, text, close);
        if (!installed()) {
            const install = document.createElement('button');
            install.type = 'button';
            install.textContent = 'Install app';
            install.onclick = () => {
                // Invoke the browser prompt directly inside this user gesture.
                const prompt = nativePrompt ? nativePrompt.prompt() : null;
                dialog.close();
                resolve({ prompt });
            };
            dialog.append(install);
        }
    });
    document.body.append(dialog);
    dialog.showModal();
    const selected = await choice;
    dialog.remove();
    if (!selected) return;
    if (nativePrompt) {
        deferredInstall = null;
        await selected.prompt;
        await nativePrompt.userChoice;
        return;
    }
    const base = '/chat-client/vendor/add-to-homescreen-3.5';
    guide ??= new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = base + '/add-to-homescreen.min.css';
        document.head.append(css);
        const script = document.createElement('script');
        script.src = base + '/add-to-homescreen.min.js';
        script.onload = resolve;
        script.onerror = () => {
            guide = null;
            reject(Error('Install instructions are unavailable. Open Settings while connected.'));
        };
        document.head.append(script);
    });
    await guide;
    window
        .AddToHomeScreen?.({
            appName: 'Yap',
            appIconUrl: '/icon-192.png',
            assetUrl: base + '/assets/img/',
            allowClose: true,
            showArrow: true,
        })
        .show('en');
}
const decode = (value) =>
    Uint8Array.from(
        atob(
            value
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(value.length / 4) * 4, '='),
        ),
        (c) => c.charCodeAt(0),
    );
export function createPwa({ identity, navigate, notice }) {
    let initialized,
        shown,
        running = false,
        prompt;
    const supported = () =>
        'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
    const close = () => {
        prompt?.remove();
        prompt = null;
    };
    async function register(publicKey, owner) {
        let registration = await navigator.serviceWorker.getRegistration();
        const key = decode(publicKey);
        if (!registration)
            throw Error('Notification service is unavailable. Reconnect and try again.');
        // First load can reach chat before the shell finishes installing; subscription needs an active worker.
        if (!registration.active) registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            const previous = new Uint8Array(subscription.options?.applicationServerKey || []);
            if (previous.length !== key.length || previous.some((n, i) => n !== key[i])) {
                await subscription.unsubscribe();
                subscription = null;
            }
        }
        subscription ??= await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
        });
        // The browser subscription belongs to the shared profile; bind it only to the current cookie account.
        const session = await get('session');
        if (session.userId !== owner.userId || identity()?.epoch !== owner.epoch) return;
        const data = subscription.toJSON();
        const response = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Yap-Chat-User': owner.userId },
            body: JSON.stringify({
                endpoint: data.endpoint,
                p256dh: data.keys?.p256dh,
                auth: data.keys?.auth,
            }),
        });
        if (!response.ok)
            throw Error('Notification subscription could not be saved. Try again in Settings.');
        document.dispatchEvent(new Event('client-badge-refresh'));
    }
    function show(publicKey, owner) {
        if (shown === owner.epoch) return;
        shown = owner.epoch;
        close();
        prompt = document.createElement('div');
        prompt.className = 'push-prompt-overlay';
        prompt.setAttribute('role', 'dialog');
        prompt.setAttribute('aria-label', 'Enable notifications');
        // This is fixed original UI copy, never user-provided HTML.
        prompt.innerHTML =
            '<div class="push-prompt-card"><div class="push-prompt-icon"><svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/></svg></div><h2 class="push-prompt-heading">One more step</h2><p class="push-prompt-body">Please enable notifications so Yap can send you notifs about new DM messages / mentions when the app is not open. You can always change this later in Settings, and you can also disable notifications temporarily.</p><button class="push-prompt-enable">Enable Notifications</button><button class="push-prompt-later">Maybe Later</button></div>';
        const enable = prompt.querySelector('.push-prompt-enable');
        enable.onclick = async () => {
            enable.disabled = true;
            try {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') await register(publicKey, owner);
                close();
            } catch (error) {
                enable.disabled = false;
                notice(error.message);
            }
        };
        prompt.querySelector('.push-prompt-later').onclick = () => {
            localStorage.setItem(
                'push-prompt-dismiss-count',
                String((Number(localStorage.getItem('push-prompt-dismiss-count')) || 0) + 1),
            );
            close();
        };
        document.body.append(prompt);
    }
    async function start(session) {
        const owner = identity();
        if (!owner || running || initialized === owner.epoch) return;
        running = true;
        try {
            if (installed()) await post('pwa/installed', {}, session);
            if (!supported()) {
                initialized = owner.epoch;
                return;
            }
            const response = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
            if (!response.ok) {
                if (response.status === 404) initialized = owner.epoch;
                return;
            }
            const { publicKey } = await response.json();
            if (identity()?.epoch !== owner.epoch) return;
            if (Notification.permission === 'granted') await register(publicKey, owner);
            else if (
                installed() &&
                Notification.permission === 'default' &&
                (Number(localStorage.getItem('push-prompt-dismiss-count')) || 0) < 3
            )
                show(publicKey, owner);
            if (identity()?.epoch === owner.epoch) initialized = owner.epoch;
        } catch {
            /* Transient registration failures retry on reconnect; Settings retains explicit recovery. */
        } finally {
            running = false;
        }
    }
    async function signOut() {
        if (!supported()) return;
        const owner = identity();
        try {
            const session = await get('session');
            if (session.userId !== owner?.userId) return;
            const registration = await navigator.serviceWorker.getRegistration();
            if (!registration) return;
            const sub = await registration.pushManager.getSubscription();
            if (sub) {
                await sub.unsubscribe();
                await fetch('/api/push/unsubscribe', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Yap-Chat-User': owner.userId,
                    },
                    body: JSON.stringify({ endpoint: sub.endpoint }),
                });
            }
            for (const notification of await registration.getNotifications()) notification.close();
        } catch {}
    }
    navigator.serviceWorker?.addEventListener('message', (event) => {
        if (event.data?.type === 'NOTIFICATION_CLICK') {
            const route = safeRoute(event.data.url);
            if (route) navigate(route);
        }
    });
    window.addEventListener('appinstalled', async () => {
        try {
            const owner = identity(),
                session = await get('session');
            if (session.userId === owner?.userId) await post('pwa/installed', {}, session);
        } catch {}
    });
    document.addEventListener('chat-clear', () => {
        close();
        initialized = shown = null;
        try {
            localStorage.removeItem('yap-last-route');
        } catch {}
        if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
    });
    return {
        start,
        signOut,
        async resume() {
            if (location.pathname === '/' || location.pathname === '/pwa-launch') {
                const route = safeRoute(await storage.metadata('last-route')) || '/lobby';
                history.replaceState(null, '', route);
            }
        },
        remember() {
            const owner = identity(),
                route = safeRoute(location.href);
            if (owner && route) {
                storage.saveMetadata('last-route', route, owner).catch(() => {});
                try {
                    localStorage.setItem('yap-last-route', route);
                } catch {}
            }
        },
    };
}
