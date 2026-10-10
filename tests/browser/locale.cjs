const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { poll } = require('./support/wait.cjs');
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
            await poll(
                page,
                async () => !(await (await fetch('/api/chat/session')).json()).needsLocaleDetection,
            );
            const actual = await page.evaluate(async () => {
                const s = await (async () => {
                    const { update } = await (await fetch('/api/chat/bootstrap')).json();
                    const { mergeUpdate } = await import('/chat-client/sync.js');
                    let state = mergeUpdate(null, update);
                    for (const c of update.conversations)
                        state = mergeUpdate(
                            state,
                            await (await fetch('/api/chat/windows/' + c.id)).json(),
                        );
                    return state;
                })();
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
            // A fresh Settings circuit must preserve locale when saving either clock or date order.
            await page.goto(origin + '/settings');
            const before = await page.evaluate(
                async () =>
                    (await (await fetch('/api/chat/bootstrap')).json()).update.state.dateSettings,
            );
            await page.locator('label:has(input[name="clock"]:not(:checked))').first().click();
            await poll(
                page,
                async (old) =>
                    (await (await fetch('/api/chat/bootstrap')).json()).update.state.dateSettings
                        .time !== old.time,
                before,
            );
            await page.locator('label:has(input[name="dateOrder"]:not(:checked))').first().click();
            await poll(
                page,
                async (old) =>
                    (await (await fetch('/api/chat/bootstrap')).json()).update.state.dateSettings
                        .fullDate !== old.fullDate,
                before,
            );
            await poll(
                page,
                async () => !(await (await fetch('/api/chat/session')).json()).needsLocaleDetection,
            );
            await page.reload();
            await page.locator('input[name="clock"]').first().waitFor({ state: 'attached' });
            assert(
                (await page.locator('.form-hint').allTextContents()).some((text) =>
                    text.includes(locale),
                ),
            );
            await context.close();
        }
        const stalled = await browser.newContext({ serviceWorkers: 'block' });
        const page = await stalled.newPage();
        // Hold detection indefinitely, including its timeout signal, to prove it is
        // independent of startup and delivery rather than merely timing out first.
        await stalled.addInitScript(() => {
            const fetch = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (String(url).includes('/preferences/detect')) {
                    window.localeDetectionStarted = true;
                    return new Promise(() => {});
                }
                return fetch(url, options);
            };
        });
        try {
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill('slowlocale' + Date.now().toString(36));
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.locator('#draft:not([disabled])').waitFor();
            await page.locator('#draft').fill('send while locale detection is held');
            await page.locator('#send').click();
            await page
                .locator('#timeline .message-content')
                .filter({ hasText: 'send while locale detection is held' })
                .waitFor();
            assert(await page.evaluate(() => window.localeDetectionStarted));
            console.log('PASS held locale detection does not prevent the first durable send');
        } finally {
            await stalled.close();
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
