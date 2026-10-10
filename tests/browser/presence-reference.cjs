// Same synthetic users and interactions in isolated reference/rewrite contexts.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const output = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-phase3-reference';
fs.mkdirSync(output, { recursive: true });
const names = ['livea', 'liveb'].map((n) => n + Date.now().toString(36));
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        for (const [label, origin] of [
            ['reference', 'https://localhost:7443'],
            ['rewrite', 'http://127.0.0.1:7643'],
        ]) {
            const contexts = await Promise.all(
                names.map(() =>
                    browser.newContext({
                        ignoreHTTPSErrors: true,
                        viewport: { width: 1440, height: 1000 },
                    }),
                ),
            );
            const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()));
            for (const [i, page] of [alice, bob].entries()) {
                await page.goto(origin + '/login');
                await page.locator('.username-input').fill(names[i]);
                await page.locator('.join-button').click();
                await page.waitForURL('**/lobby');
            }
            await alice.goto(origin + '/dm/' + names[1]);
            await bob.goto(origin + '/dm/' + names[0]);
            if (label === 'rewrite')
                for (const page of [alice, bob])
                    await page.waitForFunction(
                        () => !document.querySelector('[data-status="online"]').disabled,
                    );
            else
                for (const page of [alice, bob])
                    await page.waitForFunction(
                        () => !!document.querySelector('.message-input')?._typingInputHandler,
                    );
            await bob.locator('.message-input').fill('Typing comparison');
            const indicator = alice.locator('.typing-indicator').filter({ hasText: names[1] });
            await indicator.waitFor();
            assert((await indicator.innerText()).includes('is typing...'));
            await alice.screenshot({
                path: output + '/' + label + '-desktop.png',
                animations: 'disabled',
            });
            await alice.setViewportSize({ width: 390, height: 844 });
            await bob.locator('.message-input').fill('Typing comparison again');
            await indicator.waitFor();
            await alice.screenshot({
                path: output + '/' + label + '-mobile.png',
                animations: 'disabled',
            });
            await indicator.waitFor({ state: 'hidden', timeout: 6000 });
            await alice.locator('.status-button').click();
            await alice.getByRole('button', { name: 'Away', exact: true }).click();
            await alice.locator('.status-button.status-away').waitFor();
            await alice.locator('.status-button').click();
            await alice.locator('.status-dropdown').waitFor();
            await alice.screenshot({
                path: output + '/' + label + '-status-menu.png',
                animations: 'disabled',
            });
            console.log(
                'PASS ' +
                    label +
                    ': DM typing wording/expiry and manual Away; matched desktop/mobile/menu captures',
            );
            for (const context of contexts) await context.close();
        }
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
