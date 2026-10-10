const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { poll } = require('./support/wait.cjs');
const origin = process.env.YAP_TEST_ORIGIN;
if (
    !origin ||
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw Error('Disposable fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('final' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        let release, started;
        const hold = new Promise((resolve) => (release = resolve));
        const requested = new Promise((resolve) => (started = resolve));
        await context.route('**/api/chat/conversations/*/messages', async (route) => {
            if (route.request().method() === 'POST') {
                started();
                await hold;
            }
            await route.continue();
        });
        await page.locator('#draft').fill('Pending editor acceptance');
        await page.locator('#send').click();
        await requested;
        const pending = page
            .locator('#pending .message-group')
            .filter({ hasText: 'Pending editor acceptance' });
        await pending.hover();
        await pending.getByTitle('Edit', { exact: true }).click();
        const input = page.locator('.edit-input');
        await input.fill('Editor survives acknowledgement');
        await input.evaluate((node) => {
            window.retainedEditor = node;
            node.setSelectionRange(6, 11);
        });
        release();
        await page.locator('#timeline .edit-input').waitFor();
        assert(
            await input.evaluate(
                (node) => node === window.retainedEditor && node === document.activeElement,
            ),
        );
        assert.equal(await input.inputValue(), 'Editor survives acknowledgement');
        assert.deepEqual(
            await input.evaluate((node) => [node.selectionStart, node.selectionEnd]),
            [6, 11],
        );
        await page.locator('.edit-save').click();
        await page
            .locator('#timeline .message-text')
            .filter({ hasText: 'Editor survives acknowledgement' })
            .waitFor();
        await poll(
            page,
            async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS pending inline edit retains its node, text and caret across acceptance and saves to the accepted message',
        );
        await context.close();

        const failed = await browser.newContext();
        await failed.route('**/chat-client/manifest.json', (route) => route.abort('timedout'));
        const first = await failed.newPage();
        await first.goto(origin + '/login');
        await first.locator('.username-input').fill('download' + Date.now().toString(36));
        await first.locator('.join-button').click();
        await first.waitForURL('**/lobby');
        await first.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await first
            .getByText('Offline setup could not finish downloading.', { exact: false })
            .waitFor();
        assert(!(await first.locator('#notice').innerText()).includes('Update your browser'));
        await first.locator('#draft').fill('Draft during setup failure');
        await poll(first, async () => {
            const storage = await import('/chat-client/storage.js');
            const state = await storage.readState();
            return (
                (await storage.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                'Draft during setup failure'
            );
        });
        console.log(
            'PASS first-visit manifest timeout gives download retry guidance and preserves usable drafts',
        );
        await failed.close();
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
