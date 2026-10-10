const { poll } = require('./support/wait.cjs');
const { fixturePage } = require('./support/authority.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const out = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-emoji-parity';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        const geometry = {};
        for (const [label, origin] of [
            ['reference', 'https://localhost:7443'],
            ['rewrite', 'http://127.0.0.1:7643'],
        ]) {
            const context = await browser.newContext({
                    ignoreHTTPSErrors: true,
                    viewport: { width: 1440, height: 1000 },
                }),
                page = await fixturePage(context),
                errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill('emoji' + Date.now().toString(36));
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.locator('.message-input:enabled').waitFor();
            const toggle = page.locator('.emoji-toggle-button'),
                field = page.locator('.message-input'),
                picker = page.locator('.emoji-picker:visible'),
                search = picker.locator('.emoji-search input');
            if (label === 'rewrite')
                await page.waitForFunction(() =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced'),
                );
            await field.fill('left right');
            await field.evaluate((n) => n.setSelectionRange(5, 5));
            await toggle.click();
            await picker.waitFor();
            await search.fill(' grinning ');
            const first = picker.locator('.emoji-btn[data-emoji="😀"]:visible').first();
            await first.click();
            await first.click();
            assert.equal(await field.inputValue(), 'left 😀😀right');
            await picker.waitFor();
            assert.notEqual(
                await page.evaluate(() => document.activeElement?.className),
                'message-input',
            );
            // Insertion is local and keeps the same grid mounted, including with the server disconnected.
            if (label === 'rewrite') {
                await page.evaluate(() => navigator.serviceWorker.ready);
                await context.setOffline(true);
                await first.click();
                assert.equal(await field.inputValue(), 'left 😀😀😀right');
                await context.setOffline(false);
            }
            await field.click();
            await picker.waitFor({ state: 'hidden' });
            assert(await field.evaluate((n) => n === document.activeElement));
            await field.fill('');
            await toggle.click();
            await picker.waitFor();
            assert.equal(await search.inputValue(), '');
            await page.waitForFunction(() =>
                [...document.querySelectorAll('.emoji-picker')]
                    .filter((n) => n.offsetWidth)
                    .some((n) =>
                        n.querySelector(
                            '.emoji-section[data-section="recent"] .emoji-btn[data-emoji="😀"]',
                        ),
                    ),
            );
            await search.fill('zzzz-no-match');
            await picker.locator('.emoji-search-empty').waitFor();
            await picker.locator('.emoji-search-clear').click();
            assert.equal(await search.inputValue(), '');
            await picker.locator('[data-category="animals"]').click();
            await page.waitForTimeout(500);
            if (label === 'rewrite')
                assert(
                    await picker
                        .locator('[data-category="animals"]')
                        .evaluate((n) => n.classList.contains('active')),
                );
            else
                console.log(
                    'OBSERVED original category highlight after Animals: ' +
                        (await picker
                            .locator('.category-btn.active')
                            .getAttribute('data-category')),
                );
            geometry[label] = {};
            for (const width of [1440, 390]) {
                if (width === 390) {
                    await page.setViewportSize({ width, height: 844 });
                    await picker.waitFor({ state: 'hidden' });
                    await toggle.click();
                    await picker.waitFor();
                }
                await search.fill('');
                await picker.locator('[data-category="recent"]').click();
                await page.waitForTimeout(400);
                // Compare a common origin; original smooth category scrolling is unstable under content-visibility estimates.
                await picker.locator('.emoji-content').evaluate((n) => (n.scrollTop = 0));
                await page.waitForTimeout(100);
                geometry[label][width] = await page.evaluate(() => {
                    const root = [...document.querySelectorAll('.emoji-picker')].find(
                            (n) => n.offsetWidth,
                        ),
                        r = {};
                    for (const [key, n] of [
                        ['picker', root],
                        ['sidebar', root.querySelector('.emoji-sidebar')],
                        ['search', root.querySelector('.emoji-search')],
                        ['cell', root.querySelector('.emoji-btn')],
                        ['image', root.querySelector('.emoji-btn img')],
                        ['composer', document.querySelector('.message-input-container')],
                    ]) {
                        const b = n?.getBoundingClientRect();
                        r[key] = b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
                    }
                    return r;
                });
                await page.screenshot({ path: `${out}/${label}-${width}.png` });
                if (width === 390) {
                    await search.fill('grinning');
                    const input = await search.elementHandle();
                    await page.locator('[data-combined-tab="gifs"]').click();
                    await page.locator('.gif-picker:visible').waitFor();
                    await page.locator('.gif-search input:visible').fill('saved query');
                    await page.locator('[data-combined-tab="emoji"]').click();
                    assert.equal(await search.inputValue(), 'grinning');
                    assert(await input.evaluate((n) => n.isConnected));
                    if (label === 'reference') await field.click();
                    else await toggle.click();
                    await picker.waitFor({ state: 'hidden' });
                    await toggle.click();
                    await picker.waitFor();
                    assert.equal(await search.inputValue(), '');
                }
            }
            if (label === 'rewrite') {
                const custom = picker.locator('.emoji-btn[data-emoji^=":"]').first(),
                    code = await custom.getAttribute('data-emoji');
                await custom.scrollIntoViewIfNeeded();
                await poll(
                    page,
                    async (code) => {
                        const img = document.querySelector(`.emoji-btn[data-emoji="${code}"] img`),
                            s = await (await import('/chat-client/storage.js')).readState();
                        return (
                            img?.complete &&
                            img.naturalWidth > 0 &&
                            !!(await (
                                await caches.open(
                                    window.fixtureConstants.MEDIA_CACHE_PREFIX + s.userId,
                                )
                            ).match(img.src))
                        );
                    },
                    code,
                );
                await context.setOffline(true);
                await page.reload();
                await field.waitFor();
                await toggle.click();
                await picker.waitFor();
                await search.fill(code);
                await page.waitForFunction(
                    (code) =>
                        [...document.querySelectorAll(`.emoji-btn[data-emoji="${code}"] img`)].some(
                            (img) => img.complete && img.naturalWidth > 0,
                        ),
                    code,
                );
                await page.keyboard.press('Escape');
                await page.locator('.emoji-picker:visible').waitFor({ state: 'hidden' });
                console.log('PASS viewed custom emoji remains decoded after offline reload');
            }
            assert.deepEqual(errors, []);
            await context.close();
            console.log(
                'PASS ' +
                    label +
                    ' repeated caret insertion, retained grid, clear/category/reopen, one-click focus, layout close and combined tab state',
            );
        }
        fs.writeFileSync(out + '/geometry.json', JSON.stringify(geometry, null, 2));
        const differences = [];
        for (const width of [1440, 390])
            for (const key of ['picker', 'sidebar', 'search', 'cell', 'image', 'composer'])
                for (const property of ['x', 'y', 'width', 'height']) {
                    const want = geometry.reference[width][key]?.[property],
                        got = geometry.rewrite[width][key]?.[property];
                    if (want === undefined || got === undefined || Math.abs(want - got) > 1)
                        differences.push(`${width} ${key}.${property}: ${got} expected ${want}`);
                }
        assert.deepEqual(differences, []);
        console.log(
            'PASS measured original/rewrite emoji picker and raised composer geometry; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
