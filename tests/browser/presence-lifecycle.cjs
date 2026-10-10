const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
const url = new URL(origin);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port === '7543')
    throw new Error('Disposable local test origin required');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(25);
    }
    throw new Error('Timed out waiting for presence lifecycle');
}
(async () => {
    const browser = await chromium.launch();
    try {
        const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
        const names = ['observer', 'closing'].map((name) => name + Date.now().toString(36));
        const pages = await Promise.all(contexts.map((context) => context.newPage()));
        const ready = (page) =>
            page.locator('[data-status="online"]:not([disabled])').waitFor({ state: 'attached' });
        for (let i = 0; i < pages.length; i++) {
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await ready(pages[i]);
        }
        const [observer, closing] = pages;
        const row = observer.locator(`#dms [data-username="${names[1]}"]`);
        await row.locator('.user-status-dot.online').waitFor();
        const sibling = await contexts[1].newPage();
        await sibling.goto(origin + '/lobby');
        await ready(sibling);
        await sibling.close({ runBeforeUnload: true });
        await delay(300);
        assert.equal(await row.locator('.user-status-dot.online').count(), 1);
        console.log('PASS closing a sibling preserves the remaining tab presence');

        // Real pagehide during navigation; the observer must receive removal without waiting
        // for the socket-loss grace. A return may use bfcache or a fresh document.
        let started = Date.now();
        await closing.goto('about:blank');
        await until(async () => (await row.count()) === 0, 1000);
        assert(Date.now() - started < 1000);
        console.log('PASS document departure removes presence within one second');
        await closing.goBack();
        await ready(closing);
        await row.locator('.user-status-dot.online').waitFor();
        console.log('PASS browser Back rejoins presence');

        // Deterministic persisted pageshow coverage even when this browser declines bfcache
        // for a WebSocket document. Physical OS suspension remains a device check.
        // Browsers can tear down the socket before delivering pagehide. The saved connection
        // ID must still remove retained presence when the later leave request arrives.
        await closing.evaluate(() => window.dispatchEvent(new Event('offline')));
        await delay(150);
        await closing.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
        );
        await until(async () => (await row.count()) === 0, 1000);
        await closing.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
        );
        await ready(closing);
        await row.locator('.user-status-dot.online').waitFor();
        console.log(
            'PASS socket teardown before pagehide still closes presence; persisted restoration rejoins',
        );

        started = Date.now();
        await closing.close({ runBeforeUnload: true });
        await until(async () => (await row.count()) === 0, 1000);
        assert(Date.now() - started < 1000);
        console.log('PASS closing the last chat tab removes presence within one second');

        const dropped = await contexts[1].newPage();
        await dropped.goto(origin + '/lobby');
        await ready(dropped);
        await row.locator('.user-status-dot.online').waitFor();
        const disconnectedAt = Date.now();
        await contexts[1].setOffline(true);
        await delay(250);
        assert.equal(await row.locator('.user-status-dot.online').count(), 1);
        await until(async () => (await row.locator('.user-status-dot.away').count()) === 1, 70000);
        // A real network cut can first wait for SignalR's transport timeout. The grace
        // starts when the server observes disconnect, not at the browser's offline toggle.
        assert(Date.now() - disconnectedAt >= 29000);
        await contexts[1].setOffline(false);
        await ready(dropped);
        await dropped.mouse.move(400, 400);
        await row.locator('.user-status-dot.online').waitFor();
        console.log(
            'PASS an unannounced network drop becomes Away after detection/grace and restores on resumed activity',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
