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
        for (const [locale, timezoneId, expected] of [
            ['en-US', 'America/New_York', '8:03 AM'],
            ['cs-CZ', 'Europe/Prague', '14:03'],
        ]) {
            const context = await browser.newContext({
                locale,
                timezoneId,
                serviceWorkers: 'block',
            });
            const page = await context.newPage();
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill('locale' + Date.now().toString(36));
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            const actual = await page.evaluate(async () => {
                const s = await (await fetch('/api/chat/sync')).json();
                const { timestamp } = await import('/chat-client/dates.js');
                return {
                    zone: s.timeZone,
                    time: timestamp(
                        '2026-07-01T12:03:00Z',
                        s.dateSettings,
                        Date.parse('2026-07-01T13:00:00Z'),
                    ),
                };
            });
            assert.deepEqual(actual, { zone: timezoneId, time: expected });
            await page.reload();
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            assert.equal(
                await page.evaluate(
                    async () =>
                        (await (await fetch('/api/chat/session')).json()).needsLocaleDetection,
                ),
                false,
            );
            await context.close();
        }
        console.log(
            'PASS browser timezone/locale detection, US/Czech clock formats and persisted reload',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
