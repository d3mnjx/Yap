import { mergeUpdate } from './sync.js';
import {
    ACCOUNT_LOCK,
    CHANGE_CHANNEL,
    DB_STORES,
    MEDIA_CACHE_PREFIX,
    openDatabase,
} from './constants.js';
const changes = new BroadcastChannel(CHANGE_CHANNEL);
export const notify = (type) => changes.postMessage(type);
export const onExternalChange = (handler) => {
    const listener = (event) => handler(event.data);
    changes.addEventListener('message', listener);
    return () => changes.removeEventListener('message', listener);
};
const request = (req) =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
let opened;
function open() {
    return (opened ??= openDatabase()
        .then((db) => {
            db.onversionchange = () => {
                db.close();
                opened = undefined;
                notify('upgrade');
            };
            return db;
        })
        .catch((error) => {
            opened = undefined;
            throw error;
        }));
}
async function transaction(stores, mode, action) {
    const db = await open();
    const tx = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
    });
    try {
        const result = await action(tx);
        await done;
        return result;
    } catch (error) {
        try {
            tx.abort();
        } catch {}
        await done.catch(() => {});
        throw error;
    }
}
const locked = (action) => navigator.locks.request(ACCOUNT_LOCK, action);
export const readIdentity = () =>
    transaction(['state'], 'readonly', (tx) => request(tx.objectStore('state').get('active')));
export async function readState() {
    return transaction(['state', 'conversations'], 'readonly', async (tx) => {
        const active = await request(tx.objectStore('state').get('active'));
        if (!active?.splitConversations) return active;
        return {
            ...active,
            snapshot: {
                ...active.snapshot,
                conversations: await request(tx.objectStore('conversations').getAll()),
            },
        };
    });
}
/** @param {import('./contracts.js').AccountIdentity} identity */
async function owner(tx, identity) {
    const active = await request(tx.objectStore('state').get('active'));
    if (
        !identity ||
        active?.epoch !== identity.epoch ||
        active.userId !== identity.userId ||
        active.locked
    )
        throw new Error('ACCOUNT_CHANGED');
    return active;
}
/** @returns {Promise<import('./contracts.js').AccountState>} */
export async function establish(userId) {
    return locked(async () => {
        const old = await readIdentity();
        if (old && old.userId !== userId) await eraseUnlocked();
        const active =
            old?.userId === userId
                ? { ...old, locked: false, authenticatedAt: Date.now() }
                : { userId, epoch: crypto.randomUUID(), authenticatedAt: Date.now() };
        await transaction(['state'], 'readwrite', (tx) =>
            tx.objectStore('state').put(active, 'active'),
        );
        if (old?.userId !== userId) notify('account');
        return active;
    });
}
export async function lockAccount() {
    await locked(() =>
        transaction(['state'], 'readwrite', async (tx) => {
            const store = tx.objectStore('state'),
                active = await request(store.get('active'));
            if (active) store.put({ ...active, locked: true }, 'active');
        }),
    );
    notify('locked');
}
/** Commit partial authority and its receipt atomically; persist only affected conversations. */
export async function commitUpdate(update, identity, acknowledgedOperation = null) {
    const result = await locked(() =>
        transaction(['state', 'conversations', 'outbox', 'reads'], 'readwrite', async (tx) => {
            const active = await owner(tx, identity);
            if (update.userId !== identity.userId) throw new Error('ACCOUNT_CHANGED');
            const retiredEpochs = active.retiredEpochs || [];
            if (retiredEpochs.includes(update.serverEpoch)) return null;
            const store = tx.objectStore('conversations');
            if (!active.splitConversations) store.clear();
            const previous = active.snapshot && {
                ...active.snapshot,
                conversations: active.splitConversations
                    ? await request(store.getAll())
                    : active.snapshot.conversations,
            };
            const snapshot = mergeUpdate(previous, update);
            if (previous && previous.serverEpoch !== snapshot.serverEpoch)
                retiredEpochs.push(previous.serverEpoch);
            const changed = new Set(update.conversations.map((c) => c.id));
            const before = new Map((previous?.conversations || []).map((c) => [c.id, c]));
            const ids = new Set(snapshot.conversations.map((c) => c.id));
            for (const id of before.keys()) if (!ids.has(id)) store.delete(id);
            for (const c of snapshot.conversations) {
                if (
                    !active.splitConversations ||
                    previous?.serverEpoch !== snapshot.serverEpoch ||
                    changed.has(c.id)
                )
                    store.put(c, c.id);
                const seen = await request(tx.objectStore('reads').get(c.id));
                if (seen && c.readThrough >= seen.through) tx.objectStore('reads').delete(c.id);
            }
            if (acknowledgedOperation) tx.objectStore('outbox').delete(acknowledgedOperation);
            for (const c of update.conversations)
                for (const message of c.messages)
                    if (message.authorId === identity.userId && message.operationId)
                        tx.objectStore('outbox').delete(message.operationId);
            tx.objectStore('state').put(
                {
                    ...active,
                    snapshot: { ...snapshot, conversations: [] },
                    splitConversations: true,
                    retiredEpochs,
                    authenticatedAt: Date.now(),
                },
                'active',
            );
            return snapshot;
        }),
    );
    // Sibling tabs need the original older-message patches too; their recent windows
    // may already have discarded those records. The account lease still gates every read.
    if (result) notify({ type: 'snapshot', update, ownerEpoch: identity.epoch });
    return result;
}

