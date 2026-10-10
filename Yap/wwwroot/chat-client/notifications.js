import { claimNotificationAudio } from './storage.js';

// A tab's title counts arrivals since it was backgrounded, not the account's total unread.
// Counters come from authorized snapshots; presence, edits and window backfill cannot increment them.
export function createNotifications({ identity, snapshot, current }) {
    let ownerEpoch,
        serverEpoch,
        sequence = -1,
        audioSequence = -1;
    let received = new Map(),
        audioReceived = new Map(),
        counts = new Map(),
        audio;
    function clear() {
        ownerEpoch = serverEpoch = undefined;
        sequence = audioSequence = -1;
        received.clear();
        audioReceived.clear();
        counts.clear();
        try {
            audio?.pause();
        } catch {}
        audio = undefined;
        document.title = 'Yap | Chat';
    }
    function prepareAudio() {
        if (!audio) {
            audio = new Audio('/notif.mp3');
            audio.volume = 0.5;
            audio.load();
        }
        return audio;
    }
    for (const event of ['click', 'keydown'])
        document.addEventListener(
            event,
            () => {
                try {
                    if (identity()) prepareAudio();
                } catch {}
            },
            { once: true },
        );
    function render() {
        const state = snapshot(),
            conversation = current();
        if (!state) {
            document.title = 'Yap | Chat';
            return;
        }
        if (!document.hidden) counts.clear();
        for (const id of counts.keys())
            if (!state.conversations.some((c) => c.id === id && !c.muted)) counts.delete(id);
        const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
        const context =
            conversation?.kind === 'dm'
                ? '@' + decodeURIComponent(conversation.path.slice(4))
                : conversation
                  ? '#' + conversation.name
                  : 'Chat';
        document.title = `${total ? `(${total}) ` : ''}${state.projectName} | ${context}`;
    }
    document.addEventListener('visibilitychange', render);
    async function observe(data, { live = false, baseline = false } = {}) {
        const owner = identity(),
            latest = snapshot();
        if (!owner || data.user.id !== owner.userId || latest?.serverEpoch !== data.serverEpoch)
            return;
        const freshAccount = ownerEpoch !== owner.epoch;
        if (freshAccount) {
            clear();
            ownerEpoch = owner.epoch;
        }
        const newServer = serverEpoch !== data.serverEpoch;
        if (newServer) {
            serverEpoch = data.serverEpoch;
            sequence = audioSequence = -1;
        }
        const context = current();
        const accepts = (c) => context && (context.kind === 'room' || c.kind === 'dm');
        const policy = (c) => latest.conversations.find((current) => current.id === c.id);
        if (data.incremental || data.sequence > sequence) {
            for (const c of data.conversations) {
                if (!Number.isSafeInteger(c.received)) continue;
                const previous = received.get(c.id) ?? (freshAccount ? c.received : 0);
                const delta = Math.max(0, c.received - previous);
                received.set(c.id, c.received);
                if (
                    !freshAccount &&
                    document.hidden &&
                    accepts(c) &&
                    policy(c)?.muted === false &&
                    delta
                )
                    counts.set(c.id, (counts.get(c.id) || 0) + delta);
            }
            for (const id of received.keys())
                if (!data.conversations.some((c) => c.id === id)) received.delete(id);
            sequence = data.sequence;
        }
        const candidates = [];
        // HTTP acknowledgements/read updates can advance the title without swallowing a live
        // sound that is still in flight. Only stream packets or connection baselines advance this cursor.
        if (
            freshAccount ||
            newServer ||
            baseline ||
            (live && (data.incremental || data.sequence > audioSequence))
        ) {
            for (const c of data.conversations) {
                const previous = audioReceived.get(c.id) ?? 0;
                if (
                    !freshAccount &&
                    !newServer &&
                    !baseline &&
                    live &&
                    document.hidden &&
                    context?.kind === 'dm' &&
                    c.kind === 'dm' &&
                    policy(c)?.muted === false &&
                    c.received > previous
                )
                    candidates.push({ channelId: c.id, through: c.received });
                audioReceived.set(c.id, c.received);
            }
            for (const id of audioReceived.keys())
                if (!data.conversations.some((c) => c.id === id)) audioReceived.delete(id);
            audioSequence = data.sequence;
        }
        render();
        if (!candidates.length) return;
        try {
            const claimed = await claimNotificationAudio(data.serverEpoch, candidates, owner);
            if (
                !claimed ||
                identity()?.epoch !== owner.epoch ||
                !document.hidden ||
                current()?.kind !== 'dm'
            )
                return;
            const sound = prepareAudio();
            sound.currentTime = 0;
            // At-most-once attempt: do not queue a delayed surprise sound if autoplay is denied.
            Promise.resolve(sound.play()).catch(() => {});
        } catch {
            /* Browser audio/storage restrictions must not interrupt chat or replay later. */
        }
    }
    return { observe, render, clear };
}
