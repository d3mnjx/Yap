import './worker-common.js';
import {
    ACCOUNT_LOCK,
    CHANGE_CHANNEL,
    DB_STORES,
    MEDIA_CACHE_PREFIX,
    SHELL_CACHE_PREFIX,
    EMOJI_CACHE,
    openDatabase,
} from './constants.js';
// Loaded by the single root worker. Never cache personalized HTML, API responses or auth redirects.
const MANIFEST_URL = '/chat-client/manifest.json';
const requestedVersion = new URL(self.location.href).searchParams.get('v');
let installedManifest;
async function manifest() {
    if (installedManifest) return installedManifest;
    // Workers can restart while offline; the installed manifest lives beside its assets.
    const names = requestedVersion
        ? [SHELL_CACHE_PREFIX + requestedVersion]
        : (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
    for (const name of names) {
        const cached = await (await caches.open(name)).match(MANIFEST_URL);
        if (cached) return (installedManifest = await cached.json());
    }
    throw new Error('Offline shell is not installed');
}
async function shellCache() {
    return caches.open(SHELL_CACHE_PREFIX + (await manifest()).version);
}
// Pinned, unmodified artwork outlives shell releases. Change this only with Twemoji.
const CHAT_EMOJI_CACHE = EMOJI_CACHE;
const CHAT_EMOJI_DEFAULTS = [
    '/chat-client/emoji/2764.svg',
    '/chat-client/emoji/1f602.svg',
    '/chat-client/emoji/1f44d.svg',
];
const isTwemoji = (path) => /^\/chat-client\/emoji\/[0-9a-f-]+\.svg$/.test(path);
const emojiCache = (path) => (isTwemoji(path) ? caches.open(CHAT_EMOJI_CACHE) : shellCache());
self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error('Shell manifest unavailable');
            const next = await response.json();
            if (requestedVersion && next.version !== requestedVersion)
                throw new Error('Deployment changed during shell installation');
            const cache = await caches.open(SHELL_CACHE_PREFIX + next.version);
            let bridge = (await caches.keys()).includes(MANIFEST_URL)
                ? await caches.open(MANIFEST_URL)
                : null;
            if ((await (await bridge?.match(MANIFEST_URL))?.json())?.version !== next.version)
                bridge = null;
            try {
                // Verify decoded bytes: mixed/stale compressed deployment files must not install.
                const queue = next.assets.filter((asset) => asset.install !== false);
                const downloads = await Promise.allSettled(
                    Array.from({ length: 6 }, async () => {
                        while (queue.length) {
                            const asset = queue.shift();
                            const result =
                                (await bridge?.match(asset.url)) ||
                                (await fetch(asset.url, {
                                    cache: 'reload',
                                    signal: AbortSignal.timeout(30000),
                                }));
                            if (!result.ok)
                                throw new Error('Shell asset unavailable: ' + asset.url);
                            const bytes = await result.clone().arrayBuffer();
                            const digest = [
                                ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                            ]
                                .map((b) => b.toString(16).padStart(2, '0'))
                                .join('');
                            if (digest !== asset.hash)
                                throw new Error('Shell asset changed: ' + asset.url);
                            await cache.put(asset.url, result);
                        }
                    }),
                );
                const failed = downloads.find((result) => result.status === 'rejected');
                if (failed) throw failed.reason;
                await cache.put(
                    MANIFEST_URL,
                    new Response(JSON.stringify(next), {
                        headers: { 'Content-Type': 'application/json' },
                    }),
                );
                installedManifest = next;
                const emoji = await caches.open(CHAT_EMOJI_CACHE);
                for (const path of CHAT_EMOJI_DEFAULTS)
                    if (!(await emoji.match(path)))
                        await emoji.add(
                            new Request(new URL(path, self.location.origin), { cache: 'reload' }),
                        );
            } catch (error) {
                // A failed candidate never replaces the incumbent's complete shell.
                if (!(await cache.match(MANIFEST_URL)))
                    await caches.delete(SHELL_CACHE_PREFIX + next.version);
                throw error;
            }
        })(),
    );
});
// Personal recents arrive after the authenticated catalog. Bound and serialize warming
// so it cannot flood the connection with thousands of optional image requests.
let emojiWarming = Promise.resolve();
self.addEventListener('message', (event) => {
    if (event.data?.type !== 'chat-warm-emoji' || !Array.isArray(event.data.paths)) return;
    const paths = [...new Set(event.data.paths)]
        .slice(0, 26)
        .filter(
            (path) =>
                typeof path === 'string' &&
                /^\/(chat-client\/emoji|emoji-packs|emoji-fallback|custom-emojis)\/[a-zA-Z0-9_./-]+\.(svg|png|gif|webp|jpg|jpeg)$/.test(
                    path,
                ) &&
                !path.includes('..'),
        );
    emojiWarming = emojiWarming
        .catch(() => {})
        .then(async () => {
            for (const path of paths) {
                const cache = await emojiCache(path);
                if (await cache.match(path)) continue;
                try {
                    const response = await fetch(path, {
                        signal: AbortSignal.timeout(5000),
                        priority: 'low',
                        cache: isTwemoji(path) ? 'reload' : 'default',
                    });
                    if (response.ok) await cache.put(path, response);
                } catch {
                    /* Optional artwork can be fetched on next use. */
                }
            }
        });
    event.waitUntil(emojiWarming);
});
self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            const shell = SHELL_CACHE_PREFIX + (await manifest()).version;
            await Promise.all(
                keys
                    .filter(
                        (key) =>
                            key === 'yap-v2' ||
                            key === 'yap-media-v1' ||
                            (key.startsWith(SHELL_CACHE_PREFIX) && key !== shell) ||
                            (key.startsWith('yap-chat-emoji-') && key !== CHAT_EMOJI_CACHE),
                    )
                    .map((key) => caches.delete(key)),
            );
            await caches.delete(MANIFEST_URL);
            await self.clients.claim();
        })(),
    );
});
// A controller has completed installation; the legacy push-only worker cannot send this ack.
self.addEventListener('message', (event) => {
    if (event.data?.type === 'CHAT_OFFLINE_CHECK')
        event.waitUntil(
            manifest().then((value) =>
                event.source?.postMessage({ type: 'CHAT_OFFLINE_READY', version: value.version }),
            ),
        );
});
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (/^\/auth\/(signin|signout|refresh-token|invite)$/.test(url.pathname)) {
        event.respondWith(
            clearChatData(url.pathname === '/auth/signout').then(() => fetch(event.request)),
        );
        return;
    }
    if (event.request.method !== 'GET' || event.request.headers.has('X-Yap-Chat-Media')) return;
    // API/hub/auth and retained pages must never depend on an offline shell cache.
    if (
        event.request.mode !== 'navigate' &&
        !/^\/(chat-client|fonts|themes|images|uploads|gif-cache|gif-uploads|media-cache|emoji-packs|emoji-fallback|custom-emojis)\//.test(
            url.pathname,
        ) &&
        !/^\/(app\.css|themes\.css|notif\.mp3|js\/appearance\.js|service-worker[^/]*\.js|icon[^/]*|emoji_selection[^/]*)$/.test(
            url.pathname,
        )
    )
        return;
    if (/^\/(api|hubs|_blazor|auth)(?:\/|$)/.test(url.pathname)) return;
    event.respondWith(
        (async () => {
            if (
                event.request.mode === 'navigate' &&
                (globalThis.yapWorkerCommon.isChatNavigation(url.pathname) ||
                    url.pathname === '/' ||
                    url.pathname === '/pwa-launch')
            ) {
                if (globalThis.yapWorkerCommon.isChatNavigation(url.pathname))
                    return (
                        (await (await shellCache()).match('/chat-client/index.html')) ||
                        fetch(event.request)
                    );
                // Authenticated root/PWA handoffs stay network-first and are never cached.
                try {
                    const response = await fetch(event.request, {
                        signal: AbortSignal.timeout(5000),
                    });
                    if (response.status >= 500) throw new Error('Navigation server unavailable');
                    return response;
                } catch {
                    return (
                        (await (await shellCache()).match('/chat-client/index.html')) ||
                        Response.error()
                    );
                }
            }
            if (/^\/(uploads|gif-cache|gif-uploads|media-cache)\//.test(url.pathname))
                return cachedMedia(event.request);
            const current = await manifest();
            // Only startup-inventoried anonymous files may enter the shell. API/auth/personalized
            // responses never become cacheable merely because their URL looks like an asset.
            const asset = current.assets.find((asset) => asset.url === url.pathname);
            if (asset) {
                const cache = await shellCache();
                const saved = await cache.match(url.pathname);
                if (saved) return saved;
                const response = await fetch(event.request);
                if (response.ok && asset.install === false) {
                    const hash = [
                        ...new Uint8Array(
                            await crypto.subtle.digest(
                                'SHA-256',
                                await response.clone().arrayBuffer(),
                            ),
                        ),
                    ]
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join('');
                    if (hash === asset.hash) await cache.put(url.pathname, response.clone());
                }
                return response;
            }
            if (
                /^\/(chat-client\/emoji|emoji-packs|emoji-fallback|custom-emojis)\//.test(
                    url.pathname,
                )
            ) {
                const cache = await emojiCache(url.pathname);
                const cached = await cache.match(event.request);
                if (cached) return cached;
                const response = await fetch(event.request, {
                    cache: isTwemoji(url.pathname) ? 'reload' : 'default',
                });
                if (response.ok) await cache.put(event.request, response.clone());
                return response;
            }
            return fetch(event.request);
        })().catch(() => fetch(event.request)),
    );
});
async function clearChatData(remove) {
    await self.navigator.locks.request(ACCOUNT_LOCK, async () => {
        const db = await openDatabase();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORES, 'readwrite');
            if (remove) {
                tx.objectStore('state').clear();
                tx.objectStore('drafts').clear();
                tx.objectStore('outbox').clear();
                tx.objectStore('reads').clear();
                tx.objectStore('conversations').clear();
            } else {
                const active = tx.objectStore('state').get('active');
                active.onsuccess = () => {
                    if (active.result)
                        tx.objectStore('state').put({ ...active.result, locked: true }, 'active');
                };
            }
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        if (remove)
            for (const key of await caches.keys())
                if (key.startsWith(MEDIA_CACHE_PREFIX)) await caches.delete(key);
        const channel = new BroadcastChannel(CHANGE_CHANNEL);
        channel.postMessage(remove ? 'forget' : 'locked');
        channel.close();
    });
}

async function cachedMedia(request) {
    const state = await openDatabase()
        .then(
            (db) =>
                new Promise((resolve) => {
                    const request = db.transaction('state').objectStore('state').get('active');
                    request.onsuccess = () => {
                        db.close();
                        resolve(request.result);
                    };
                    request.onerror = () => {
                        db.close();
                        resolve(null);
                    };
                }),
        )
        .catch(() => null);
    if (state?.userId && !state.locked) {
        const cached = await (
            await caches.open(MEDIA_CACHE_PREFIX + state.userId)
        ).match(request.url);
        if (cached) {
            const range = request.headers.get('Range');
            if (!range) return cached;
            // Media elements request ranges even for cached files; serve the requested bytes locally.
            const bytes = await cached.arrayBuffer(),
                m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = Number(m[1]),
                    end = Math.min(
                        m[2] ? Number(m[2]) : bytes.byteLength - 1,
                        bytes.byteLength - 1,
                    );
                if (start <= end)
                    return new Response(bytes.slice(start, end + 1), {
                        status: 206,
                        headers: {
                            'Content-Type': cached.headers.get('Content-Type'),
                            'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': String(end - start + 1),
                        },
                    });
            }
        }
    }
    return fetch(request);
}
