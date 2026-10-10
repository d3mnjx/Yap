const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { poll } = require('./support/wait.cjs');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw Error('Isolated local fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 15) YapDesignFixture',
        });
        const page = await context.newPage();
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('design' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.locator('#draft').fill('Retain this draft across a hub upgrade');
        await poll(page, async () => {
            const store = await import('/chat-client/storage.js');
            const state = await store.readState();
            return (
                (await store.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                document.querySelector('#draft').value
            );
        });
        await context.route('**/hubs/chat/negotiate?**', (route) => {
            const url = new URL(route.request().url());
            url.searchParams.set('protocol', '1');
            return route.continue({ url: url.href });
        });
        await page.reload();
        await page
            .locator('#notice')
            .getByRole('button', { name: 'Reload', exact: true })
            .waitFor();
        assert.equal(
            await page.locator('#draft').inputValue(),
            'Retain this draft across a hub upgrade',
        );
        console.log('PASS mismatched hub negotiation shows Reload and preserves the draft');
        await context.unroute('**/hubs/chat/negotiate?**');
        await page.goto(origin + '/');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(
            await page.locator('#draft').inputValue(),
            'Retain this draft across a hub upgrade',
        );
        console.log(
            'PASS authenticated root loads chat through the mapped endpoint with retained local work',
        );
        const renewal = (await context.cookies()).find(
            (cookie) => cookie.name === 'yap_auth_renewed',
        );
        assert(renewal);
        await context.addCookies([{ ...renewal, value: 'legacy-renewal-fixture' }]);
        const renewed = page.waitForResponse((response) =>
            response.url().endsWith('/api/chat/session'),
        );
        const settings = await page.goto(origin + '/settings');
        assert(!((await settings.allHeaders())['set-cookie'] || '').includes('yap_auth='));
        assert.equal((await renewed).status(), 200);
        // Worker-mediated responses hide Set-Cookie from page-facing response headers;
        // verify the HTTP-only jar instead (server contracts inspect raw headers).
        const deadline = Date.now() + 5000;
        while (
            (await context.cookies()).find((cookie) => cookie.name === 'yap_auth_renewed')
                ?.value === 'legacy-renewal-fixture'
        ) {
            if (Date.now() > deadline) throw Error('Settings did not renew its legacy cookie');
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const resumed = page.waitForResponse((response) =>
            response.url().endsWith('/api/chat/session'),
        );
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        assert.equal((await resumed).status(), 200);
        console.log(
            'PASS retained Settings renews through Session while its HTML response writes no auth cookie',
        );
        await page.evaluate(() => {
            window.installRequests = 0;
            const event = new Event('beforeinstallprompt');
            event.prompt = async () => window.installRequests++;
            event.userChoice = Promise.resolve({ outcome: 'dismissed' });
            window.dispatchEvent(event);
            window.showPwaInstallGuide();
        });
        await page.getByRole('button', { name: 'Use existing app', exact: true }).click();
        assert.equal(await page.evaluate(() => installRequests), 0);
        await page.evaluate(() => {
            window.showPwaInstallGuide();
        });
        await page.getByRole('button', { name: 'Install app', exact: true }).click();
        assert.equal(await page.evaluate(() => installRequests), 1);
        console.log(
            'PASS retained install guide preserves the existing-app exit and a later native install gesture',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
