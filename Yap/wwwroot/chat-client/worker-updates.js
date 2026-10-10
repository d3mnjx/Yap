const watched = new WeakSet();

export function watchWorkerUpdates(registration) {
    if (!registration || watched.has(registration)) return;
    watched.add(registration);
    const watch = (worker) => {
        if (!worker) return;
        const activate = () => {
            // Chromium can leave an update waiting despite install-time skipWaiting.
            // Ask from the installed state, after the offline shell has been cached.
            if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
        };
        worker.addEventListener('statechange', activate);
        activate();
    };
    registration.addEventListener('updatefound', () => watch(registration.installing));
    watch(registration.installing || registration.waiting);
}

// The installed shell can start without a navigation request. Registration/update checks
// activate a replacement in the background while durable local work stays intact.
if ('serviceWorker' in navigator)
    navigator.serviceWorker
        .getRegistration()
        .then(watchWorkerUpdates)
        .catch(() => {});

// A content-only release changes the registration URL even when worker source is identical.
// Registration performs the browser's normal atomic install/activate lifecycle.
let checking;
export function registerWorker() {
    return (checking ??= (async () => {
        const existing = await navigator.serviceWorker.getRegistration('/');
        await existing?.update().catch(() => {});
        try {
            const response = await fetch('/chat-client/manifest.json', {
                cache: 'no-store',
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error('Shell manifest unavailable');
            const manifest = await response.json();
            const registration = await navigator.serviceWorker.register(
                '/service-worker-module.js?v=' + encodeURIComponent(manifest.version),
                {
                    type: 'module',
                    updateViaCache: 'none',
                    scope: '/',
                },
            );
            watchWorkerUpdates(registration);
            return registration;
        } catch (error) {
            if (!existing?.active?.scriptURL.includes('/service-worker-module.js')) throw error;
            watchWorkerUpdates(existing);
            return existing;
        }
    })().finally(() => {
        checking = undefined;
    }));
}
if ('serviceWorker' in navigator) {
    registerWorker().catch(() => {});
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) registerWorker().catch(() => {});
    });
}