export const draft = (id) =>
    transaction(['drafts'], 'readonly', (tx) => request(tx.objectStore('drafts').get(id)));
export const saveDraft = (id, value, identity) =>
    locked(() =>
        transaction(['state', 'drafts'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            tx.objectStore('drafts').put(value, id);
        }),
    );
/** @returns {Promise<import('./contracts.js').OutgoingOperation[]>} */
export const outbox = () =>
    transaction(['outbox'], 'readonly', async (tx) =>
        (await request(tx.objectStore('outbox').getAll())).sort(
            (a, b) => a.createdAt - b.createdAt,
        ),
    );
export async function enqueue(channelId, content, identity, extra = {}, reply = undefined) {
    const item = {
        ...extra,
        operationId: crypto.randomUUID(),
        channelId,
        content,
        createdAt: Date.now(),
        status: 'queued',
        error: null,
    };
    await locked(() =>
        transaction(DB_STORES, 'readwrite', async (tx) => {
            const active = await owner(tx, identity);
            item.conversationName =
                (active.splitConversations
                    ? await request(tx.objectStore('conversations').get(channelId))
                    : active.snapshot?.conversations.find((c) => c.id === channelId)
                )?.name || 'Unavailable conversation';
            tx.objectStore('outbox').put(item, item.operationId);
            // Do not erase text typed while the send transaction was waiting for its lock.
            if (!extra.kind && (await request(tx.objectStore('drafts').get(channelId))) === content)
                tx.objectStore('drafts').delete(channelId);
            // Reply selection can change while enqueue waits for the lock. Clear only the
            // selection captured by this send, atomically with saving its outgoing message.
            if (!extra.kind && reply !== undefined) {
                const key = 'reply:' + channelId;
                const saved = await request(tx.objectStore('drafts').get(key));
                if (saved?.id === reply?.id && saved?.draftId === reply?.draftId)
                    tx.objectStore('drafts').delete(key);
            }
        }),
    );
    notify('outbox');
    return item;
}
export async function setDelivery(operationId, status, error, identity) {
    await locked(() =>
        transaction(['state', 'outbox'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            const store = tx.objectStore('outbox');
            const item = await request(store.get(operationId));
            // A stream can confirm acceptance before the POST finishes. Never recreate its pending row.
            if (item)
                store.put(
                    { ...item, status, error, attempted: item.attempted || status === 'sending' },
                    operationId,
                );
        }),
    );
    notify('outbox');
}
async function eraseUnlocked() {
    await transaction(DB_STORES, 'readwrite', (tx) => {
        for (const store of DB_STORES) tx.objectStore(store).clear();
    });
    for (const key of await caches.keys())
        if (key.startsWith(MEDIA_CACHE_PREFIX)) await caches.delete(key);
}
export const forget = () =>
    locked(async () => {
        await eraseUnlocked();
        notify('forget');
    });

export const reads = () =>
    transaction(['reads'], 'readonly', (tx) => request(tx.objectStore('reads').getAll()));
export async function markRead(channelId, through, identity, source = 'observed') {
    const changed = await locked(() =>
        transaction(['state', 'reads'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            const store = tx.objectStore('reads');
            const old = await request(store.get(channelId));
            if (old?.through >= through) return false;
            store.put({ channelId, through, source }, channelId);
            return true;
        }),
    );
    if (changed) notify('reads');
    return changed;
}
export const acknowledgeRead = (channelId, through, identity) =>
    locked(() =>
        transaction(['state', 'reads'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            const store = tx.objectStore('reads');
            const old = await request(store.get(channelId));
            if (old?.through <= through) store.delete(channelId);
        }),
    );
