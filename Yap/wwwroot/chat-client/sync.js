import { PROTOCOL } from './constants.js';
// Wire updates are partial authority. Ordering belongs to each record/conversation,
// not one global snapshot cursor: a newer room update cannot swallow an older DM update.
export function mergeUpdate(previous, update) {
    const newServer = previous?.serverEpoch !== update.serverEpoch;
    let state = previous || update.state;
    if (!state) throw new Error('SYNC_REQUIRED');
    state = { ...state };
    const sequence = update.sequence;
    const conversations = new Map(
        (previous?.conversations || []).map((c) => [
            c.id,
            newServer
                ? {
                      ...c,
                      // Process counters restart, cached content does not. Keep it readable
                      // until a complete window validates it; it cannot acknowledge reads.
                      sync: {
                          loaded: false,
                          stale: true,
                          metadata: 0,
                          records: {},
                          removed: {},
                          window: 0,
                      },
                  }
                : c,
        ]),
    );
    const tombstones = newServer ? {} : { ...state.removedConversations };
    if (update.reset) {
        const allowed = new Set(update.conversations.map((c) => c.id));
        for (const [id, c] of conversations)
            if (!allowed.has(id) && (c.sync?.metadata || 0) <= sequence) {
                conversations.delete(id);
                tombstones[id] = sequence;
            }
    }
    if (update.state && (newServer || sequence > (state.syncStateSequence || 0))) {
        state = {
            ...state,
            ...update.state,
            syncStateSequence: sequence,
            stateRevision: update.stateRevision,
        };
    }
    const authors = new Map((update.authors || []).map((person) => [person.id, person]));
    for (const patch of update.conversations) {
        if ((tombstones[patch.id] || 0) >= sequence) continue;
        const old = conversations.get(patch.id);
        const sync = {
            loaded: false,
            metadata: 0,
            window: 0,
            records: {},
            removed: {},
            ...old?.sync,
        };
        // This is a local render version, not a server watermark. A delayed packet can
        // still add a previously unseen record after newer metadata for this conversation.
        sync.version = (sync.version || 0) + 1;
        sync.records = { ...sync.records };
        sync.removed = { ...sync.removed };
        const metadata = sequence > sync.metadata ? patch.state : old;
        let c = { ...old, ...metadata, messages: old?.messages || [], sync };
        if (sequence > sync.metadata) sync.metadata = sequence;
        let messages = new Map(c.messages.map((message) => [message.id, message]));
        const complete =
            sequence >= sync.window &&
            (patch.window ||
                (patch.baseRevision && sync.loaded && sync.revision === patch.baseRevision));
        if (patch.invalidate && sync.revision !== patch.revision && sequence >= sync.window) {
            // Restart recovery preserves unrestricted cached windows. Access removals
            // still delete the conversation, and restricted histories clear immediately.
            const retain = sync.stale && !c.historyLimited;
            if (!retain)
                for (const [id] of messages)
                    if ((sync.records[id] || 0) <= sequence) messages.delete(id);
            sync.loaded = false;
            sync.revision = undefined;
            sync.window = sequence;
        }
        if (patch.window && sequence >= sync.window) {
            const keep = new Set(patch.window);
            for (const [id] of messages)
                if (!keep.has(id) && (sync.records[id] || 0) <= sequence) {
                    messages.delete(id);
                    sync.removed[id] = sequence;
                }
            sync.window = sequence;
            sync.loaded = true;
            sync.stale = false;
            sync.revision = patch.revision;
            c.hasMore = patch.state.hasMore;
        } else if (patch.baseRevision) {
            if (sync.revision === patch.baseRevision) sync.revision = patch.revision;
            else if (sync.revision !== patch.revision && sequence > sync.window)
                sync.loaded = false;
        }
        for (const id of patch.removed) {
            if (sequence < (sync.records[id] || 0) || sequence < sync.window) continue;
            messages.delete(id);
            sync.removed[id] = Math.max(sequence, sync.removed[id] || 0);
        }
        for (const message of patch.messages) {
            if (
                sequence < sync.window ||
                sequence <= Math.max(sync.records[message.id] || 0, sync.removed[message.id] || 0)
            )
                continue;
            const author = authors.get(message.authorId);
            if (!author) throw new Error('Missing message author');
            messages.set(message.id, { ...message, author });
            sync.records[message.id] = sequence;
        }
        c.messages = [...messages.values()].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        );
        const limit = state.recentMessageLimit || 100;
        if (c.messages.length > limit) {
            c.messages = c.messages.slice(-limit);
            c.hasMore = true;
        }
        // Retain ordering guards only for the bounded window/recent deletions. A complete
        // window's watermark rejects older records even after individual guards expire.
        if (complete) {
            sync.window = sequence;
            const ids = new Set(c.messages.map((m) => m.id));
            sync.records = Object.fromEntries(
                Object.entries(sync.records).filter(
                    ([id, stamp]) => ids.has(id) || stamp > sequence,
                ),
            );
            sync.removed = Object.fromEntries(
                Object.entries(sync.removed).filter(([, stamp]) => stamp > sequence),
            );
        }
        conversations.set(c.id, c);
    }
    for (const id of update.removedConversations) {
        const c = conversations.get(id);
        if (!c || sequence >= (c.sync?.metadata || 0)) {
            conversations.delete(id);
            tombstones[id] = Math.max(sequence, tombstones[id] || 0);
        }
    }
    return {
        ...state,
        protocol: PROTOCOL,
        incremental: true,
        serverEpoch: update.serverEpoch,
        sequence: newServer ? sequence : Math.max(sequence, previous?.sequence || 0),
        conversations: [...conversations.values()],
        removedConversations: tombstones,
    };
}
