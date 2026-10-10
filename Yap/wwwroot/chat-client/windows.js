import { get, foregroundRequests } from './api.js';

// One cancellable background request fills missing recent windows. Live arrivals use
// the hub independently; opening a conversation promotes its window immediately.
export function createWindows({ identity, snapshot, current, accepted }) {
    let active, timer, selected;
    const retryAfter = new Map();
    function stop() {
        clearTimeout(timer);
        active?.controller.abort();
    }
    function schedule() {
        clearTimeout(timer);
        const next = current()?.id;
        if (selected !== next && active && active.id !== next) active.controller.abort();
        selected = next;
        timer = setTimeout(fill, 100);
    }
    async function fill() {
        if (active || foregroundRequests || !navigator.onLine || !identity()) return;
        const state = snapshot();
        const candidates = (state?.conversations || []).filter(
            (c) => c.sync && !c.sync.loaded && (retryAfter.get(c.id) || 0) <= Date.now(),
        );
        candidates.sort(
            (a, b) =>
                Number(b.id === current()?.id) - Number(a.id === current()?.id) ||
                b.unread - a.unread,
        );
        const conversation = candidates[0];
        if (!conversation) {
            if (state?.conversations.some((c) => c.sync && !c.sync.loaded))
                timer = setTimeout(fill, 10000);
            return;
        }
        const owner = identity();
        const job = { id: conversation.id, controller: new AbortController() };
        active = job;
        try {
            const update = await get('windows/' + job.id, { signal: job.controller.signal });
            if (identity()?.epoch === owner.epoch) await accepted(update);
        } catch {
            if (!job.controller.signal.aborted) retryAfter.set(job.id, Date.now() + 10000);
        } finally {
            if (active === job) active = null;
            clearTimeout(timer);
            // Yield to foreground work without adding a fixed gap per conversation.
            timer = setTimeout(fill, 0);
        }
    }
    document.addEventListener('chat-foreground', (event) => {
        if (event.detail) stop();
        else schedule();
    });
    document.addEventListener('chat-clear', stop);
    window.addEventListener('online', schedule);
    return { schedule, stop };
}
