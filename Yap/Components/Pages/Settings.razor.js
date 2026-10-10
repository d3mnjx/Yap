import { MEDIA_CACHE_PREFIX, SHELL_CACHE_PREFIX, EMOJI_CACHE } from '/chat-client/constants.js';
// Debug helpers for the "Local Cache (PWA)" settings section.
// Reads the browser's Cache Storage directly — the same store the service worker
// (service-worker.js) writes to — so the listing is genuine client-side proof of local caching.

// Enumerate every Cache Storage bucket and its entries, with sizes.
export async function getCacheStorageReport() {
    if (!('caches' in window)) {
        return { supported: false, usage: null, quota: null, totalBytes: 0, totalCount: 0, caches: [] };
    }

    // Overall origin footprint (Cache Storage + IndexedDB + ...), when the browser exposes it.
    let usage = null, quota = null;
    if (navigator.storage?.estimate) {
        try {
            const e = await navigator.storage.estimate();
            usage = e.usage ?? null;
            quota = e.quota ?? null;
        } catch { /* not available */ }
    }

    // The Cache API exposes no per-entry size, so read it from the Response:
    // Content-Length header (cheap) first, falling back to the body's byte length.
    const sizeOf = async (res) => {
        if (!res) return 0;
        const len = res.headers.get('content-length');
        if (len) {
            const n = parseInt(len, 10);
            if (!isNaN(n)) return n;
        }
        try { return (await res.blob()).size; } catch { return 0; }
    };

    const groups = [];
    let totalBytes = 0, totalCount = 0;

    for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const entries = [];
        let groupBytes = 0;
        for (const req of await cache.keys()) {
            const res = await cache.match(req);
            const bytes = await sizeOf(res);
            let path;
            try { path = new URL(req.url).pathname; } catch { path = req.url; }
            const fname = decodeURIComponent(path.split('/').filter(Boolean).pop() || path);
            entries.push({ url: path, name: fname, bytes, type: res?.headers.get('content-type') || '' });
            groupBytes += bytes;
        }
        entries.sort((a, b) => b.bytes - a.bytes); // largest first
        const clearable = name.startsWith(MEDIA_CACHE_PREFIX);
        const label = clearable ? 'Media — saved chat attachments'
            : name.startsWith(SHELL_CACHE_PREFIX) ? 'Chat app — offline interface'
            : name === EMOJI_CACHE ? 'Emoji — downloaded artwork' : name;
        groups.push({ name, label, clearable, count: entries.length, totalBytes: groupBytes, entries });
        totalBytes += groupBytes;
        totalCount += entries.length;
    }
    groups.sort((a, b) => b.totalBytes - a.totalBytes);

    return { supported: true, usage, quota, totalBytes, totalCount, caches: groups };
}

// Delete a named cache, so you can clear it and watch the service worker re-populate on next load.
export async function clearCacheByName(name) {
    if (!('caches' in window)) return false;
    try { return await caches.delete(name); } catch { return false; }
}
