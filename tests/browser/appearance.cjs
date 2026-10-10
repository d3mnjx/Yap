const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Disposable fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('appearance' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.locator('#draft:not([disabled])').waitFor();
        await page.goto(origin + '/settings');
        await page.getByRole('button', { name: 'Nord', exact: true }).click();
        await page.locator('.font-size-option').filter({ hasText: '20px' }).click();
        await page.waitForFunction(
            () => JSON.parse(localStorage.getItem('yap-appearance')).fontSize === 20,
        );
        // Deliberately prevent the app from running: appearance must precede it.
        await context.route('**/chat-client/app.js', (r) => r.abort());
        for (const path of ['/lobby', '/', '/chat-client/index.html']) {
            await page.goto(origin + path);
            assert.deepEqual(
                await page.evaluate(() => [
                    document.documentElement.dataset.theme,
                    getComputedStyle(document.documentElement).fontSize,
                ]),
                ['nord', '20px'],
            );
            assert(await page.evaluate(() => !!document.documentElement.dataset.scene));
        }
        await context.unroute('**/chat-client/app.js');
        // Observe every paintable frame through stale cached state and bootstrap.
        await page.addInitScript(() => {
            window.appearanceFrames = [];
            function sample() {
                if (document.body)
                    window.appearanceFrames.push([
                        document.documentElement.dataset.theme,
                        document.documentElement.style.fontSize,
                    ]);
                requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        });
        await page.goto(origin + '/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        const frames = await page.evaluate(() => window.appearanceFrames);
        assert(frames.length > 0);
        assert(
            frames.every(([theme, size]) => theme === 'nord' && size === '20px'),
            JSON.stringify(frames),
        );
        console.log(
            'PASS appearance before module startup, online root/routes, neutral cached shell and stale snapshot return',
        );
        await context.close();
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
