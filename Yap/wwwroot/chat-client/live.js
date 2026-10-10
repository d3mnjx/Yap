import * as storage from './storage.js';
const statuses = ['online', 'away', 'invisible'];
export function createLive({ snapshot = () => null, identity, current, changed, authRequired }) {
    let connection = null,
        view = null,
        lastActivity = Date.now(),
        lastReport = 0;
    let typedAt = 0,
        typingChannel = null,
        lastTypingSent = 0,
        chosen = 'online',
        typingExpires = 0;
    const invoke = async (method, ...args) => {
        const target = connection;
        if (!target) return;
        try {
            // Transient reports need ordered delivery, not an acknowledgement round trip.
            return await target.send(method, ...args);
        } catch (error) {
            if (target === connection && error.message.includes('AUTH_REQUIRED')) authRequired();
        }
    };
    const stopTyping = () => {
        if (typingChannel) invoke('Typing', typingChannel, false);
        typedAt = 0;
        typingChannel = null;
        lastTypingSent = 0;
    };
    const report = () => {
        lastReport = Date.now();
        return invoke(
            'Report',
            !document.hidden,
            (Date.now() - lastActivity) / 1000,
            current()?.id ?? null,
        );
    };
    const activity = () => {
        const wasIdle = Date.now() - lastActivity >= (snapshot()?.awayAfterMs ?? 30000);
        lastActivity = Date.now();
        if (wasIdle && connection) report();
    };
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'])
        document.addEventListener(event, activity, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopTyping();
        else lastActivity = Date.now();
        report();
    });
    setInterval(() => {
        if (!connection) return;
        if (view?.typingText && Date.now() > typingExpires) {
            view = { ...view, typingText: '' };
            changed();
        }
        if (Date.now() - lastReport >= (document.hidden ? 60000 : 10000)) report();
        if (typingChannel && Date.now() - typedAt >= (snapshot()?.typingTimeoutMs ?? 3000))
            stopTyping();
        else if (
            typingChannel &&
            Date.now() - lastTypingSent >= (snapshot()?.typingTimeoutMs ?? 3000) / 2
        ) {
            lastTypingSent = Date.now();
            invoke('Typing', typingChannel, true);
        }
    }, 500);
    return {
        get view() {
            return view;
        },
        get connected() {
            return !!connection;
        },
        get chosen() {
            return chosen;
        },
        async attach(target, ticket) {
            const owner = identity();
            chosen = (await storage.readState())?.chosenStatus || 'online';
            if (owner?.epoch !== identity()?.epoch) return;
            connection = target;
            target
                .stream(
                    'WatchActivity',
                    ticket,
                    Math.max(0, statuses.indexOf(chosen)),
                    !document.hidden,
                    matchMedia('(pointer: coarse)').matches,
                    (Date.now() - lastActivity) / 1000,
                    current()?.id ?? null,
                )
                .subscribe({
                    next: (data) => {
                        if (connection !== target) return;
                        const people = new Map(
                            (view?.users || []).map((person) => [person.username, person]),
                        );
                        for (const name of data.removedUsers || []) people.delete(name);
                        for (const person of data.users || []) people.set(person.username, person);
                        view = { ...view, ...data, users: [...people.values()] };
                        typingExpires = Date.now() + (snapshot()?.typingTimeoutMs ?? 3000) + 500;
                        if (data.chosenStatus && chosen !== data.chosenStatus) {
                            chosen = data.chosenStatus;
                            storage.chooseStatus(chosen, owner).catch(() => {});
                        }
                        changed();
                    },
                    error: (error) => {
                        if (connection === target) {
                            connection = null;
                            view = null;
                            changed();
                            if (error.message.includes('AUTH_REQUIRED')) authRequired();
                        }
                    },
                });
        },
        detach() {
            connection = null;
            view = null;
            typedAt = 0;
            typingChannel = null;
            changed();
        },
        navigate() {
            stopTyping();
            return report();
        },
        input(value) {
            const c = current();
            if (!connection || document.hidden || !c?.canWrite || !value.trim()) {
                stopTyping();
                return;
            }
            typedAt = Date.now();
            if (typingChannel !== c.id) {
                stopTyping();
                typedAt = Date.now();
                typingChannel = c.id;
                lastTypingSent = Date.now();
                invoke('Typing', c.id, true);
            }
        },
        stopTyping,
        async setStatus(status) {
            if (!connection || !statuses.includes(status)) return;
            const target = connection;
            await target.invoke('SetStatus', statuses.indexOf(status));
            if (connection !== target) return;
            chosen = status;
            await storage.chooseStatus(status, identity());
        },
    };
}
