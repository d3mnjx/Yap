import { uploadAttachments } from './uploads.js';
import * as storage from './storage.js';
import { get, post, beginForeground, ApiError } from './api.js';

// One coordinator per account across tabs. Conversations progress independently;
// operations within one conversation stay ordered. Only one upload runs at a time.
export function createSender({ identity, accepted, changed, authRequired, failed }) {
    let running = false,
        timer,
        stopped = false,
        wake;
    const active = new Map();
    const refresh = () => Promise.resolve(changed()).catch(failed);
    function cancelActive(operationId, epoch) {
        for (const job of active.values())
            if (job.epoch === epoch && job.items.some((item) => item.operationId === operationId))
                job.controller.abort(
                    Object.assign(new Error('Upload cancelled'), { code: 'cancelled' }),
                );
    }
    storage.onExternalChange((event) => {
        if (event?.type === 'cancel-upload') cancelActive(event.operationId, event.epoch);
        wake?.();
    });
    function later() {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(flush, 3000);
    }
    const media = (item) =>
        !!(item.files?.length || item.gifSource || item.gifEntryId || item.uploadIds?.length);
    const payload = ({ files, uploads, progress, gifPreview, gifSource, ...item }) => item;
    async function reject(item, error, account) {
        const terminal =
            error.code === 'persistence_required' ||
            ([400, 403, 404, 409, 413].includes(error.status) && error.code !== 'csrf');
        await storage.setDelivery(
            item.operationId,
            terminal ? 'failed' : 'queued',
            terminal ? error.message : 'Waiting for connection. Retrying is safe.',
            account,
        );
        return !terminal;
    }
    async function deliver(job, account) {
        const signal = job.controller.signal,
            finish = beginForeground();
        try {
            const session = await get('session', { signal });
            if (session.userId !== account.userId) throw new Error('ACCOUNT_CHANGED');
            if (stopped || identity()?.epoch !== account.epoch) return false;
            for (const item of job.items)
                await storage.setDelivery(item.operationId, 'sending', null, account);
            refresh();
            if (job.items.length > 1) {
                const result = await post('operations', job.items.map(payload), session, {
                    signal,
                });
                if (
                    result.results?.length !== job.items.length ||
                    result.results.some((r, i) => r.operationId !== job.items[i].operationId)
                )
                    throw new Error('Unexpected batch acknowledgement');
                let retry = false;
                for (const [index, receipt] of result.results.entries()) {
                    if (receipt.status)
                        retry =
                            (await reject(
                                job.items[index],
                                new ApiError(receipt.status, receipt),
                                account,
                            )) || retry;
                    else await accepted(receipt.update, receipt.operationId, account);
                }
                return retry;
            }
            let item = await uploadAttachments(job.items[0], account, changed, signal);
            if (item.gifSource && !item.gifEntryId) {
                const resolved = await post('gifs/select', item.gifSource, session, { signal });
                item = { ...item, gifEntryId: resolved.id };
                await storage.patchOutgoing(item.operationId, { gifEntryId: resolved.id }, account);
            }
            signal.throwIfAborted();
            const result = await post(
                `conversations/${item.channelId}/messages${item.kind ? `/${item.messageId}/actions` : ''}`,
                payload(item),
                session,
                { signal },
            );
            if (result.operationId !== item.operationId)
                throw new Error('Unexpected send acknowledgement');
            await accepted(result.update || result.snapshot, item.operationId, account);
            return false;
        } catch (error) {
            if (signal.aborted) error = signal.reason;
            if (error.code === 'sender_stopped') return false;
            if (error.code === 'cancelled') {
                for (const item of job.items)
                    await storage.removeOutgoing(item.operationId, account);
                await refresh();
                return false;
            }
            if (
                ['ACCOUNT_CHANGED', 'AUTH_REQUIRED'].includes(error.message) ||
                error.status === 401
            ) {
                await authRequired();
                return false;
            }
            let retry = false;
            for (const item of job.items) retry = (await reject(item, error, account)) || retry;
            await refresh();
            return retry;
        } finally {
            finish();
        }
    }
    async function flush() {
        if (running) {
            wake?.();
            return;
        }
        const account = identity();
        if (!account || stopped || !navigator.onLine) return;
        running = true;
        try {
            await navigator.locks.request(
                'yap-send-' + account.userId,
                { ifAvailable: true },
                async (lock) => {
                    if (!lock) return;
                    const retry = new Set();
                    while (!stopped && identity()?.epoch === account.epoch && navigator.onLine) {
                        const notified = new Promise((resolve) => {
                            wake = resolve;
                        });
                        const queue = (await storage.outbox()).filter(
                            (item) => item.cancelled || item.status !== 'failed',
                        );
                        for (const item of queue.filter((item) => item.cancelled))
                            await storage.removeOutgoing(item.operationId, account);
                        const channels = [
                            ...new Set(
                                queue
                                    .filter((item) => !item.cancelled)
                                    .map((item) => item.channelId),
                            ),
                        ];
                        for (const channel of channels) {
                            if (active.size >= 3) break;
                            if (active.has(channel) || retry.has(channel)) continue;
                            const candidates = queue.filter(
                                (item) => !item.cancelled && item.channelId === channel,
                            );
                            const uploading = media(candidates[0]);
                            if (uploading && [...active.values()].some((job) => job.uploading))
                                continue;
                            const items = [candidates[0]];
                            if (!uploading)
                                for (const item of candidates.slice(1, 16)) {
                                    if (
                                        media(item) ||
                                        new TextEncoder().encode(
                                            JSON.stringify([...items, item].map(payload)),
                                        ).byteLength >
                                            48 * 1024
                                    )
                                        break;
                                    items.push(item);
                                }
                            const job = {
                                epoch: account.epoch,
                                controller: new AbortController(),
                                items,
                                uploading,
                            };
                            active.set(channel, job);
                            job.done = deliver(job, account)
                                .then((again) => {
                                    if (again) retry.add(channel);
                                })
                                .catch(failed)
                                .finally(() => {
                                    active.delete(channel);
                                    wake?.();
                                });
                        }
                        if (!active.size) break;
                        await Promise.race([
                            notified,
                            ...[...active.values()].map((job) => job.done),
                        ]);
                    }
                    // Stop/cookie changes must release the coordinator only after its requests
                    // have unwound, so a sibling cannot race an old document's work.
                    await Promise.allSettled([...active.values()].map((job) => job.done));
                },
            );
        } catch (error) {
            if (error.message !== 'ACCOUNT_CHANGED') failed(error);
        } finally {
            running = false;
            wake = null;
            later();
        }
    }
    return {
        flush,
        start() {
            stopped = false;
            flush();
        },
        stop() {
            stopped = true;
            clearTimeout(timer);
            for (const job of active.values())
                job.controller.abort(
                    Object.assign(new Error('Sender stopped'), { code: 'sender_stopped' }),
                );
            wake?.();
        },
        async cancelUpload(operationId, account) {
            await storage.removeOutgoing(operationId, account);
            cancelActive(operationId, account.epoch);
            storage.notify({ type: 'cancel-upload', operationId, epoch: account.epoch });
            await refresh();
            flush();
        },
    };
}
