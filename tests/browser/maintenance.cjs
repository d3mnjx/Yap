const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { poll } = require('./support/wait.cjs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:8062';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw Error('Disposable fixture only');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('limits' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        const bootstrap = await (await context.request.get(origin + '/api/chat/bootstrap')).json();
        const header = bootstrap.update.state;
        assert.equal(header.maxTextLength, 37, 'Start fixture with OfflineChat:MaxTextLength=37');
        assert.equal(await page.locator('#draft').getAttribute('maxlength'), '37');
        await page.locator('#draft').fill('Configured editor limit');
        await page.locator('#send').click();
        const row = page
            .locator('#timeline .message-group')
            .filter({ hasText: 'Configured editor limit' });
        await row.waitFor();
        await row.hover();
        await row.getByTitle('Edit', { exact: true }).click();
        assert.equal(await page.locator('.edit-input').getAttribute('maxlength'), '37');
        await page.keyboard.press('Escape');
        await page.locator('#draft').fill('Saved before protocol rejection');
        await poll(page, async () => {
            const storage = await import('/chat-client/storage.js');
            const state = await storage.readState();
            return (
                (await storage.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                'Saved before protocol rejection'
            );
        });
        await context.route('**/api/chat/bootstrap**', (route) =>
            route.fulfill({
                status: 426,
                contentType: 'application/json',
                body: JSON.stringify({ code: 'update_required', error: 'Client update required.' }),
            }),
        );
        await page.reload();
        await page.getByRole('button', { name: 'Reload', exact: true }).waitFor();
        assert.equal(await page.locator('#connection').textContent(), 'Update required');
        assert(
            await page.evaluate(async () => {
                const storage = await import('/chat-client/storage.js');
                const state = await storage.readState();
                return (
                    !state.locked &&
                    (await storage.draft(
                        state.snapshot.conversations.find((c) => c.isDefault).id,
                    )) === 'Saved before protocol rejection'
                );
            }),
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS configured composer/edit limits and protocol-426 reload notice with retained draft',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
