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
                        markers.map((m) => ({ channelId: m.channelId, through: m.through })),
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
    return {
        flush,
        async observe(conversation, explicit = false) {
            const owner = identity();
            if (
                !owner ||
                document.hidden ||
                !conversation ||
                conversation.sync?.loaded === false ||
                (!explicit && !eligible()) ||
                !conversation.received ||
                !conversation.unread
            )
                return;
            if (await storage.markRead(conversation.id, conversation.received, owner)) {
                await changed();
                schedule();
            }
        },
    };
}
