const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs');
const out = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-link-contrast';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch();
    try {
        const reference = await browser.newContext({ ignoreHTTPSErrors: true }),
            original = await reference.newPage();
        await original.goto('https://localhost:7443/login');
        await original.locator('.username-input').fill('linkref' + Date.now().toString(36));
        await original.locator('.join-button').click();
        await original.waitForURL('**/lobby');
        await original.locator('.message-input:enabled').waitFor();
        // Source-derived markup fixture uses the frozen component's actual CSS scope.
        const baseline = await original.evaluate(() => {
            const content = document.createElement('div');
            content.className = 'message-content';
            for (const sheet of document.styleSheets)
                for (const rule of sheet.cssRules) {
                    const scope = /\.message-content\[(b-[^\]]+)\].*a\.message-link/.exec(
                        rule.selectorText || '',
                    );
                    if (scope) content.setAttribute(scope[1], '');
                }
            const link = document.createElement('a');
            link.className = 'message-link';
            link.href = 'https://example.com';
            link.textContent = 'Reference link';
            content.append(link);
            document.body.append(content);
            return getComputedStyle(link).color;
        });
        assert.equal(baseline, 'rgb(0, 175, 244)');
        await reference.close();
        console.log(
            'PASS frozen original message-link markup/color fixture (the rewrite previously omitted this class)',
        );
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
            page = await context.newPage();
        await page.goto('http://127.0.0.1:7643/login');
        await page.locator('.username-input').fill('contrast' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        await context.setOffline(true);
        await page.evaluate(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState(),
                c = state.snapshot.conversations.find((c) => c.isDefault);
            c.hasMore = false;
            c.messages = [
                {
                    id: 'contrast-bot',
                    author: { ...state.snapshot.user, isBot: true },
                    content: 'Ping: [pwa-install] or open https://example.com/login',
                    timestamp: new Date().toISOString(),
                    images: [],
                    videos: [],
                    reactions: [],
                },
                {
                    id: 'contrast-person',
                    author: state.snapshot.user,
                    content: 'A normal link: https://example.com/read',
                    timestamp: new Date().toISOString(),
                    images: [],
                    videos: [],
                    reactions: [],
                },
            ];
            await s.commit({ ...state.snapshot, sequence: state.snapshot.sequence + 1 }, state);
            const b = new BroadcastChannel('yap-chat-v1');
            b.postMessage('snapshot');
            b.close();
        });
        await page.locator('#msg-contrast-bot a.message-link').waitFor();
        const themes = [
                'discord-dark',
                'midnight',
                'nord',
                'ocean',
                'sunset',
                'aurora',
                'terminal',
                'neon-glow',
                'light',
                'solarized-light',
            ],
            scenes = [
                'midnight',
                '2am',
                '314am',
                '4am',
                '6am',
                '8am',
                '10am',
                'noon',
                '2pm',
                '4pm',
                '6pm',
                '8pm',
                '10pm',
            ];
        const results = [];
        for (const [theme, scene] of [
            ...themes.map((t) => [t, 'noon']),
            ...scenes.map((s) => ['teahouse', s]),
        ]) {
            await page.evaluate(
                ({ theme, scene }) => {
                    document.documentElement.dataset.theme = theme;
                    document.documentElement.dataset.scene = scene;
                },
                { theme, scene },
            );
            await page.waitForTimeout(50);
            for (const selector of [
                '#msg-contrast-bot a',
                '#msg-contrast-bot .bot-action-link',
                '#msg-contrast-person a',
            ]) {
                const link = page.locator(selector);
                await link.scrollIntoViewIfNeeded();
                await page.mouse.move(1, 1);
                for (const hover of [false, true]) {
                    if (hover) await link.hover();
                    await page.waitForTimeout(120);
                    const color = await link.evaluate((n) => getComputedStyle(n).color);
                    assert(
                        (
                            await link.evaluate((n) => getComputedStyle(n).textDecorationLine)
                        ).includes('underline'),
                    );
                    const box = await link.boundingBox();
                    await link.evaluate((n) => {
                        n.style.color = 'transparent';
                        n.style.textDecorationColor = 'transparent';
                    });
                    const pixels = await page.screenshot({
                        clip: {
                            x: box.x + 2,
                            y: box.y + 2,
                            width: box.width - 4,
                            height: box.height - 4,
                        },
                        animations: 'disabled',
                    });
                    await link.evaluate((n) => {
                        n.style.removeProperty('color');
                        n.style.removeProperty('text-decoration-color');
                    });
                    const ratio = await page.evaluate(
                        async ({ png, color }) => {
                            const image = new Image();
                            image.src = 'data:image/png;base64,' + png;
                            await image.decode();
                            const canvas = document.createElement('canvas');
                            canvas.width = image.width;
                            canvas.height = image.height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(image, 0, 0);
                            const data = ctx.getImageData(0, 0, image.width, image.height).data;
                            const lum = (rgb) =>
                                    rgb
                                        .map((v) => v / 255)
                                        .map((v) =>
                                            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                                        )
                                        .reduce(
                                            (sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i],
                                            0,
                                        ),
                                fg = lum(
                                    color
                                        .match(/[\d.]+/g)
                                        .slice(0, 3)
                                        .map(Number),
                                );
                            let min = 21;
                            for (let i = 0; i < data.length; i += 4) {
                                const bg = lum([...data.slice(i, i + 3)]);
                                min = Math.min(
                                    min,
                                    (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
                                );
                            }
                            return min;
                        },
                        { png: pixels.toString('base64'), color },
                    );
                    results.push({ theme, scene, selector, hover, color, ratio });
                }
            }
            if (
                ['discord-dark', 'nord', 'light'].includes(theme) ||
                (theme === 'teahouse' && scene === 'noon')
            )
                await page.screenshot({ path: out + '/' + theme + '.png', animations: 'disabled' });
        }
        fs.writeFileSync(out + '/ratios.json', JSON.stringify(results, null, 2));
        const failures = results.filter((r) => r.ratio < 4.5);
        assert.deepEqual(
            failures,
            [],
            'Prose and bot action links must contrast with their rendered normal/hover background',
        );
        await page.locator('#msg-contrast-person a').focus();
        assert.equal(
            await page
                .locator('#msg-contrast-person a')
                .evaluate((n) => getComputedStyle(n).outlineStyle),
            'solid',
        );
        console.log(
            'PASS actual bot/normal/action link rendering, underlines, focus and >=4.5:1 screenshot-sampled contrast across 11 themes/13 Tea House scenes, normal and hover states; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
