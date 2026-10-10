// Retry/storage and discard regressions; a disposable local application is required.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { poll } = require('./support/wait.cjs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Disposable fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const isolated = await browser.newContext({ serviceWorkers: 'block' });
        await isolated.route('**/low-harness', (route) =>
            route.fulfill({ contentType: 'text/html', body: '<p>Storage harness</p>' }),
        );
        const harness = await isolated.newPage();
        await harness.goto(origin + '/low-harness');
        const retry = await harness.evaluate(async () => {
            const store = await import('/chat-client/storage.js');
            const { createSender } = await import('/chat-client/sender.js');
            const owner = await store.establish(crypto.randomUUID());
            const first = await store.enqueue('a', 'keep this intent', owner);
            const second = await store.enqueue('b', 'independent', owner);
            let calls = [],
                now = Date.now(),
                failing = true;
            const realNow = Date.now;
            Date.now = () => now;
            window.fetch = async (url, options = {}) => {
                if (String(url).endsWith('/session'))
                    return Response.json({ userId: owner.userId });
                const body = JSON.parse(options.body);
                calls.push(body);
                if (body.channelId === 'a' && failing)
                    throw new Error('Unrecognized transport failure');
                return Response.json({ operationId: body.operationId });
            };
            const create = () =>
                createSender({
                    identity: () => owner,
                    changed: async () => {},
                    accepted: (_, id) => store.removeOutgoing(id, owner),
                    authRequired: () => {
                        throw Error('Unexpected auth');
                    },
                    failed: (error) => {
                        throw error;
                    },
                });
            let sender = create();
            await sender.flush();
            sender.stop();
            const afterFirst = await store.outbox();
            const callsAfterFirst = calls.length;
            sender = create();
            await sender.flush();
            sender.stop();
            const callsBeforeDue = calls.length;
            const delays = [afterFirst[0].nextAttemptAt - now];
            for (let i = 1; i < 8; i++) {
                const item = (await store.outbox())[0];
                now = item.nextAttemptAt + 1;
                sender = create();
                await sender.flush();
                sender.stop();
                const remaining = (await store.outbox())[0];
                if (remaining.status !== 'failed') delays.push(remaining.nextAttemptAt - now);
            }
            const stopped = (await store.outbox())[0];
            sender = create();
            await sender.flush();
            sender.stop();
            const automaticCalls = calls.filter((x) => x.operationId === first.operationId).length;
            failing = false;
            await store.setDelivery(first.operationId, 'queued', null, owner);
            sender = create();
            await sender.flush();
            sender.stop();
            Date.now = realNow;
            return {
                independentDelivered: !afterFirst.some((x) => x.operationId === second.operationId),
                callsAfterFirst,
                callsBeforeDue,
                delays,
                automaticCalls,
                status: stopped.status,
                attempts: stopped.retryAttempts,
                remaining: (await store.outbox()).length,
                sameIntent: calls
                    .filter((x) => x.channelId === 'a')
                    .every(
                        (x) => x.operationId === first.operationId && x.content === first.content,
                    ),
                metadataOnWire: calls.some((x) => 'retryAttempts' in x || 'nextAttemptAt' in x),
            };
        });
        assert(retry.independentDelivered && retry.sameIntent && !retry.metadataOnWire);
        assert.equal(retry.callsAfterFirst, retry.callsBeforeDue);
        assert.equal(retry.automaticCalls, 8);
        assert.equal(retry.status, 'failed');
        assert.equal(retry.attempts, 8);
        assert.equal(retry.remaining, 0);
        retry.delays.forEach((delay, i) => {
            const cap = Math.min(60000, 3000 * 2 ** i);
            assert(delay >= cap * 0.75 && delay <= cap);
        });
        console.log(
            'PASS persisted retry backoff, independent conversations, bounded unknown failures and manual retry with unchanged intent',
        );
        // Deleting the DB triggers versionchange. The next operation must open a new connection.
        assert.equal(
            await harness.evaluate(async () => {
                const store = await import('/chat-client/storage.js');
                await store.readState();
                await new Promise((resolve, reject) => {
                    const r = indexedDB.deleteDatabase('yap-chat-v1');
                    r.onsuccess = resolve;
                    r.onerror = () => reject(r.error);
                });
                return (await store.readState()) === undefined;
            }),
            true,
        );
        console.log('PASS IndexedDB reopens after versionchange');
        await isolated.close();

        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('low' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(
            () =>
                document.querySelector('#connection')?.textContent.startsWith('Synced') &&
                !document.querySelector('#draft').disabled,
        );
        await page.locator('#draft').fill('retain unsent draft');
        await poll(page, async () => (await import('/chat-client/storage.js')).hasUnsentWork());
        for (const button of ['#forget', '#signout']) {
            const warnings = [];
            const dismiss = async (dialog) => {
                warnings.push(dialog.message());
                await dialog.dismiss();
            };
            page.on('dialog', dismiss);
            await page.evaluate(async (selector) => {
                if (selector === '#signout') {
                    const { get } = await import('/chat-client/api.js');
                    (await get('session')).hasWayBack = true;
                }
                await document.querySelector(selector).onclick();
            }, button);
            page.off('dialog', dismiss);
            assert(
                warnings.some(
                    (text) => text.includes('unsent messages') && text.includes('drafts'),
                ),
            );
            assert.equal(await page.locator('#draft').inputValue(), 'retain unsent draft');
        }
        // A queued attachment/change can remain even when the active composer is empty.
        await page.evaluate(async () => {
            const s = await import('/chat-client/storage.js');
            const owner = await s.readIdentity();
            const item = await s.enqueue('fixture', '', owner, {
                files: [new File(['x'], 'fixture.png')],
            });
            await s.setDelivery(item.operationId, 'failed', 'fixture', owner);
        });
        await page.goto(origin + '/settings');
        await page.waitForFunction(() => typeof window.confirmChatDiscard === 'function');
        const retainedDialog = page.waitForEvent('dialog');
        const retainedResult = page.evaluate(() => window.confirmChatDiscard());
        const dialog = await retainedDialog;
        assert(dialog.message().includes('attachments'));
        await dialog.dismiss();
        assert.equal(await retainedResult, false);
        console.log(
            'PASS chat and retained-page discard warnings preserve drafts and queued attachments on cancel',
        );
        await page.goto(origin + '/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        page.once('dialog', (dialog) => dialog.accept());
        await page.evaluate(() => document.querySelector('#forget').onclick());
        assert.equal(
            await page.evaluate(async () =>
                (await import('/chat-client/storage.js')).hasUnsentWork(),
            ),
            false,
        );
        console.log('PASS explicit Forget discards work only after confirmation');
        await context.close();
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
