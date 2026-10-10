import { ACCOUNT_LOCK, MEDIA_CACHE_PREFIX } from './constants.js';
import { readIdentity } from './storage.js';
import { foregroundRequests } from './api.js';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const PREFETCH_BUDGET = 8 * 1024 * 1024;
const cacheName = (userId) => MEDIA_CACHE_PREFIX + userId;
const valid = (value) => {
    try {
        const url = new URL(value, location.origin);
        return (
            url.origin === location.origin &&
            /^\/(uploads|gif-cache|gif-uploads|media-cache|emoji-packs|emoji-fallback|custom-emojis)\//.test(
                url.pathname,
            )
        );
    } catch {
        return false;
    }
};
let owner,
    active,
    timer,
    spent = 0;
const pending = new Map(),
    attempted = new Set(),
    recent = [];
function pause() {
    clearTimeout(timer);
    active?.abort();
}
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(download, 250);
}
document.addEventListener('chat-foreground', (event) => {
    if (event.detail) pause();
    else schedule();
});
document.addEventListener('chat-clear', () => {
    pause();
    pending.clear();
    attempted.clear();
    recent.length = 0;
    owner = null;
    spent = 0;
});

// A displayed image can reuse its HTTP-cache response for offline storage, including
// older history reached explicitly by scrolling. This does not load unseen images.
document.addEventListener(
    'load',
    (event) => {
        if (owner && event.target instanceof HTMLImageElement)
            warmMedia([event.target.currentSrc || event.target.src], owner);
    },
    true,
);
export function warmImages(snapshot, identity, selected) {
    if (!snapshot || !identity || !selected) return Promise.resolve();
    if (recent[0] !== selected) {
        pause();
        const old = recent.indexOf(selected);
        if (old >= 0) recent.splice(old, 1);
        recent.unshift(selected);
        recent.length = Math.min(recent.length, 3);
        pending.clear();
    }
    for (const [priority, id] of recent.entries()) {
        const conversation = snapshot.conversations.find((c) => c.id === id);
        if (!conversation) continue;
        // Cache thumbnails and posters around actual visits. Full videos/gallery images
        // remain on demand; an unrelated DM arrival never starts downloading its media.
        const values = conversation.messages
            .slice(-30)
            .flatMap((message) => [
                message.author.picture,
                ...message.images.map((image) => image.medium),
                ...(message.videos || []).map((url) => url.replace(/\.[^.]+$/, '_poster.webp')),
                ...(message.gifs || []).map((gif) => gif.preview),
                ...(message.previews || []).flatMap((preview) => [
                    preview.cachedPosterUrl,
                    preview.imageUrl,
                ]),
            ]);
        warmMedia(values, identity, priority);
    }
    return Promise.resolve();
}
export function warmMedia(values, identity, priority = 0) {
    if (owner?.epoch !== identity.epoch) {
        pause();
        pending.clear();
        attempted.clear();
        spent = 0;
        owner = identity;
    }
    if (navigator.connection?.saveData) return Promise.resolve();
    for (const url of new Set(
        values
            .filter(Boolean)
            .filter(valid)
            .map((value) => new URL(value, location.origin).href),
    ))
        if (valid(url) && !attempted.has(url))
            pending.set(url, Math.min(priority, pending.get(url) ?? priority));
    schedule();
    return Promise.resolve();
}
async function limitedBlob(response, signal) {
    const maximum = Math.min(MAX_FILE, PREFETCH_BUDGET - spent);
    if (Number(response.headers.get('content-length')) > maximum) {
        await response.body?.cancel();
        return null;
    }
    const reader = response.body.getReader(),
        chunks = [];
    let size = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            spent += value.byteLength;
            if (size > maximum) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        return new Blob(chunks, { type: response.headers.get('content-type') || '' });
    } finally {
        reader.releaseLock();
    }
}
async function download() {
    if (active || foregroundRequests || !navigator.onLine || !owner || spent >= PREFETCH_BUDGET)
        return;
    const next = [...pending].sort((a, b) => a[1] - b[1])[0];
    if (!next) return;
    const [url] = next,
        account = owner,
        controller = new AbortController();
    pending.delete(url);
    active = controller;
    try {
        if ((await readIdentity())?.epoch !== account.epoch) return;
        const cache = await caches.open(cacheName(account.userId));
        if (await cache.match(url)) {
            attempted.add(url);
            return;
        }
        const response = await fetch(url, {
            // Visible media may already be in the HTTP cache. Do not force a second download.
            cache: 'force-cache',
            headers: { 'X-Yap-Chat-Media': '1' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        attempted.add(url);
        if (
            !response.ok ||
            !/^(image|video|audio)\//.test(response.headers.get('content-type') || '')
        ) {
            await response.body?.cancel();
            return;
        }
        const blob = await limitedBlob(response, controller.signal);
        if (!blob) return;
        await navigator.locks.request('yap-media-' + account.userId, async () => {
            // Potentially expensive cache enumeration runs outside the draft/outbox lock.
            const keys = await cache.keys();
            const sizes = await Promise.all(
                keys.map(async (key) => {
                    const response = await cache.match(key);
                    return (
                        Number(response?.headers.get('x-yap-size')) ||
                        (response ? (await response.blob()).size : 0)
                    );
                }),
            );
            await navigator.locks.request(ACCOUNT_LOCK, async () => {
                if ((await readIdentity())?.epoch !== account.epoch) return;
                let total = blob.size + sizes.reduce((a, b) => a + b, 0);
                for (let i = 0; total > MAX_BYTES && i < keys.length; i++) {
                    await cache.delete(keys[i]);
                    total -= sizes[i];
                }
                await cache.put(
                    url,
                    new Response(blob, {
                        headers: { 'content-type': blob.type, 'x-yap-size': String(blob.size) },
                    }),
                );
            });
        });
        document.dispatchEvent(new Event('chat-media-ready'));
    } catch {
        if (controller.signal.aborted && owner?.epoch === account.epoch) {
            attempted.delete(url);
            pending.set(url, next[1]);
        } else attempted.add(url);
    } finally {
        if (active === controller) active = null;
        schedule();
    }
}
export async function imageSource(url, userId) {
    if (!valid(url)) return null;
    const response = await (await caches.open(cacheName(userId))).match(url);
    return response ? URL.createObjectURL(await response.blob()) : null;
}
