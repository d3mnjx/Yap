// Diagnostics with writes held open: UI feedback must not wait for a server response.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Disposable local fixture required');
(async () => {
    const browser = await chromium.launch();
    let release;
    const barrier = new Promise((r) => {
        release = r;
    });
    const results = {};
    try {
        const context = await browser.newContext(),
            page = await context.newPage();
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('locality' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.waitForFunction(
            async () => !!(await (await import('/chat-client/storage.js')).metadata('catalog')),
        );
        const response = page.waitForResponse(
            (r) => r.url().endsWith('/messages') && r.request().method() === 'POST',
        );
        await page.locator('#draft').fill('Local interaction target');
        await page.locator('#send').click();
        const id = (await (await response).json()).messageId;
        await page.locator('#msg-' + id).waitFor();
        await context.route('**/api/chat/**', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            await barrier;
            await route.abort();
        });
        // Time inside the page; include two animation frames so DOM-only changes count as paintable.
        async function measure(action, condition) {
            return page.evaluate(
                async ({ action, condition, id }) => {
                    const check = new Function('id', 'return (' + condition + ')');
                    const start = performance.now();
                    new Function('id', action)(id);
                    const handlerMs = performance.now() - start;
                    const deadline = start + 2000;
                    while (!check(id) && performance.now() < deadline)
                        await new Promise((r) => setTimeout(r, 5));
                    const updated = !!check(id);
                    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                    return { updated, handlerMs, ms: performance.now() - start };
                },
                { action, condition, id },
            );
        }
        results.reaction = await measure(
            "document.querySelector('#msg-'+id+' .action-btn[title=\"❤️\"]').click()",
            "document.querySelector('#msg-'+id+' .reaction-pill')?.textContent.includes('1')",
        );
        results.openEditor = await measure(
            "document.querySelector('#msg-'+id+' .action-edit').click()",
            "!!document.querySelector('.edit-input')",
        );
        await page.locator('.edit-input').fill('Edited while all writes are blocked');
        results.saveEdit = await measure(
            "document.querySelector('.edit-save').click()",
            "!document.querySelector('.edit-input') && document.querySelector('#msg-'+id)?.textContent.includes('Edited while all writes are blocked')",
        );
        results.firstEmojiOpen = await measure(
            "document.querySelector('#emoji-button').click()",
            "!!document.querySelector('.message-input-container[data-picker] .emoji-btn')",
        );
        await page.keyboard.press('Escape');
        results.emojiReopen = await measure(
            "document.querySelector('#emoji-button').click()",
            "!!document.querySelector('.message-input-container[data-picker] .emoji-btn')",
        );
        results.emojiInsert = await measure(
            "document.querySelector('.emoji-picker .emoji-btn').click()",
            "document.querySelector('#draft').value.length > 0",
        );
        await page.keyboard.press('Escape');
        await page.locator('#draft').fill('Queued behind blocked reaction');
        results.send = await measure(
            "document.querySelector('#send').click()",
            "document.querySelector('#pending')?.textContent.includes('Queued behind blocked reaction')",
        );
        await page.evaluate(() => document.querySelector('#pending .action-edit').click());
        await page.locator('.edit-input').fill('Pending edit should also be local');
        results.editNeverAttemptedMessage = await measure(
            "document.querySelector('.edit-save').click()",
            "!document.querySelector('.edit-input') && document.querySelector('#pending')?.textContent.includes('Pending edit should also be local')",
        );
        for (const [name, result] of Object.entries(results)) {
            console.log(result.updated ? 'PASS' : 'FINDING', name, Math.round(result.ms) + 'ms');
            if (name !== 'editNeverAttemptedMessage')
                assert(result.updated, name + ' waited for blocked server traffic');
        }
        if (process.env.YAP_LOCALITY_OUTPUT)
            fs.writeFileSync(process.env.YAP_LOCALITY_OUTPUT, JSON.stringify(results, null, 2));
        release();
        await context.close();
    } finally {
        release();
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
