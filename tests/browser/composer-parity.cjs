// Compare final original geometry, not a second copy of CSS constants.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const out = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-composer-parity';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        const measurements = {};
        for (const [label, origin] of [
            ['reference', 'https://localhost:7443'],
            ['rewrite', 'http://127.0.0.1:7643'],
        ]) {
            const context = await browser.newContext({ ignoreHTTPSErrors: true }),
                page = await context.newPage(),
                errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill('composer' + Date.now().toString(36));
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.locator('.message-input:enabled').waitFor();
            const result = {};
            for (const width of [1440, 768, 600, 390])
                for (const font of [16, 20]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.evaluate(
                        (font) => (document.documentElement.style.fontSize = font + 'px'),
                        font,
                    );
                    for (const [state, value] of [
                        ['empty', ''],
                        ['text', 'Some text'],
                        ['lines', 'First line\nSecond line\nThird line'],
                        ['long', Array(18).fill('Wrapping input').join('\n')],
                    ]) {
                        await page.locator('.message-input').fill(value);
                        await page.waitForTimeout(250);
                        result[`${width}-${font}-${state}`] = await page.evaluate(() => {
                            const root = document
                                    .querySelector('.message-input-container')
                                    .getBoundingClientRect(),
                                r = {};
                            for (const selector of [
                                '.input-box',
                                '.image-upload-button',
                                '.message-input',
                                '.gif-toggle-button',
                                '.emoji-toggle-button',
                                '.send-button',
                            ]) {
                                const n = document.querySelector(selector),
                                    b = n.getBoundingClientRect(),
                                    css = getComputedStyle(n);
                                r[selector] = {
                                    x: b.x - root.x,
                                    bottom: root.bottom - b.bottom,
                                    width: b.width,
                                    height: b.height,
                                    display: css.display,
                                    font: css.fontSize,
                                    padding: css.padding,
                                };
                            }
                            return r;
                        });
                        if (font === 16 && (state === 'empty' || state === 'lines'))
                            await page
                                .locator('.message-input-container')
                                .screenshot({ path: `${out}/${label}-${width}-${state}.png` });
                    }
                }
            assert.deepEqual(errors, []);
            measurements[label] = result;
            await context.close();
        }
        fs.writeFileSync(out + '/geometry.json', JSON.stringify(measurements, null, 2));
        const mismatches = [];
        for (const [state, controls] of Object.entries(measurements.reference))
            for (const [selector, want] of Object.entries(controls)) {
                const got = measurements.rewrite[state][selector];
                for (const key of ['x', 'bottom', 'width', 'height'])
                    if (Math.abs(want[key] - got[key]) > 1)
                        mismatches.push(
                            `${state} ${selector} ${key}: ${got[key]} expected ${want[key]}`,
                        );
                for (const key of ['display', 'font', 'padding'])
                    if (want[key] !== got[key])
                        mismatches.push(
                            `${state} ${selector} ${key}: ${got[key]} expected ${want[key]}`,
                        );
            }
        assert.deepEqual(mismatches, []);
        console.log(
            'PASS original/rewrite composer geometry: 1440/768/600/390 widths, 16/20px, empty/text/multiline/200px cap; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
