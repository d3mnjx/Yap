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
