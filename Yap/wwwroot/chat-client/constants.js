export const PROTOCOL = 3;
// Persisted browser namespaces are compatibility contracts, independent of shell releases.
export const DB_NAME = 'yap-chat-v1';
export const DB_VERSION = 4;
export const DB_STORES = ['state', 'drafts', 'outbox', 'reads', 'conversations'];
export const ACCOUNT_LOCK = DB_NAME;
export const CHANGE_CHANNEL = DB_NAME;
export const SHELL_CACHE_PREFIX = 'yap-chat-shell-';
export const MEDIA_CACHE_PREFIX = 'yap-chat-media-';

// Pages and the worker must create precisely the same schema, whichever opens it first.
export function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            for (const name of DB_STORES)
                if (!request.result.objectStoreNames.contains(name))
                    request.result.createObjectStore(name);
        };
        request.onblocked = () =>
            reject(
                new Error('Close older Yap tabs, then reload to finish updating offline storage.'),
            );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
    });
}

export const EMOJI_CACHE = 'yap-chat-emoji-17.0.3';
