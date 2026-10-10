importScripts('/chat-client/worker-common.js', '/chat-client/push.js');
// Compatibility bridge for an already-installed classic worker. New documents register
// service-worker-module.js directly. Stage a complete anonymous shell before replacing
// the incumbent, then let the next user navigation register the module worker.
const MANIFEST = '/chat-client/manifest.json';
let installed;
self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const response = await fetch(MANIFEST, { cache: 'no-store' });
            if (!response.ok) throw new Error('Shell manifest unavailable');
            const manifest = await response.json();
            // This temporary cache uses the endpoint URL; the module owns the stable namespace.
            const cache = await caches.open(MANIFEST);
            const queue = manifest.assets.filter((asset) => asset.install !== false);
            const results = await Promise.allSettled(
                Array.from({ length: 6 }, async () => {
                    while (queue.length) {
                        const asset = queue.shift();
                        const response = await fetch(asset.url, {
                            cache: 'reload',
                            signal: AbortSignal.timeout(30000),
                        });
                        if (!response.ok) throw new Error('Shell asset unavailable');
                        const bytes = await response.clone().arrayBuffer();
                        const hash = [
                            ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                        ]
                            .map((value) => value.toString(16).padStart(2, '0'))
                            .join('');
                        if (hash !== asset.hash)
                            throw new Error('Deployment changed during classic-worker migration');
                        await cache.put(asset.url, response);
                    }
                }),
            );
            const failed = results.find((result) => result.status === 'rejected');
            if (failed) throw failed.reason;
            await cache.put(
                MANIFEST,
                new Response(JSON.stringify(manifest), {
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
            installed = manifest;
            await self.skipWaiting();
        })(),
    );
});
// Claim without navigating open documents: an old Blazor composer/upload may still
// contain work that has not reached durable browser storage. The next user navigation
// enters the new shell; deployment guidance asks users to finish/copy old drafts first.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    if (
        event.request.method !== 'GET' ||
        new URL(event.request.url).origin !== self.location.origin
    )
        return;
    event.respondWith(
        (async () => {
            if (!installed) {
                const response = await (await caches.open(MANIFEST)).match(MANIFEST);
                if (response) installed = await response.json();
            }
            if (installed) {
                const cache = await caches.open(MANIFEST);
                const url = new URL(event.request.url);
                if (
                    event.request.mode === 'navigate' &&
                    globalThis.yapWorkerCommon.isChatNavigation(url.pathname)
                ) {
                    try {
                        return await fetch(event.request);
                    } catch {
                        return (await cache.match('/chat-client/index.html')) || Response.error();
                    }
                }
                if (installed.assets.some((asset) => asset.url === url.pathname)) {
                    try {
                        return await fetch(event.request);
                    } catch {
                        return (await cache.match(url.pathname)) || Response.error();
                    }
                }
            }
            return fetch(event.request);
        })(),
    );
});
