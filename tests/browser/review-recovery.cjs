// Focused regressions for the whole-rewrite review. Use an isolated local fixture.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Isolated local test server required');

(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        // This harness tests IndexedDB durability, not shell caching. Retain the actual
        // served modules so it can inspect storage after an offline harness reload.
        const modules = new Map();
        await context.route('**/chat-client/*.js', async (route) => {
            const url = route.request().url();
            if (!modules.has(url)) modules.set(url, await (await route.fetch()).text());
            await route.fulfill({ contentType: 'text/javascript', body: modules.get(url) });
        });
        await context.route('**/review-harness', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: '<div class="messages"></div><div id="history-loading" hidden></div>',
            }),
        );
        const page = await context.newPage(),
            sibling = await context.newPage();
        await page.goto(origin + '/review-harness');
        await sibling.goto(origin + '/review-harness');
        await page.evaluate(async () => {
            window.store = await import('/chat-client/storage.js');
            window.createSender = (await import('/chat-client/sender.js')).createSender;
            window.owner = await store.establish(crypto.randomUUID());
            window.beginUpload = async (method, timeout = false) => {
                window.entered = false;
                window.aborted = false;
                window.sent = [];
                let completed = false;
                const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
                window.deadlines = [];
                if (timeout)
                    AbortSignal.timeout = (ms) => {
                        deadlines.push(ms);
                        return nativeTimeout(ms === 30000 ? 50 : ms);
                    };
                const extra =
                    method === 'POST'
                        ? {}
                        : { uploads: [{ id: 'fixture', url: '/api/tus/fixture' }] };
                window.job = await store.enqueue('room', '', owner, {
                    files: [new File(['x'], 'fixture.png', { type: 'image/png' })],
                    ...extra,
                });
                window.next = await store.enqueue('room', 'later text', owner);
                window.fetch = async (url, options = {}) => {
                    url = String(url);
                    if (url.endsWith('/session')) return Response.json({ userId: owner.userId });
                    if (url.includes('/uploads/'))
                        return completed
                            ? Response.json({ type: 'image' })
                            : new Response('', { status: 404 });
                    if (url.endsWith('/messages')) {
                        const payload = JSON.parse(options.body);
                        sent.push(payload.operationId);
                        return Response.json({ operationId: payload.operationId });
                    }
                    if (options.method === method && !window.entered) {
                        entered = true;
                        return new Promise((resolve, reject) => {
                            const abort = () => {
                                aborted = true;
                                reject(options.signal.reason);
                            };
                            options.signal?.addEventListener('abort', abort, { once: true });
                            if (options.signal?.aborted) abort();
                        });
                    }
                    if (options.method === 'POST')
                        return new Response('', {
                            status: 201,
                            headers: { Location: '/api/tus/fixture' },
                        });
                    if (options.method === 'HEAD')
                        return new Response(null, {
                            status: 200,
                            headers: { 'Upload-Offset': '0' },
                        });
                    if (options.method === 'PATCH') {
                        completed = true;
                        return new Response(null, {
                            status: 204,
                            headers: { 'Upload-Offset': '1' },
                        });
                    }
                    throw new Error('Unexpected request ' + url);
                };
                window.sender = createSender({
                    identity: () => owner,
                    changed: async () => {},
                    accepted: async (_, id) => store.removeOutgoing(id, owner),
                    authRequired: async () => {
                        throw new Error('Unexpected auth failure');
                    },
                    failed: (error) => {
                        throw error;
                    },
                });
                window.flush = sender.flush().finally(() => {
                    AbortSignal.timeout = nativeTimeout;
                });
            };
        });
        for (const method of ['POST', 'HEAD', 'PATCH']) {
            await page.evaluate((method) => beginUpload(method), method);
            await page.waitForFunction(() => entered);
            const job = await page.evaluate(() => job.operationId);
            await page.evaluate(async () => {
                window.independent = await store.enqueue(
                    'other-room',
                    'not blocked by upload',
                    owner,
                );
                sender.flush();
            });
            await page.waitForFunction(() => !aborted && sent.includes(independent.operationId));
            console.log('PASS text in another conversation proceeds during stalled upload');
            // A sibling tab can cancel the job even though another tab owns the sender lock.
            await sibling.evaluate(async (id) => {
                const store = await import('/chat-client/storage.js');
                const owner = await store.readState();
                const { createSender } = await import('/chat-client/sender.js');
                const sender = createSender({
                    identity: () => owner,
                    changed: async () => {},
                    failed: (error) => {
                        throw error;
                    },
                });
                sender.stop();
                await sender.cancelUpload(id, owner);
            }, job);
            await page.waitForFunction(() => aborted && sent.includes(next.operationId));
            await page.evaluate(async () => {
                await flush;
                sender.stop();
            });
            assert.equal(await page.evaluate(async () => (await store.outbox()).length), 0);
            console.log('PASS stalled tus ' + method + ' cancelled across tabs; later text sends');
        }
        await page.evaluate(() => beginUpload('PATCH', true));
        await page.waitForFunction(() => aborted);
        await page.evaluate(async () => {
            await flush;
            sender.stop();
        });
        assert.equal(await page.evaluate(() => deadlines.includes(30000)), true);
        assert.equal(
            await sibling.evaluate(async () => {
                const owner = await (await import('/chat-client/storage.js')).readState();
                return navigator.locks.request(
                    'yap-send-' + owner.userId,
                    { ifAvailable: true },
                    (lock) => !!lock,
                );
            }),
            true,
        );
        assert.equal(
            await page.evaluate(
                async () =>
                    (await store.outbox()).find((m) => m.operationId === job.operationId).uploads[0]
                        .id,
            ),
            'fixture',
        );
        await page.evaluate(() => sender.start());
        await page.waitForFunction(
            () => sent.includes(job.operationId) && sent.includes(next.operationId),
        );
        await page.evaluate(() => sender.stop());
        console.log(
            'PASS upload timeout releases lock and retry resumes the saved upload with the same operation ID',
        );

        await page.evaluate(() => beginUpload('HEAD'));
        await page.waitForFunction(() => entered);
        await page.evaluate(async () => {
            sender.stop();
            await flush;
        });
        assert.equal(await page.evaluate(() => aborted), true);
        assert.equal(await page.evaluate(async () => (await store.outbox()).length), 2);
        await page.evaluate(() => sender.start());
        await page.waitForFunction(
            () => sent.includes(job.operationId) && sent.includes(next.operationId),
        );
        await page.evaluate(() => sender.stop());
        console.log('PASS sender shutdown aborts the active request and preserves resumable work');

        await context.setOffline(true);
        const retained = await page.evaluate(async () => {
            const failed = await store.enqueue('room', '', owner, {
                files: [new File(['blob'], 'failed.png')],
            });
            await store.setDelivery(failed.operationId, 'failed', 'Rejected', owner);
            const other = await store.enqueue('room', 'Keep this draft', owner);
            await sender.cancelUpload(failed.operationId, owner);
            return other.operationId;
        });
        await page.reload();
        assert.deepEqual(
            await page.evaluate(async () =>
                (await (await import('/chat-client/storage.js')).outbox()).map(
                    (m) => m.operationId,
                ),
            ),
            [retained],
        );
        console.log(
            'PASS cancelling a failed upload offline removes its blob through reload and preserves other work',
        );
        await context.setOffline(false);

        await page.evaluate(async () => {
            const store = await import('/chat-client/storage.js');
            window.store = store;
            window.owner = await store.readState();
            const { createHistory } = await import('/chat-client/history.js');
            const old = { id: 'old', timestamp: '2026-01-01T00:00:00Z', content: 'removed' };
            const recent = { id: 'recent', timestamp: '2026-02-01T00:00:00Z', content: 'current' };
            window.a = { id: 'a', contentVersion: 1, messages: [recent], hasMore: true };
            window.b = { id: 'b', contentVersion: 1, messages: [], hasMore: false };
            window.selected = b;
            window.snapshot = { serverEpoch: 'server', conversations: [a, b] };
            await store.saveMetadata(
                'history',
                { a: { messages: [old], targets: [], hasMore: false, version: 'server:1' } },
                owner,
            );
            window.requests = 0;
            window.fetch = async () => {
                requests++;
                return Response.json({ messages: [], hasMore: false });
            };
            window.historyCache = createHistory({
                identity: () => owner,
                current: () => selected,
                changed: async () => {},
                notice: () => {},
            });
            await historyCache.restore(snapshot);
            if (!historyCache.view(a).messages.some((m) => m.id === 'old'))
                throw new Error('Offline baseline cache was lost');
            a = { ...a, contentVersion: 2 };
            snapshot = { ...snapshot, conversations: [a, b] };
            await historyCache.reconcile(snapshot);
            if (historyCache.view(a).messages.some((m) => m.id === 'old'))
                throw new Error('Known stale history is visible');
            selected = a;
            await historyCache.refresh();
            if (requests !== 1 || historyCache.view(a).messages.some((m) => m.id === 'old'))
                throw new Error('Navigation failed to refresh');
        });
        console.log(
            'PASS inactive history invalidates on newer authority and refreshes on navigation without another snapshot',
        );

        await page.evaluate(async () => {
            a = { ...a, contentVersion: 3 };
            selected = a;
            let first = true;
            window.fetch = async () => {
                if (first) {
                    first = false;
                    return new Promise((resolve) => {
                        window.releaseHistory = resolve;
                    });
                }
                return Response.json({
                    messages: [{ id: 'new', timestamp: '2026-01-01T00:00:00Z' }],
                    hasMore: false,
                });
            };
            window.refreshing = historyCache.reconcile({ ...snapshot, conversations: [a, b] });
        });
        await page.waitForFunction(() => !!window.releaseHistory);
        await page.evaluate(async () => {
            a = { ...a, contentVersion: 4 };
            selected = a;
            await historyCache.reconcile({ ...snapshot, conversations: [a, b] });
            releaseHistory(
                Response.json({
                    messages: [{ id: 'stale', timestamp: '2026-01-01T00:00:00Z' }],
                    hasMore: false,
                }),
            );
            await refreshing;
        });
        await page.waitForFunction(() => historyCache.view(a).messages.some((m) => m.id === 'new'));
        assert.equal(
            await page.evaluate(() => historyCache.view(a).messages.some((m) => m.id === 'stale')),
            false,
        );
        console.log(
            'PASS snapshot during history fetch discards the stale response and refreshes again',
        );
        await context.close();
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
