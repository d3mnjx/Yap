// Synthetic users on the isolated test app. The reference pass uses its separate database.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const reference = process.env.YAP_REFERENCE === '1',
    origin =
        process.env.YAP_TEST_ORIGIN ||
        (reference ? 'https://localhost:7443' : 'http://127.0.0.1:7643');
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw Error('Local fixture only');
const output = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-actions-browser';
fs.mkdirSync(output, { recursive: true });
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            ignoreHTTPSErrors: reference,
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const username = 'actions' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(username);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        const other = await browser.newContext({ ignoreHTTPSErrors: reference }),
            buddy = await other.newPage();
        await buddy.goto(origin + '/login');
        await buddy.locator('.username-input').fill(username + 'b');
        await buddy.locator('.join-button').click();
        await buddy.waitForURL('**/lobby');
        await page.bringToFront();
        await page.goto(origin + '/dm/' + username + 'b');
        const draft = page.locator(reference ? '.message-input' : '#draft');
        await draft.waitFor();
        if (!reference)
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
        const send = async (text) => {
            await draft.fill(text);
            await page.locator(reference ? '.send-button' : '#send').click();
            await page.locator('.message-group').filter({ hasText: text }).first().waitFor();
        };
        const row = (text) =>
            page
                .locator('.message-group')
                .filter({ has: page.locator('.message-content').filter({ hasText: text }) })
                .first();
        const action = async (text, title) => {
            await row(text).hover();
            await row(text).getByTitle(title, { exact: true }).click();
        };
        await send('Action target');
        await action('Action target', 'Reply');
        await page.locator('.reply-bar').waitFor();
        await send('Reply body');
        await row('Reply body').locator('.reply-preview').waitFor();
        assert(
            (await row('Reply body').locator('.reply-preview').innerText()).includes(
                'Action target',
            ),
        );
        await action('Action target', 'Edit');
        await page.locator('.edit-input').fill('Edited target');
        await page.locator('.edit-save').click();
        await row('Edited target').waitFor();
        await action('Edited target', 'Edit');
        await page.locator('.edit-input').fill('Cancelled edit');
        await page.locator('.edit-input').press('Escape');
        await page.locator('.edit-input').waitFor({ state: 'detached' });
        await action('Edited target', '👍');
        await row('Edited target').locator('.reaction-pill').waitFor();
        await row('Edited target').locator('.reaction-pill').click();
        await page.waitForFunction(
            () =>
                ![...document.querySelectorAll('.message-group')]
                    .find((n) =>
                        n.querySelector('.message-content')?.textContent.includes('Edited target'),
                    )
                    ?.querySelector('.reaction-pill'),
        );
        if (!reference) {
            await page.waitForFunction(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
            );
            await page.waitForTimeout(250);
        }
        await action('Edited target', 'More');
        await page.getByRole('button', { name: 'Copy Text', exact: true }).click();
        await page.waitForFunction(
            async () => (await navigator.clipboard.readText()) === 'Edited target',
        );
        await action('Edited target', 'More');
        await page.getByRole('button', { name: 'Delete Message', exact: true }).click();
        await page.locator('.confirm-cancel').click();
        await row('Edited target').waitFor();
        await page.screenshot({ path: output + '/actions-desktop.png' });
        console.log(
            'PASS ' +
                (reference ? 'reference' : 'rewrite') +
                ' reply association, inline edit/cancel, reaction toggle, copy, delete cancel',
        );
        if (!reference) {
            await send('Edit cancellation target');
            await page.waitForFunction(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
            );
            // A sibling client can accept an edit while this tab keeps its local editor open.
            for (const cancelVia of ['button', 'Escape', 'another editor']) {
                await action('Edit cancellation target', 'Edit');
                await page.locator('.edit-input').fill('Unsaved local edit');
                const accepted = 'Accepted sibling edit ' + cancelVia;
                await page.evaluate(async (content) => {
                    const api = await import('/chat-client/api.js'),
                        s = await (await import('/chat-client/storage.js')).readState(),
                        c = s.snapshot.conversations.find((c) => c.path === location.pathname),
                        m = c.messages.find((m) => m.content === 'Edit cancellation target');
                    await api.post(
                        `conversations/${c.id}/messages/${m.id}/actions`,
                        { operationId: crypto.randomUUID(), kind: 'edit', content },
                        await api.get('session'),
                    );
                }, accepted);
                await page.waitForFunction(
                    async (content) =>
                        (
                            await (await import('/chat-client/storage.js')).readState()
                        ).snapshot.conversations.some((c) =>
                            c.messages.some((m) => m.content === content),
                        ),
                    accepted,
                );
                assert.equal(await page.locator('.edit-input').inputValue(), 'Unsaved local edit');
                // Let the committed snapshot finish rendering before stopping live packets; otherwise
                // offline generation fencing can legitimately discard its pending in-memory update.
                await page.waitForTimeout(1000);
                await context.setOffline(true);
                await page.waitForTimeout(1000);
                if (cancelVia === 'button') await page.locator('.edit-cancel').click();
                else if (cancelVia === 'Escape') await page.locator('.edit-input').press('Escape');
                else await action('Edited target', 'Edit');
                await row(accepted).waitFor({ timeout: 3000 });
                if (cancelVia === 'another editor') await page.locator('.edit-cancel').click();
                await context.setOffline(false);
                await action(accepted, 'Edit');
                await page.locator('.edit-input').fill('Edit cancellation target');
                await page.locator('.edit-save').click();
                await page.waitForFunction(
                    async () =>
                        (await (await import('/chat-client/storage.js')).outbox()).length === 0,
                );
            }
            console.log(
                'PASS cancelling an active edit displays the latest accepted sibling edit (button, Escape and another editor)',
            );
            await page.evaluate(() => navigator.serviceWorker.ready);
            await context.setOffline(true);
            await action('Edited target', 'Edit');
            await page.locator('.edit-input').fill('Offline edited');
            await page.locator('.edit-save').click();
            await row('Offline edited').waitFor();
            await action('Offline edited', '👍');
            await row('Offline edited').locator('.reaction-pill').waitFor();
            await action('Offline edited', 'Reply');
            await draft.fill('Offline reply draft');
            await page.waitForFunction(async () => {
                const s = await import('/chat-client/storage.js'),
                    a = await s.readState(),
                    c = a.snapshot.conversations.find((c) => c.path === location.pathname);
                return (
                    (await s.draft(c.id)) === 'Offline reply draft' && !!(await s.replyDraft(c.id))
                );
            });
            await page.reload();
            await row('Offline edited').waitFor();
            assert.equal(await draft.inputValue(), 'Offline reply draft');
            await page.locator('.reply-bar:not([hidden])').waitFor();
            await send('Offline reply');
            await page.locator('#pending .reply-preview').waitFor();
            await send('Unsent change');
            await action('Unsent change', 'Edit');
            await page.locator('.edit-input').fill('Unsent corrected');
            await page.locator('.edit-save').click();
            await row('Unsent corrected').waitFor();
            await action('Unsent corrected', 'More');
            await page.getByRole('button', { name: 'Delete Message', exact: true }).click();
            await page.locator('.confirm-delete').click();
            await page.waitForFunction(
                () => !document.querySelector('#pending')?.textContent.includes('Unsent corrected'),
            );
            await context.setOffline(false);
            await page.waitForFunction(
                () => document.querySelectorAll('#pending [data-operation]').length === 0,
            );
            await row('Offline reply').locator('.reply-preview').waitFor();
            await row('Offline edited').locator('.reaction-pill').waitFor();
            assert.equal(
                await page.evaluate(
                    async () => (await (await import('/chat-client/storage.js')).outbox()).length,
                ),
                0,
            );
            console.log(
                'PASS offline edit/reaction/reply draft survive reload; unsent edit/cancel and reconnect reconcile',
            );
            await draft.fill('😀');
            await page.locator('#send').click();
            const emojiRow = page
                .locator('#timeline .message-group')
                .filter({ has: page.locator('.message-content img[alt="😀"]') })
                .last();
            await emojiRow.waitFor();
            await emojiRow.hover();
            await emojiRow.getByTitle('Edit', { exact: true }).click();
            await page.locator('.edit-input').fill('😀 updated');
            await page.locator('.edit-save').click();
            await page.waitForFunction(() =>
                [...document.querySelectorAll('#timeline .message-content img[alt="😀"]')].some(
                    (img) =>
                        img.complete &&
                        img.naturalWidth > 0 &&
                        img.parentElement.textContent.includes('updated'),
                ),
            );
            console.log(
                'PASS shared emoji artwork remains valid after replacing an edited message row',
            );
            await page.setViewportSize({ width: 390, height: 844 });
            await row('Offline edited').click();
            await row('Offline edited').getByTitle('More', { exact: true }).click();
            await page.getByRole('button', { name: 'Delete Message', exact: true }).click();
            await page.screenshot({ path: output + '/delete-mobile.png' });
            await page.locator('.confirm-delete').click();
            await page.waitForFunction(
                () =>
                    ![...document.querySelectorAll('.message-content')].some(
                        (n) => n.textContent === 'Offline edited',
                    ),
            );
            console.log('PASS phone-sized action menu and delete confirmation');
        }
        assert.deepEqual(errors, []);
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
