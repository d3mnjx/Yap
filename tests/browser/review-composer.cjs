// Real UI regressions for reply ownership across asynchronous enqueue and navigation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Isolated local fixture required');

(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext(),
            buddyContext = await browser.newContext();
        const page = await context.newPage(),
            buddy = await buddyContext.newPage();
        const name = 'replyfix' + Date.now().toString(36),
            errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        for (const [p, username] of [
            [page, name],
            [buddy, name + 'b'],
        ]) {
            await p.goto(origin + '/login');
            await p.locator('.username-input').fill(username);
            await p.locator('.join-button').click();
            await p.waitForURL('**/lobby');
            await p.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
        }
        const session = await (await context.request.get(origin + '/api/chat/session')).json();
        const headers = { 'X-CSRF-TOKEN': session.csrfToken };
        const dm = await (
            await context.request.post(origin + '/api/chat/dm/' + name + 'b', { headers, data: {} })
        ).json();
        const send = async (id, content) => {
            const response = await context.request.post(
                origin + `/api/chat/conversations/${id}/messages`,
                {
                    headers,
                    data: { operationId: randomUUID(), content },
                },
            );
            assert.equal(response.status(), 200);
            return (await response.json()).messageId;
        };
        const first = await send(dm.channelId, 'First saved reply');
        const second = await send(dm.channelId, 'Second saved reply');
        const lobbyId = dm.snapshot.conversations.find((c) => c.isDefault).id;
        const lobbyTarget = await send(lobbyId, 'Lobby reply');
        const selectReply = (id) =>
            page.locator('#msg-' + id + ' .action-reply').click({ force: true });
        const savedReply = (id) =>
            page.evaluate(
                async (id) => (await import('/chat-client/storage.js')).replyDraft(id),
                id,
            );
        const count = () =>
            page.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length,
            );
        const hold = async () => {
            await page.evaluate(() => {
                window.reviewLockHeld = false;
                navigator.locks.request('yap-chat-v1', async () => {
                    window.reviewLockHeld = true;
                    await new Promise((resolve) => {
                        window.reviewRelease = resolve;
                    });
                });
            });
            await page.waitForFunction(() => window.reviewLockHeld);
        };
        const upload = () =>
            page.locator('#upload-files').setInputFiles({
                name: 'reply.png',
                mimeType: 'image/png',
                buffer: Buffer.from('fixture'),
            });
        const waitJobs = (n) =>
            page.waitForFunction(
                async (n) =>
                    (await (await import('/chat-client/storage.js')).outbox()).length === n,
                n,
            );

        await page.goto(origin + '/dm/' + name + 'b');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await selectReply(first);
        await page.waitForFunction(async (id) => {
            const reply = await (await import('/chat-client/storage.js')).replyDraft(id);
            if (!reply) return false;
            window.reviewOriginalReply = reply;
            return true;
        }, dm.channelId);
        const originalDmReply = await page.evaluate(() => window.reviewOriginalReply);
        assert(originalDmReply?.draftId, 'Original DM reply must be saved before navigation');
        await page.locator('#back').click();
        await page.locator('#draft:not([disabled])').waitFor();
        await selectReply(lobbyTarget);
        await page.waitForFunction(
            async (id) => !!(await (await import('/chat-client/storage.js')).replyDraft(id)),
            lobbyId,
        );
        await context.setOffline(true);
        await hold();
        await upload();
        await page.locator(`#dms a[href="/dm/${name + 'b'}"]`).click();
        await page.locator('#reply-bar:not([hidden])').waitFor();
        await page.evaluate(() => window.reviewRelease());
        await waitJobs(1);
        assert.equal((await savedReply(dm.channelId)).draftId, originalDmReply.draftId);
        assert.equal(await savedReply(lobbyId), undefined);
        assert.equal(await page.locator('#reply-bar').isVisible(), true);
        assert.equal(
            await page.evaluate(
                async () =>
                    (await (await import('/chat-client/storage.js')).outbox())[0].replyToMessageId,
            ),
            lobbyTarget,
        );
        console.log(
            'PASS attachment completes after navigation without clearing the destination reply; source reply clears atomically',
        );

        for (const [kind, replacement] of [
            ['attachment', second],
            ['text', first],
            ['text', second],
        ]) {
            await selectReply(first);
            await page.waitForFunction(
                async ({ channel, message }) =>
                    (await (await import('/chat-client/storage.js')).replyDraft(channel))?.id ===
                    message,
                { channel: dm.channelId, message: first },
            );
            const before = await savedReply(dm.channelId),
                jobs = await count();
            if (kind === 'text') {
                await page.locator('#draft').fill('Queued reply ' + randomUUID());
                await page.waitForFunction(
                    async (channel) =>
                        (await (await import('/chat-client/storage.js')).draft(channel)) ===
                        document.querySelector('#draft').value,
                    dm.channelId,
                );
            }
            await hold();
            if (kind === 'attachment') await upload();
            else await page.locator('#send').click();
            await selectReply(replacement);
            await page.evaluate(() => window.reviewRelease());
            await waitJobs(jobs + 1);
            await page.waitForFunction(
                async ({ channel, previous }) => {
                    const saved = await (
                        await import('/chat-client/storage.js')
                    ).replyDraft(channel);
                    return saved && saved.draftId !== previous;
                },
                { channel: dm.channelId, previous: before.draftId },
            );
            assert.equal((await savedReply(dm.channelId)).id, replacement);
            assert.equal(await page.locator('#reply-bar').isVisible(), true);
            assert.equal(
                await page.evaluate(
                    async () =>
                        (await (await import('/chat-client/storage.js')).outbox()).at(-1)
                            .replyToMessageId,
                ),
                first,
            );
            console.log(
                'PASS ' +
                    kind +
                    ' completion preserves a new reply selection' +
                    (replacement === first ? ' of the same target' : ''),
            );
        }
        assert.deepEqual(errors, []);
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
