// Automatic reads require a visible tab, connected hub, non-Away status, a loaded
// and validated current window, and unread arrivals. Explicit open also works offline
// or while Away, but never on hidden/stale/unloaded content. Persist only the received
// checkpoint actually displayed; replay cannot acknowledge later unseen arrivals.
import * as storage from './storage.js';
import { get, post } from './api.js';
export function createReader({
    snapshot = () => null,
    identity,
    accepted,
    changed,
    eligible,
    authRequired,
    failed,
}) {
    let running = false;
    async function flush() {
        const owner = identity();
        if (!owner || running || !navigator.onLine) return;
        running = true;
        try {
            await navigator.locks.request(
                'yap-reads-' + owner.userId,
                { ifAvailable: true },
                async (lock) => {
                    if (!lock) return;
                    const markers = (await storage.reads()).slice(0, snapshot()?.readBatch ?? 100);
                    if (!markers.length || identity()?.epoch !== owner.epoch) return;
                    const session = await get('session');
                    if (session.userId !== owner.userId) {
                        await authRequired();
                        return;
                    }
                    const result = await post(
                        'reads',
                        markers.map((m) => ({
                            channelId: m.channelId,
                            through: m.through,
                            source: m.source ?? 'observed',
                        })),
                        session,
                    );
                    if (identity()?.epoch !== owner.epoch) return;
                    for (const update of result.updates) await accepted(update);
                    for (const marker of markers)
                        await storage.acknowledgeRead(marker.channelId, marker.through, owner);
                    await changed();
                },
            );
        } catch (error) {
            if (
                ['AUTH_REQUIRED', 'ACCOUNT_CHANGED'].includes(error.message) ||
                error.status === 401
            )
                await authRequired();
            else if (error.message !== 'ACCOUNT_CHANGED') failed(error);
        } finally {
            running = false;
        }
    }
    let timer;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(flush, 300);
    };
    setInterval(flush, 3000);
    let resumed = false;
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) resumed = true;
    });
    return {
        flush,
        async observe(conversation, source = 'arrival') {
            const explicit = source === 'open' || source === 'explicit';
            if (!explicit && resumed) source = 'resume';
            const owner = identity();
            if (
                !owner ||
                document.hidden ||
                !conversation ||
                conversation.sync?.loaded === false ||
                conversation.sync?.stale ||
                (!explicit && !eligible()) ||
                !conversation.received ||
                !conversation.unread
            )
                return;
            if (await storage.markRead(conversation.id, conversation.received, owner, source)) {
                resumed = false;
                await changed();
                schedule();
            }
        },
    };
}
