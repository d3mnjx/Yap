// Loopback is a trustworthy browser context without TLS. No certificate bypass flags.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).protocol !== 'http:'
)
    throw new Error('Local HTTP test origin required');
(async () => {
    const browser = await chromium.launch();
    try {
        for (const blocked of [false, true]) {
            const context = await browser.newContext();
            const errors = [];
            if (blocked)
                await context.addInitScript(() => {
                    ServiceWorkerContainer.prototype.register = async () => {
                        throw new DOMException('Test certificate rejection', 'SecurityError');
                    };
                });
            const page = await context.newPage();
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(origin + '/login');
            await page
                .locator('.username-input')
                .fill('http' + (blocked ? 'b' : 'a') + Date.now().toString(36));
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.goto(origin + '/lobby');
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            assert.equal(await page.evaluate(() => isSecureContext), true);
            await page.locator('#draft').fill('local HTTP draft');
            await page.waitForFunction(async () => {
                const store = await import('/chat-client/storage.js');
                const { snapshot } = await store.readState();
                const channel = snapshot.conversations.find((c) => c.path === location.pathname);
                return (
                    channel &&
                    (await store.draft(channel.id)) === document.querySelector('#draft').value
                );
            });
            if (blocked) {
                assert(
                    (await page.locator('#connection').innerText()).includes(
                        'offline reload unavailable',
                    ),
                );
                assert((await page.locator('#notice').innerText()).includes('trusted connection'));
                assert.equal((await page.locator('#rooms a').count()) > 0, true);
                console.log(
                    'PASS worker rejection preserves authenticated chat, drafts and a visible offline limitation',
                );
            } else {
                await page.evaluate(() => navigator.serviceWorker.ready);
                await context.setOffline(true);
                await page.reload();
                await page.locator('#rooms a').first().waitFor();
                // Rooms paint before the asynchronous draft restore finishes.
                await page.locator('#draft:enabled').waitFor();
                assert.equal(await page.locator('#draft').inputValue(), 'local HTTP draft');
                assert(
                    await page
                        .locator('link[href="/chat-client/chat.css"]')
                        .evaluate((node) => !!node.sheet),
                );
                // Retired prototype entry must not receive the offline chat shell.
                for (const path of ['/next', '/next/']) {
                    const retired = await context.newPage();
                    await assert.rejects(
                        retired.goto(origin + path),
                        /net::ERR_INTERNET_DISCONNECTED/,
                    );
                    // Navigation rejects before Chromium finishes its error document.
                    await retired.waitForLoadState('load');
                    await retired.close();
                }
                console.log(
                    'PASS canonical stylesheet loads offline; retired prototype entry has no worker fallback',
                );
                console.log(
                    'PASS loopback HTTP login, worker registration, offline reload and draft without certificate bypass',
                );
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
