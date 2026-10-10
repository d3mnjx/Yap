import { get, beginForeground } from './api.js';
import * as storage from './storage.js';

export function createHistory({ identity, current, changed, notice }) {
    let pages = {},
        latest,
        activeLoad = null,
        serial = 0,
        refreshAfterLoad = false;
    const merge = (a, b) =>
        [...new Map([...a, ...b].map((m) => [m.id, m])).values()].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        );
    const version = (c) =>
        `${latest?.serverEpoch}:${c.historyLimited ? c.contentVersion : (c.historyVersion ?? c.contentVersion)}`;
    const valid = (c) => pages[c.id]?.version === version(c);
    const authorized = (id) => latest?.conversations.find((c) => c.id === id);

    async function persist(channel, owner = identity()) {
        if (!owner || identity()?.epoch !== owner.epoch) return;
        // Extra history is a bounded cache, not a second unbounded message archive.
        const cached = Object.fromEntries(
            Object.entries(pages).map(([id, p]) => [
                id,
                {
                    ...p,
                    messages: p.messages.slice(-500),
                    hasMore: p.hasMore || p.messages.length > 500,
                },
            ]),
        );
        let count = Object.values(cached).reduce(
            (n, p) => n + p.messages.length + (p.targets?.length || 0),
            0,
        );
        for (const id of Object.keys(cached)) {
            if (count <= 2000) break;
            if (id !== channel) {
                count -= cached[id].messages.length + (cached[id].targets?.length || 0);
                delete cached[id];
                delete pages[id];
            }
        }
        await storage.saveMetadata('history', cached, owner);
    }

    async function save(channel, page, owner) {
        if (identity()?.epoch !== owner?.epoch) return;
        delete pages[channel];
        pages[channel] = page;
        await persist(channel, owner);
    }

    function view(c) {
        if (!c || !valid(c)) return c;
        const old = pages[c.id];
        return {
            ...c,
            messages: merge([...old.messages, ...(old.targets || [])], c.messages),
            hasMore: old.hasMore,
        };
    }

    function refresh() {
        const c = current();
        if (!c || !pages[c.id] || valid(c) || !navigator.onLine) return;
        if (activeLoad) {
            // A snapshot/navigation can invalidate another page while a request is in
            // flight. Remember that work instead of silently dropping the refresh.
            if (activeLoad.channel !== c.id || activeLoad.version !== version(c))
                refreshAfterLoad = true;
            return;
        }
        return load(c, true);
    }

    async function load(c, refreshPage = false) {
        if (!c || activeLoad || !navigator.onLine) return;
        const owner = identity();
        if (!owner) return;
        const task = { channel: c.id, version: version(c), serial, evicted: [] };
        const endForeground = beginForeground();
        activeLoad = task;
        refreshPage ||= !!pages[c.id] && !valid(c);
        const scroller = document.querySelector('.messages');
        const indicator = document.querySelector('#history-loading');
        if (!refreshPage) indicator.hidden = false;
        const stillCurrent = () =>
            serial === task.serial &&
            identity()?.epoch === owner.epoch &&
            authorized(c.id) &&
            version(authorized(c.id)) === task.version;
        try {
            const existing = pages[c.id],
                all = merge(existing?.messages || [], c.messages);
            const before = (refreshPage ? c.messages : all)[0]?.timestamp;
            const limit = refreshPage ? Math.max(existing?.messages.length || 0, 50) : 50;
            const fetchPage = (count, before) =>
                get(
                    `conversations/${c.id}/history?` +
                        new URLSearchParams({
                            limit: String(Math.min(count, 500)),
                            ...(before ? { before } : {}),
                        }),
                );
            let result = await fetchPage(limit, before);
            while (refreshPage && result.hasMore && result.messages.length < limit) {
                const next = await fetchPage(
                    limit - result.messages.length,
                    result.messages[0].timestamp,
                );
                result = { messages: merge(next.messages, result.messages), hasMore: next.hasMore };
                if (!next.messages.length) break;
            }
            const targets = [];
            for (const target of existing?.targets || []) {
                try {
                    targets.push(await get(`conversations/${c.id}/messages/${target.id}`));
                } catch (error) {
                    if (error.status !== 404) throw error;
                }
            }
            // Do not stamp an old response with a newer snapshot's authority. In particular,
            // an edit/delete received during these requests must trigger another refresh.
            if (!stillCurrent()) return;
            const messages = refreshPage
                ? result.messages
                : merge(result.messages, existing?.messages || []);
            await save(
                c.id,
                {
                    messages: merge(messages, task.evicted),
                    targets,
                    hasMore: result.hasMore,
                    version: task.version,
                },
                owner,
            );
            const height = scroller.scrollHeight,
                top = scroller.scrollTop;
            await changed();
            if (current()?.id === c.id)
                requestAnimationFrame(() => {
                    if (current()?.id === c.id)
                        scroller.scrollTop = top + scroller.scrollHeight - height;
                });
        } catch (error) {
            if (!stillCurrent()) return;
            if (error.status === 404) {
                delete pages[c.id];
                await persist(c.id, owner);
                await changed();
            } else if (!refreshPage) notice('Earlier history is not available offline.');
        } finally {
            endForeground();
            if (activeLoad === task) {
                activeLoad = null;
                indicator.hidden = true;
                const again = refreshAfterLoad;
                refreshAfterLoad = false;
                if (again) refresh();
            }
        }
    }

    async function target(c, id) {
        let message = view(c)?.messages.find((m) => m.id === id);
        if (!message && navigator.onLine) {
            try {
                const owner = identity(),
                    stamp = version(c),
                    turn = serial;
                message = await get(`conversations/${c.id}/messages/${id}`);
                const current = authorized(c.id);
                if (
                    identity()?.epoch !== owner.epoch ||
                    turn !== serial ||
                    !current ||
                    version(current) !== stamp
                )
                    return null;
                const old = valid(current) ? pages[c.id] : null;
                await save(
                    c.id,
                    {
                        messages: old?.messages || [],
                        targets: merge(old?.targets || [], [message]).slice(-20),
                        hasMore: old?.hasMore ?? current.hasMore,
                        version: stamp,
                    },
                    owner,
                );
                await changed();
            } catch {
                notice('The original message is unavailable.');
            }
        }
        return message;
    }

    async function jump(c, id) {
        const message = await target(c, id);
        if (!message) {
            notice('The original message is unavailable offline or has been removed.');
            return;
        }
        requestAnimationFrame(() => {
            const node = document.getElementById('msg-' + id);
            node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            node?.classList.add('highlight-message');
            setTimeout(() => node?.classList.remove('highlight-message'), 2000);
        });
    }

    return {
        view,
        load,
        jump,
        target,
        refresh,
        get busy() {
            return !!activeLoad;
        },
        async restore(snapshot) {
            latest = snapshot;
            pages = (await storage.metadata('history')) || {};
            for (const [id, page] of Object.entries(pages)) {
                // Upgrade old cache records without taking away offline reading. The next
                // online baseline revalidates them, even if its content version is unchanged.
                if (page.version === undefined && authorized(id)) {
                    page.version = version(authorized(id));
                    page.legacy = true;
                }
            }
        },
        async reconcile(snapshot) {
            let cacheChanged = false;
            const previous = latest;
            latest = snapshot;
            // An arrival only moves the recent-window boundary. Retain messages crossing
            // that boundary when older history is open, without downloading the page again.
            // Restricted histories still invalidate with content changes to honor access limits.
            for (const c of snapshot.conversations) {
                const before = previous?.conversations.find((old) => old.id === c.id);
                if (
                    !before ||
                    previous.serverEpoch !== snapshot.serverEpoch ||
                    c.historyLimited ||
                    before.historyVersion === undefined ||
                    before.historyVersion !== c.historyVersion
                )
                    continue;
                const ids = new Set(c.messages.map((m) => m.id));
                const evicted = before.messages.filter((m) => !ids.has(m.id));
                if (activeLoad?.channel === c.id)
                    activeLoad.evicted = merge(activeLoad.evicted, evicted);
                if (valid(c) && evicted.length) {
                    const combined = merge(pages[c.id].messages, evicted);
                    pages[c.id].hasMore ||= combined.length > 500;
                    pages[c.id].messages = combined.slice(-500);
                    cacheChanged = true;
                }
            }

            for (const id of Object.keys(pages)) {
                if (!authorized(id)) {
                    delete pages[id];
                    cacheChanged = true;
                } else if (pages[id].legacy) {
                    delete pages[id].legacy;
                    pages[id].version = null;
                    cacheChanged = true;
                }
            }
            // view() checks versions before merging, including after an offline reload.
            // Never display known stale history while an asynchronous refresh is pending.
            if (cacheChanged) await persist(current()?.id);
            return refresh();
        },
        clear() {
            serial++;
            pages = {};
            latest = null;
            activeLoad = null;
            refreshAfterLoad = false;
        },
    };
}
