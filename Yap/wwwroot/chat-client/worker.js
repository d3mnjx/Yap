// Loaded by the single root worker. Never cache personalized HTML, API responses or auth redirects.
const CHAT_SHELL = 'yap-chat-shell-v40';
// Pinned, unmodified artwork outlives shell releases. Change this only with Twemoji.
const CHAT_EMOJI_CACHE = 'yap-chat-emoji-17.0.3';
const CHAT_EMOJI_DEFAULTS = [
    '/chat-client/emoji/2764.svg',
    '/chat-client/emoji/1f602.svg',
    '/chat-client/emoji/1f44d.svg',
];
const isTwemoji = (path) => /^\/chat-client\/emoji\/[0-9a-f-]+\.svg$/.test(path);
const emojiCacheName = (path) => (isTwemoji(path) ? CHAT_EMOJI_CACHE : CHAT_SHELL);
function isChatNavigation(path) {
    return /^\/(?:chat|lobby)\/?$/.test(path) || /^\/(?:room|dm)\/[^/]+\/?$/.test(path);
}
const CHAT_ASSETS = [
    '/js/appearance.js',
    '/chat-client/messages.js',
    '/chat-client/worker-updates.js',
    '/chat-client/scroll.js',
    '/chat-client/warnings.js',
    '/chat-client/rich-media.js',
    '/chat-client/composer.js',
    '/emoji_selection_greys.png',
    '/emoji_selection_color.png',
    '/chat-client/emoji/catalog.js',
    '/chat-client/index.html',
    '/chat-client/api.js',
    '/chat-client/sender.js',
    '/chat-client/live.js',
    '/chat-client/reader.js',
    '/chat-client/notifications.js',
    '/notif.mp3',
    '/chat-client/pwa.js',
    '/chat-client/pickers.js',
    '/chat-client/history.js',
    '/chat-client/profiles.js',
    '/chat-client/dates.js',
    '/chat-client/content.js',
    '/chat-client/gifs.js',
    '/chat-client/uploads.js',
    '/chat-client/actions.js',
    '/chat-client/app.js',
    '/chat-client/storage.js',
    '/chat-client/sync.js',
    '/chat-client/windows.js',
    '/chat-client/media.js',
    '/chat-client/gallery.js',
    '/chat-client/chat.css',
    '/chat-client/component-styles.css',
    '/chat-client/vendor/signalr-10.0.0.min.js',
    '/chat-client/manifest.webmanifest',
    '/app.css',
    '/themes.css',
    '/themes/teahouse.css',
    '/fonts/InterVariable.woff2',
    '/fonts/InterVariable-Italic.woff2',
    '/images/turqline01_3px.png',
    '/images/purpleline01_3px.png',
    ...[
        '/chat-client/vendor/add-to-homescreen-3.5/add-to-homescreen.min.css',
        '/chat-client/vendor/add-to-homescreen-3.5/add-to-homescreen.min.js',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/aardvark-homepage.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/aardvark-logo.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/aardvark.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-add-to-home-screen-button-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-add-to-home-screen-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-install-app.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-more-button-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-chrome-more-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-edge-add-to-home-screen-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/android-edge-more-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/arrow-down.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/breadcrumb-1.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/breadcrumb-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/breadcrumb-3.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/desktop-safari-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/desktop-safari-dock.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/desktop-safari-menu.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/down-arrow-blue.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/down-arrow.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/down-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/generic-more-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/generic-vertical-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/generic-vertical-down-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/generic-vertical-up-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-add-to-home-screen-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-chrome-add-to-home-screen-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-chrome-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-chrome-more-button-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-chrome-more-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-add-to-home-screen-button-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-add-to-home-screen-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-ios26-bouncing-arrow.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-ios26-more-grey-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-ios26-more-white-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-ios26-share-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-sharing-api-button-2.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-sharing-api-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-safari-sharing-api.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/ios-sharing-api.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/openinsafari-button.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/openinsafari-button.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/your-app-icon.svg',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/sample/aardvark-homepage.png',
        '/chat-client/vendor/add-to-homescreen-3.5/assets/img/sample/aardvark-logo.png',
    ],
];
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CHAT_SHELL).then(async (cache) => {
            // Install only the executable shell. Artwork and install-guide assets cache on
            // use, so initial setup does not compete with chat for large optional downloads.
            await cache.addAll(CHAT_ASSETS.filter((path) => !path.includes('/add-to-homescreen-')));
            // Fonts are part of the shell; scene images cache when the browser requests them.
            const dependencies = new Set();
            for (const path of ['/app.css', '/themes.css', '/themes/teahouse.css']) {
                const css = await (await cache.match(path)).text();
                for (const match of css.matchAll(/url\(['"]?(\/[^)'" ]+)/g))
                    if (match[1].startsWith('/fonts/')) dependencies.add(match[1]);
            }
            await cache.addAll([...dependencies]);
            const emoji = await caches.open(CHAT_EMOJI_CACHE);
            for (const path of CHAT_EMOJI_DEFAULTS) {
                if (!(await emoji.match(path)))
                    await emoji.add(
                        new Request(new URL(path, self.location.origin), { cache: 'reload' }),
                    );
            }
        }),
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
                const cache = await caches.open(emojiCacheName(path));
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
            // v35 shipped this exact pin in the shell cache. Preserve already downloaded SVGs
            // during the move, but never import those bytes into a future artwork version.
            if (
                CHAT_EMOJI_CACHE === 'yap-chat-emoji-17.0.3' &&
                keys.includes('yap-chat-shell-v35')
            ) {
                const old = await caches.open('yap-chat-shell-v35');
                const emoji = await caches.open(CHAT_EMOJI_CACHE);
                for (const request of await old.keys()) {
                    const url = new URL(request.url);
                    if (url.origin !== self.location.origin || !isTwemoji(url.pathname)) continue;
                    if (!(await emoji.match(request))) {
                        const response = await old.match(request);
                        if (response?.ok) await emoji.put(request, response);
                    }
                }
            }
            await Promise.all(
                keys
                    .filter(
                        (key) =>
                            (key.startsWith('yap-chat-shell-') && key !== CHAT_SHELL) ||
                            (key.startsWith('yap-chat-emoji-') && key !== CHAT_EMOJI_CACHE),
                    )
                    .map((key) => caches.delete(key)),
            );
        })(),
    );
});
// A controller has completed installation; the legacy push-only worker cannot send this ack.
self.addEventListener('message', (event) => {
    if (event.data?.type === 'CHAT_OFFLINE_CHECK')
        event.source?.postMessage({ type: 'CHAT_OFFLINE_READY' });
});
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (
        event.request.mode === 'navigate' &&
        (isChatNavigation(url.pathname) || url.pathname === '/' || url.pathname === '/pwa-launch')
    ) {
        // Canonical chat uses its installed shell immediately. Root/PWA handoffs reach
        // the deployed app; auth transitions and tokenized launch responses stay network-only.
        // Never store the response: handoff and legacy HTML can contain account-specific data.
        // Bound a stalled connection too; cached chat must still open on a half-working network.
        // Offline launches use only our static shell, whose boot checks account ownership and known revocation.
        if (isChatNavigation(url.pathname)) {
            event.respondWith(
                caches
                    .open(CHAT_SHELL)
                    .then(
                        async (cache) =>
                            (await cache.match('/chat-client/index.html')) || fetch(event.request),
                    ),
            );
            return;
        }
        event.respondWith(
            fetch(event.request, { signal: AbortSignal.timeout(5000) })
                .then((response) => {
                    if (response.status >= 500) throw new Error('Navigation server unavailable');
                    return response;
                })
                .catch(async () => {
                    const cached = await (
                        await caches.open(CHAT_SHELL)
                    ).match('/chat-client/index.html');
                    return cached || Response.error();
                }),
        );
        return;
    }
    // Auth transitions from retained Server pages must invalidate prototype data too.
    if (/^\/auth\/(signin|signout|refresh-token|invite)$/.test(url.pathname)) {
        event.respondWith(
            clearChatData(url.pathname === '/auth/signout').then(() => fetch(event.request)),
        );
        return;
    }
    if (event.request.method !== 'GET') return;
    if (
        /^\/(uploads|gif-cache|gif-uploads|media-cache)\//.test(url.pathname) &&
        !event.request.headers.has('X-Yap-Chat-Media')
    ) {
        event.respondWith(cachedMedia(event.request));
        return;
    }
    if (
        !CHAT_ASSETS.includes(url.pathname) &&
        /^\/(chat-client\/emoji|emoji-packs|emoji-fallback|custom-emojis)\//.test(url.pathname)
    ) {
        event.respondWith(
            caches.open(emojiCacheName(url.pathname)).then(async (cache) => {
                const cached = await cache.match(event.request);
                if (cached) return cached;
                // A new artwork pin must bypass an older HTTP-cache entry at the same URL.
                const response = await fetch(event.request, {
                    cache: isTwemoji(url.pathname) ? 'reload' : 'default',
                });
                if (response.ok) await cache.put(event.request, response.clone());
                return response;
            }),
        );
        return;
    }
    if (CHAT_ASSETS.includes(url.pathname) || url.pathname.startsWith('/images/themes/')) {
        const key = url.pathname;
        event.respondWith(
            caches.open(CHAT_SHELL).then(async (cache) => {
                const cached = await cache.match(key);
                if (cached) return cached;
                const response = await fetch(event.request);
                if (response.ok) await cache.put(key, response.clone());
                return response;
            }),
        );
    }
});
async function clearChatData(remove) {
    await self.navigator.locks.request('yap-chat-v1', async () => {
        const db = await new Promise((resolve, reject) => {
            const r = indexedDB.open('yap-chat-v1', 4);
            r.onupgradeneeded = () => {
                for (const name of ['state', 'drafts', 'outbox', 'reads', 'conversations'])
                    if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction(
                ['state', 'drafts', 'outbox', 'reads', 'conversations'],
                'readwrite',
            );
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
                if (key.startsWith('yap-chat-media-')) await caches.delete(key);
        const channel = new BroadcastChannel('yap-chat-v1');
        channel.postMessage(remove ? 'forget' : 'locked');
        channel.close();
    });
}

async function cachedMedia(request) {
    const state = await new Promise((resolve) => {
        const r = indexedDB.open('yap-chat-v1', 4);
        r.onupgradeneeded = () => {
            for (const name of ['state', 'drafts', 'outbox', 'reads', 'conversations'])
                if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
        };
        r.onerror = () => resolve(null);
        r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('state')) {
                db.close();
                resolve(null);
                return;
            }
            const q = db.transaction('state').objectStore('state').get('active');
            q.onsuccess = () => {
                db.close();
                resolve(q.result);
            };
            q.onerror = () => {
                db.close();
                resolve(null);
            };
        };
    });
    if (state?.userId && !state.locked) {
        const cached = await (
            await caches.open('yap-chat-media-' + state.userId)
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
