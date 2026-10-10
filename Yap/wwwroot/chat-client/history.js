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
    const valid = (c) =>
        pages[c.id]?.version === version(c) || pages[c.id]?.pendingVersion === version(c);
    const authorized = (id) => latest?.conversations.find((c) => c.id === id);

    async function persist(channel, owner = identity()) {
        if (!owner || identity()?.epoch !== owner.epoch) return;
        // Extra history is a bounded cache, not a second unbounded message archive.
        const cached = Object.fromEntries(
            Object.entries(pages).map(([id, p]) => [
                id,
                {
                    ...p,
                    serverEpoch: p.serverEpoch || p.version?.split(':')[0] || latest.serverEpoch,
                    pendingVersion: undefined,
                    messages: p.messages.slice(-(latest?.historyMaxMessages ?? 500)),
                    hasMore: p.hasMore || p.messages.length > (latest?.historyMaxMessages ?? 500),
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
        await storage.saveHistory(cached, channel, owner);
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
        const task = {
            channel: c.id,
            version: version(c),
            sequence: latest.sequence,
            serial,
            evicted: [],
        };
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
            const limit = refreshPage
                ? Math.max(existing?.messages.length || 0, latest?.historyPageSize ?? 50)
                : (latest?.historyPageSize ?? 50);
            const fetchPage = (count, before) =>
                get(
                    `conversations/${c.id}/history?` +
                        new URLSearchParams({
                            limit: String(Math.min(count, latest?.historyMaxMessages ?? 500)),
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
                    serverEpoch: latest.serverEpoch,
                    // Arrivals may advance the revision during paging without changing
                    // this history version; the retained boundary rows already cover them.
                    revision: String(authorized(c.id).contentVersion),
                    sequence: authorized(c.id).sync?.metadata ?? task.sequence,
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
                        serverEpoch: latest.serverEpoch,
                        revision: String(current.contentVersion),
                        sequence: latest.sequence,
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
        async reconcile(snapshot, update) {
            let cacheChanged = false;
            const previous = latest;
            latest = snapshot;
            const patches = new Map((update?.conversations || []).map((p) => [p.id, p]));
            const authors = new Map((update?.authors || []).map((a) => [a.id, a]));
            for (const c of snapshot.conversations) {
                const before = previous?.conversations.find((old) => old.id === c.id);
                const page = pages[c.id];
                const patch = patches.get(c.id);
                const sameEpoch = previous?.serverEpoch === snapshot.serverEpoch;
                const wasValid =
                    before &&
                    page &&
                    (page.version ===
                        `${previous.serverEpoch}:${before.historyLimited ? before.contentVersion : (before.historyVersion ?? before.contentVersion)}` ||
                        page.pendingVersion ===
                            `${previous.serverEpoch}:${before.historyVersion ?? before.contentVersion}`);
                if (
                    page &&
                    wasValid &&
                    sameEpoch &&
                    !c.historyLimited &&
                    patch &&
                    update.serverEpoch === snapshot.serverEpoch
                ) {
                    page.revision ??= String(before.contentVersion);
                    const stale = update.sequence < (page.sequence || 0);
                    const continuous = patch.baseRevision === page.revision;
                    const duplicate = patch.revision === page.revision;
                    if (
                        !stale &&
                        ((patch.invalidate && !duplicate) ||
                            (patch.baseRevision && !continuous && !duplicate))
                    ) {
                        page.version = null;
                        delete page.pendingVersion;
                        cacheChanged = true;
                    } else if (
                        !stale &&
                        !patch.window &&
                        !patch.invalidate &&
                        (!patch.baseRevision || continuous || duplicate) &&
                        (patch.baseRevision ||
                            patch.messages.length ||
                            patch.removed.length ||
                            !valid(c))
                    ) {
                        // The recent window drops old upserts; apply the original delta to
                        // visited pages too. Per-record stamps protect against late HTTP acks.
                        const changed = new Map(
                            patch.messages.map((m) => [
                                m.id,
                                { ...m, author: authors.get(m.authorId) },
                            ]),
                        );
                        const removed = new Set(patch.removed);
                        page.records ||= {};
                        const apply = (messages) =>
                            messages.flatMap((message) => {
                                if (
                                    update.sequence <=
                                    (page.records[message.id] || page.sequence || 0)
                                )
                                    return [message];
                                if (removed.has(message.id)) return [];
                                return [changed.get(message.id) || message];
                            });
                        page.messages = apply(page.messages);
                        page.targets = apply(page.targets || []);
                        for (const id of [...changed.keys(), ...removed])
                            page.records[id] = Math.max(page.records[id] || 0, update.sequence);
                        if (continuous || duplicate) {
                            page.revision = patch.revision;
                            page.version = `${snapshot.serverEpoch}:${patch.state.historyVersion ?? patch.state.contentVersion}`;
                            page.sequence = Math.max(page.sequence || 0, update.sequence);
                            page.records = Object.fromEntries(
                                Object.entries(page.records).filter(
                                    ([, seq]) => seq > page.sequence,
                                ),
                            );
                        }
                        // A compact acknowledgement/metadata packet is not a complete revision
                        // chain. Keep the mounted view until the stream catches up or signals a
                        // gap; never persist that provisional validation across a reload.
                        page.pendingVersion = version(c);
                        cacheChanged = true;
                    }
                }
                // Retain messages crossing the recent-window boundary, without imposing
                // the disk cache's 500-row budget on the reader's mounted history.
                if (
                    !before ||
                    !sameEpoch ||
                    c.historyLimited ||
                    (!valid(c) &&
                        !(
                            activeLoad?.channel === c.id &&
                            before.historyVersion === c.historyVersion
                        ))
                )
                    continue;
                const ids = new Set(c.messages.map((m) => m.id));
                const removed = new Set(patch?.removed || []);
                const evicted = before.messages.filter((m) => !ids.has(m.id) && !removed.has(m.id));
                if (activeLoad?.channel === c.id)
                    activeLoad.evicted = merge(activeLoad.evicted, evicted);
                if (page && evicted.length) {
                    page.messages = merge(page.messages, evicted);
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
            // Persist patched pages before painting them, but never make rendering wait
            // on network recovery for an invalidated page.
            refresh()?.catch(() => {});
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
