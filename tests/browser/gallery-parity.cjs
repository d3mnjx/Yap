const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs');
const out = '/tmp/yap-gallery-parity';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await (process.env.YAP_BROWSER === 'firefox' ? firefox : chromium).launch(
        process.env.YAP_BROWSER === 'firefox' ? {} : { args: ['--ignore-certificate-errors'] },
    );
    try {
        const measurements = {};
        for (const [label, origin] of [
            ['reference', 'https://localhost:7443'],
            ['rewrite', 'http://127.0.0.1:7643'],
        ]) {
            const context = await browser.newContext({
                    ignoreHTTPSErrors: true,
                    viewport: { width: 1280, height: 800 },
                }),
                page = await context.newPage(),
                errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            const username = 'gallery' + Date.now().toString(36);
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill(username);
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.locator('.message-input:enabled').waitFor();
            if (label === 'rewrite')
                await page.waitForFunction(() =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced'),
                );
            const fixtures = await page.evaluate(() =>
                [
                    [800, 160],
                    [160, 800],
                    [400, 400],
                    [200, 1000],
                    [640, 360],
                ].map(([width, height], i) => {
                    const c = document.createElement('canvas');
                    c.width = width;
                    c.height = height;
                    c.getContext('2d').fillStyle = ['red', 'blue', 'green', 'purple', 'orange'][i];
                    c.getContext('2d').fillRect(0, 0, width, height);
                    return c.toDataURL('image/png').split(',')[1];
                }),
            );
            await page
                .locator('input[type="file"]')
                .first()
                .setInputFiles(
                    fixtures.map((f, i) => ({
                        name: `shape-${i}.png`,
                        mimeType: 'image/png',
                        buffer: Buffer.from(f, 'base64'),
                    })),
                );
            const row = page
                .locator(`.message-group[data-author="${username}"]`)
                .filter({ has: page.locator('.image-gallery') })
                .last();
            await page.waitForFunction(
                (username) =>
                    document.querySelectorAll(
                        `.message-group[data-author="${username}"] .gallery-image`,
                    ).length === 5,
                username,
                { timeout: 60000 },
            );
            assert.deepEqual(
                await row
                    .locator('.gallery-row')
                    .evaluateAll((nodes) => nodes.map((n) => n.children.length)),
                [2, 3],
            );
            await row.locator('.gallery-image').nth(3).click();
            const modal = page.locator('.image-modal');
            await modal.waitFor();
            await page.waitForFunction(
                () =>
                    Math.round(
                        document.querySelector('.gallery-strip').scrollLeft /
                            document.querySelector('.gallery-strip').clientWidth,
                    ) === 3,
            );
            await page.waitForFunction(
                () => document.querySelectorAll('.modal-stage img')[3]?.naturalWidth > 0,
            );
            assert((await page.locator('.modal-counter').innerText()).startsWith('4 / 5'));
            measurements[label] = {};
            for (const index of [0, 1, 2, 3]) {
                await page
                    .locator('.gallery-strip')
                    .evaluate((n, i) => (n.scrollLeft = i * n.clientWidth), index);
                await page.waitForTimeout(300);
                await page.waitForFunction(
                    (i) => document.querySelectorAll('.modal-stage img')[i]?.naturalWidth > 0,
                    index,
                );
                await page.locator('.modal-fill').click();
                const stage = page.locator('.modal-stage').nth(index);
                await stage.locator('img').waitFor();
                const dimensions = await stage.evaluate((n) => {
                    const r = n.getBoundingClientRect(),
                        img = n.querySelector('img').getBoundingClientRect();
                    return {
                        stageWidth: r.width,
                        stageHeight: r.height,
                        imageWidth: img.width,
                        imageHeight: img.height,
                        fill: n.classList.contains('fill'),
                        cover: n.classList.contains('fill-w'),
                        panX: n.scrollWidth > n.clientWidth,
                        panY: n.scrollHeight > n.clientHeight,
                    };
                });
                assert(
                    dimensions.fill &&
                        dimensions.imageWidth >= dimensions.stageWidth - 1 &&
                        dimensions.imageHeight >= dimensions.stageHeight - 1,
                );
                measurements[label][index] = dimensions;
                await page.locator('.modal-fill').click();
            }
            await page.locator('.gallery-strip').evaluate((n) => (n.scrollLeft = 0));
            await page.waitForTimeout(300);
            const motions = [];
            for (const width of [1280, 390]) {
                await page.setViewportSize({ width, height: 800 });
                for (const [direction, to, fill] of [
                    ['next', 1, false],
                    ['prev', 0, false],
                    ['next', 1, true],
                    ['prev', 0, true],
                ]) {
                    if (fill) await page.locator('.modal-fill').click();
                    await page.evaluate(() => {
                        window.galleryFrames = [];
                        const started = performance.now();
                        const record = () => {
                            const n = document.querySelector('.gallery-strip');
                            window.galleryFrames.push(n.scrollLeft / n.clientWidth);
                            if (performance.now() - started < 1100) requestAnimationFrame(record);
                        };
                        requestAnimationFrame(record);
                    });
                    await page.locator('.modal-nav.' + direction).click();
                    await page.waitForTimeout(1150);
                    const frames = await page.evaluate(() => window.galleryFrames),
                        intermediate = frames.filter((x) => x > 0.01 && x < 0.99).length;
                    motions.push({ width, direction, fill, frames });
                    console.log(
                        `${label} width=${width} ${direction} fill=${fill}: ${intermediate} intermediate frames`,
                    );
                    assert(
                        intermediate >= 3,
                        'Gallery navigation must animate through intermediate positions',
                    );
                    assert(Math.abs(frames.at(-1) - to) < 0.01, 'Gallery reaches requested image');
                }
            }
            await page.setViewportSize({ width: 1280, height: 800 });
            fs.writeFileSync(`${out}/${label}-animation.json`, JSON.stringify(motions));
            await page.screenshot({ path: `${out}/${label}-desktop.png` });
            await page.keyboard.press('Escape');
            await modal.waitFor({ state: 'detached' });
            await row.locator('.gallery-image').nth(0).click();
            await page.locator('.modal-stage').first().locator('img').dblclick();
            await page.waitForFunction(() =>
                document.querySelector('.modal-stage').classList.contains('fill'),
            );
            await page.keyboard.press('ArrowRight');
            await page.waitForFunction(
                () =>
                    Math.round(
                        document.querySelector('.gallery-strip').scrollLeft /
                            document.querySelector('.gallery-strip').clientWidth,
                    ) === 1,
            );
            await page.waitForFunction(
                () => !document.querySelector('.modal-stage').classList.contains('fill'),
            );
            await page.locator('.modal-close').click();
            if (label === 'rewrite') {
                await page.evaluate(() => {
                    const match = Cache.prototype.match;
                    Cache.prototype.match = async function (...args) {
                        const value = await match.apply(this, args);
                        if (document.querySelector('.image-modal'))
                            await new Promise((r) => setTimeout(r, 180));
                        return value;
                    };
                    window.restoreCacheMatch = () => (Cache.prototype.match = match);
                });
                await row.locator('.gallery-image').nth(0).click();
                await page.evaluate(() => {
                    window.coldFrames = [];
                    const started = performance.now();
                    const record = () => {
                        const n = document.querySelector('.gallery-strip');
                        window.coldFrames.push(n.scrollLeft / n.clientWidth);
                        if (performance.now() - started < 1400) requestAnimationFrame(record);
                    };
                    requestAnimationFrame(record);
                });
                await page.locator('.modal-nav.next').click();
                await page.waitForTimeout(1450);
                const cold = await page.evaluate(() => window.coldFrames);
                fs.writeFileSync(out + '/rewrite-cold-animation.json', JSON.stringify(cold));
                console.log(
                    'rewrite cold intermediate frames ' +
                        cold.filter((x) => x > 0.01 && x < 0.99).length +
                        ' final ' +
                        cold.at(-1),
                );
                assert(cold.filter((x) => x > 0.01 && x < 0.99).length >= 3);
                assert(Math.abs(cold.at(-1) - 1) < 0.01);
                await page.keyboard.press('Escape');
                await page.evaluate(() => window.restoreCacheMatch());
            }
            if (label === 'rewrite') {
                await page.waitForFunction(async () => {
                    const s = await (await import('/chat-client/storage.js')).readState(),
                        c = await caches.open('yap-chat-media-' + s.userId),
                        images = s.snapshot.conversations
                            .find((c) => c.isDefault)
                            .messages.filter((m) => m.author.id === s.userId)
                            .flatMap((m) => m.images);
                    return (
                        images.length === 5 &&
                        (await Promise.all(images.map((i) => c.match(i.medium)))).every(Boolean)
                    );
                });
                await context.setOffline(true);
                await page.reload();
                await row.locator('.gallery-image').nth(4).click();
                await page.waitForFunction(
                    () => document.querySelectorAll('.modal-stage img')[4]?.naturalWidth > 0,
                );
                assert((await page.locator('.modal-counter').innerText()).startsWith('5 / 5'));
                await page.keyboard.press('Escape');
                await context.setOffline(false);
                const touch = await browser.newContext({
                        storageState: await context.storageState(),
                        viewport: { width: 390, height: 844 },
                        ...(process.env.YAP_BROWSER === 'firefox' ? {} : { isMobile: true }),
                        hasTouch: true,
                    }),
                    phone = await touch.newPage();
                phone.on('pageerror', (e) => errors.push(e.message));
                await phone.goto(origin + '/lobby');
                const image = phone
                    .locator(`.message-group[data-author="${username}"] .gallery-image`)
                    .first();
                await image.tap();
                await phone.waitForFunction(
                    () => document.querySelector('.modal-stage img')?.naturalWidth > 0,
                );
                await phone.locator('.modal-stage img').first().tap();
                await phone.locator('.modal-stage img').first().tap();
                await phone.waitForFunction(() =>
                    document.querySelector('.modal-stage').classList.contains('fill'),
                );
                await phone.locator('.modal-fill').tap();
                const target = phone.locator('.modal-stage').first();
                await target.dispatchEvent('pointerdown', {
                    pointerType: 'touch',
                    isPrimary: true,
                    clientY: 200,
                    clientX: 100,
                });
                await target.dispatchEvent('pointermove', {
                    pointerType: 'touch',
                    isPrimary: true,
                    clientY: 270,
                    clientX: 100,
                });
                assert.equal(await target.evaluate((n) => n.style.transform), 'translateY(70px)');
                await target.dispatchEvent('pointercancel', {
                    pointerType: 'touch',
                    clientY: 270,
                    clientX: 100,
                });
                assert.equal(await target.evaluate((n) => n.style.transform), '');
                await phone.screenshot({ path: out + '/rewrite-touch.png' });
                await target.dispatchEvent('pointerdown', {
                    pointerType: 'touch',
                    isPrimary: true,
                    clientY: 200,
                    clientX: 100,
                });
                await target.dispatchEvent('pointerup', {
                    pointerType: 'touch',
                    isPrimary: true,
                    clientY: 350,
                    clientX: 100,
                });
                await phone.locator('.image-modal').waitFor({ state: 'detached' });
                await touch.close();
                console.log(
                    'PASS offline reload/selected cached image and touch double-tap/fill, drag-follow/cancel/close (synthetic drag boundary)',
                );
            }
            if (errors.includes('WebSocket is not in the OPEN state'))
                console.log('Firefox transport diagnostic: WebSocket is not in the OPEN state');
            assert.deepEqual(
                errors.filter(
                    (e) =>
                        process.env.YAP_BROWSER !== 'firefox' ||
                        e !== 'WebSocket is not in the OPEN state',
                ),
                [],
            );
            await context.close();
            console.log(
                'PASS ' +
                    label +
                    ' real five-image upload/2+3 rows, first selected frame, fit/fill covering wide/tall/square/very-tall, keyboard/reset/close',
            );
        }
        assert.deepEqual(measurements.rewrite, measurements.reference);
        fs.writeFileSync(out + '/geometry.json', JSON.stringify(measurements, null, 2));
        console.log(
            'PASS matched original/rewrite gallery fill geometry; ' +
                browser.browserType().name() +
                ' ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