export const chooseStatus = (chosenStatus, identity) =>
    locked(() =>
        transaction(['state'], 'readwrite', async (tx) => {
            const active = await owner(tx, identity);
            tx.objectStore('state').put({ ...active, chosenStatus }, 'active');
        }),
    );

// The shared account state is already protected by the DB Web Lock. No new store/schema is needed.
export const claimNotificationAudio = (serverEpoch, candidates, identity) =>
    locked(() =>
        transaction(['state', 'conversations'], 'readwrite', async (tx) => {
            const active = await owner(tx, identity);
            if (active.snapshot?.serverEpoch !== serverEpoch) return false;
            const conversations = active.splitConversations
                ? await request(tx.objectStore('conversations').getAll())
                : active.snapshot.conversations;
            const through =
                active.notificationAudio?.serverEpoch === serverEpoch
                    ? { ...active.notificationAudio.through }
                    : {};
            let claimed = false;
            for (const candidate of candidates) {
                const conversation = conversations.find((c) => c.id === candidate.channelId);
                if (
                    !conversation ||
                    conversation.muted ||
                    !Number.isSafeInteger(candidate.through) ||
                    candidate.through > conversation.received ||
                    candidate.through <= (through[candidate.channelId] || 0)
                )
                    continue;
                through[candidate.channelId] = candidate.through;
                claimed = true;
            }
            if (claimed) {
                for (const id of Object.keys(through))
                    if (!conversations.some((c) => c.id === id)) delete through[id];
                tx.objectStore('state').put(
                    { ...active, notificationAudio: { serverEpoch, through } },
                    'active',
                );
            }
            return claimed;
        }),
    );

// Share the sender lock so an unsent edit/cancel cannot race the first network attempt.
export async function changePending(operationId, kind, content, identity) {
    return navigator.locks.request('yap-send-' + identity.userId, () =>
        locked(() =>
            transaction(['state', 'outbox'], 'readwrite', async (tx) => {
                const active = await owner(tx, identity),
                    store = tx.objectStore('outbox');
                const item = await request(store.get(operationId));
                if (item && !item.attempted) {
                    if (kind === 'delete') store.delete(operationId);
                    else store.put({ ...item, content }, operationId);
                    return true;
                }
                return false;
            }),
        ),
    );
}
export const replyDraft = (id) => draft('reply:' + id);
export const saveReply = (id, value, identity) => saveDraft('reply:' + id, value, identity);

export const metadata = (key) =>
    transaction(['state'], 'readonly', (tx) => request(tx.objectStore('state').get(key)));
export const saveMetadata = (key, value, identity) =>
    locked(() =>
        transaction(['state'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            tx.objectStore('state').put(value, key);
        }),
    );
// A slower sibling must not overwrite a page that already includes a newer mutation.
export const saveHistory = (pages, selected, identity) =>
    locked(() =>
        transaction(['state'], 'readwrite', async (tx) => {
            const active = await owner(tx, identity);
            const store = tx.objectStore('state');
            const previous = (await request(store.get('history'))) || {};
            for (const [id, page] of Object.entries(pages)) {
                const old = previous[id];
                if (active.retiredEpochs?.includes(page.serverEpoch)) {
                    if (old) pages[id] = old;
                    else delete pages[id];
                    continue;
                }
                if (
                    old?.serverEpoch === page.serverEpoch &&
                    Number(old.revision) > Number(page.revision)
                )
                    pages[id] = old;
            }
            let count = Object.values(pages).reduce(
                (n, p) => n + p.messages.length + (p.targets?.length || 0),
                0,
            );
            for (const id of Object.keys(pages)) {
                if (count <= 2000) break;
                if (id !== selected) {
                    count -= pages[id].messages.length + (pages[id].targets?.length || 0);
                    delete pages[id];
                }
            }
            store.put(pages, 'history');
        }),
    );

export const patchOutgoing = (id, patch, identity) =>
    locked(() =>
        transaction(['state', 'outbox'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            const store = tx.objectStore('outbox'),
                item = await request(store.get(id));
            if (item) store.put({ ...item, ...patch }, id);
        }),
    );

export const removeOutgoing = (id, identity) =>
    locked(() =>
        transaction(['state', 'outbox'], 'readwrite', async (tx) => {
            await owner(tx, identity);
            tx.objectStore('outbox').delete(id);
        }),
    );
