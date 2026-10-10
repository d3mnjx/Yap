const { poll } = require('./support/wait.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
            page = await context.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const username = 'actparity' + Date.now().toString(36);
        await page.goto('http://127.0.0.1:7643/login');
        await page.locator('.username-input').fill(username);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.locator('#draft').fill('Bottom action target 😀');
        await page.locator('#send').click();
        const row = page
            .locator(`#timeline .message-group[data-author="${username}"]`)
            .filter({
                has: page.locator('.message-content').filter({ hasText: 'Bottom action target' }),
            })
            .last();
        await row.waitFor();
        await poll(
            page,
            async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
        );
        const firstButtons = await row
            .locator('.action-btn')
            .evaluateAll((nodes) => nodes.slice(0, 3).map((n) => n.title));
        assert.deepEqual(firstButtons, ['❤️', '😂', '👍']);
        await row.hover();
        await row.getByTitle('More', { exact: true }).click();
        const del = page.getByRole('button', { name: 'Delete Message', exact: true });
        await del.waitFor();
        assert(
            await del.evaluate((n) => {
                const b = n.getBoundingClientRect(),
                    limit = document.querySelector('.messages').getBoundingClientRect().bottom;
                return (
                    b.bottom <= limit &&
                    n.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2))
                );
            }),
        );
        await page.keyboard.press('Escape');
        let writes = 0;
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().endsWith('/actions')) writes++;
        });
        await row.hover();
        await row.getByTitle('Edit', { exact: true }).click();
        const edit = page.locator('.edit-input');
        assert.equal(
            await edit.evaluate((n) => n.selectionStart),
            (await edit.inputValue()).length,
        );
        await page.locator('.edit-save').click();
        await edit.waitFor({ state: 'detached' });
        assert.equal(writes, 0);
        await row.hover();
        await row.getByTitle('Edit', { exact: true }).click();
        await edit.fill(Array(30).fill('a wrapped line').join('\n'));
        await edit.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
        await edit.waitFor();
        assert.equal(writes, 0);
        assert((await edit.boundingBox()).height <= 200);
        await page.locator('.edit-cancel').click();
        await row.hover();
        await row.getByTitle('Reply', { exact: true }).click();
        await page.locator('#draft').fill('Reply preview body');
        await page.locator('#send').click();
        const response = page
            .locator(`#timeline .message-group[data-author="${username}"]`)
            .filter({
                has: page.locator('.message-content').filter({ hasText: 'Reply preview body' }),
            })
            .last();
        await response.locator('.reply-preview .avatar').waitFor();
        await response.locator('.reply-preview .reply-text img[alt="😀"]').waitFor();
        await row.hover();
        await row.getByTitle('Edit', { exact: true }).click();
        await edit.fill('Bottom action target updated');
        await page.locator('.edit-save').click();
        await page.waitForFunction(() =>
            [...document.querySelectorAll('.reply-preview .reply-text')].some(
                (n) => n.textContent === 'Bottom action target updated',
            ),
        );
        await row.hover();
        await row.getByTitle('👍', { exact: true }).click();
        await row.locator('.reaction-pill').waitFor();
        await page.locator('#emoji-button').click();
        await page
            .locator('.emoji-section[data-section="recent"] .emoji-btn[data-emoji="👍"]')
            .waitFor();
        await page.keyboard.press('Escape');
        console.log(
            'PASS popup list containment/hit testing, default reaction order/shared recents, no-op edit/IME/caret/autogrow and live rich reply preview',
        );
        const touch = await browser.newContext({
                storageState: await context.storageState(),
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true,
            }),
            phone = await touch.newPage();
        phone.on('pageerror', (e) => errors.push(e.message));
        await phone.goto('http://127.0.0.1:7643/lobby');
        await phone.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        const last = phone
            .locator(`#timeline .message-group[data-author="${username}"]`)
            .filter({
                has: phone.locator('.message-content').filter({ hasText: 'Reply preview body' }),
            })
            .last();
        await last.locator('.message-content').tap();
        assert(await last.evaluate((n) => n.classList.contains('touch-actions')));
        await phone.waitForTimeout(5200);
        await phone.waitForFunction(
            () =>
                document.querySelector('.messages').classList.contains('scroll-dismissing') &&
                [...document.querySelectorAll('.message-actions')].every(
                    (n) => getComputedStyle(n).opacity === '0',
                ),
        );
        await last.locator('.message-content').tap();
        await last.getByTitle('Edit', { exact: true }).tap();
        assert.equal(
            await phone.locator('.edit-input').evaluate((n) => n === document.activeElement),
            false,
        );
        await phone.locator('.edit-input').tap();
        await phone.locator('.edit-input').press('Enter');
        assert((await phone.locator('.edit-input').inputValue()).includes('\n'));
        await phone.locator('.edit-cancel').tap();
        await last.locator('.message-content').tap();
        await last.getByTitle('More', { exact: true }).tap();
        const mobileDelete = phone.getByRole('button', { name: 'Delete Message', exact: true });
        assert(
            await mobileDelete.evaluate((n) => {
                const b = n.getBoundingClientRect();
                return n.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
            }),
        );
        await mobileDelete.tap();
        await phone.keyboard.press('Escape');
        await phone.locator('.delete-confirm-overlay').waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
        console.log(
            'PASS actual touch context idle expiry/reopen, edit keyboard policy/newline and mobile sheet/delete Escape; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
