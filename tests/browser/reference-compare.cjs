// Matched synthetic DM fixtures, separate reference/development browser contexts and databases.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const reference = process.env.YAP_REFERENCE_ORIGIN || 'https://localhost:7443';
const development = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
for (const origin of [reference, development])
    if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
        throw new Error('Local test origins required');
const output = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-phase2-compare';
fs.mkdirSync(output, { recursive: true });
const suffix = Date.now().toString(36),
    names = ['cmpa' + suffix, 'cmpb' + suffix];
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        for (const [label, origin] of [
            ['reference', reference],
            ['rewrite', development],
        ]) {
            const contexts = await Promise.all(
                names.map(() =>
                    browser.newContext({
                        ignoreHTTPSErrors: true,
                        viewport: { width: 1440, height: 1000 },
                    }),
                ),
            );
            const pages = await Promise.all(contexts.map((c) => c.newPage()));
            for (let i = 0; i < pages.length; i++) {
                await pages[i].goto(origin + '/login');
                await pages[i].locator('.username-input').fill(names[i]);
                await pages[i].locator('.join-button').click();
                await pages[i].waitForURL('**/lobby');
            }
            const page = pages[0];
            await page.goto(origin + '/dm/' + names[1]);
            const composer = page.locator(label === 'reference' ? '.message-input' : '#draft');
            await composer.waitFor();
            for (const text of [
                'A shared comparison fixture.',
                'Two lines stay together.\nThe composer should keep its familiar appearance.',
                'A longer message checks wrapping, spacing, and grouping at desktop and phone widths.',
            ]) {
                await composer.fill(text);
                await page.locator('.send-button').click();
                await page
                    .locator('.message-group .message-content')
                    .filter({ hasText: text })
                    .first()
                    .waitFor();
            }
            if (label === 'rewrite')
                await page.waitForFunction(
                    () => document.querySelectorAll('#pending [data-operation]').length === 0,
                );
            await page.screenshot({
                path: output + '/' + label + '-desktop.png',
                animations: 'disabled',
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({
                path: output + '/' + label + '-mobile.png',
                animations: 'disabled',
            });
            for (const context of contexts) await context.close();
            console.log(
                'PASS ' + label + ': matching usernames, text, theme default and viewport fixtures',
            );
        }
        console.log('Chromium ' + browser.version() + '; screenshots ' + output);
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
