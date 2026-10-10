const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs'),
    path = require('node:path'),
    crypto = require('node:crypto'),
    { execFileSync } = require('node:child_process');
const out = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-embedded-parity';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        const results = {};
        for (const [label, origin, root] of [
            ['reference', 'https://localhost:7443', '/home/agent/.local/share/yap-reference/app'],
            ['rewrite', 'http://127.0.0.1:7643', '/home/agent/.local/share/yap-phase2-test/app'],
        ]) {
            const context = await browser.newContext({
                    ignoreHTTPSErrors: true,
                    viewport: { width: 1280, height: 800 },
                }),
                page = await context.newPage(),
                name = 'embed' + Date.now().toString(36);
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill(name);
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.locator('.message-input:enabled').waitFor();
            if (label === 'rewrite')
                await page.waitForFunction(() =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced'),
                );
            results[label] = [];
            for (const [kind, w, h] of [
                ['portrait', 720, 1280],
                ['landscape', 1280, 720],
                ['square', 800, 800],
            ]) {
                const url = 'https://parity.invalid/parity-' + name + '-' + kind,
                    hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16),
                    cache = path.join(root, 'Data/media-cache');
                fs.mkdirSync(cache, { recursive: true });
                const target = path.join(cache, hash);
                execFileSync('ffmpeg', [
                    '-loglevel',
                    'error',
                    '-f',
                    'lavfi',
                    '-i',
                    `color=c=green:s=${w}x${h}:r=12`,
                    '-t',
                    '1',
                    '-c:v',
                    'libx264',
                    '-pix_fmt',
                    'yuv420p',
                    '-y',
                    target + '.mp4',
                ]);
                execFileSync('ffmpeg', [
                    '-loglevel',
                    'error',
                    '-i',
                    target + '.mp4',
                    '-frames:v',
                    '1',
                    '-y',
                    target + '_poster.webp',
                ]);
                fs.writeFileSync(target + '.dims', w + 'x' + h);
                fs.writeFileSync(target + '.title', 'Cached ' + kind + ' title');
                await page.locator('.message-input').fill(url);
                await page.locator('.send-button').click();
                const row = page
                    .locator(`.message-group[data-author="${name}"]`)
                    .filter({ has: page.locator(`video source[src="/media-cache/${hash}.mp4"]`) });
                await row.waitFor({ timeout: 30000 });
                const video = row.locator('video');
                await video.evaluate((n) => n.pause());
                for (const width of [1280, 390]) {
                    await page.setViewportSize({ width, height: 800 });
                    await row.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(200);
                    const dims = await video.evaluate((n) => {
                        const r = n.getBoundingClientRect();
                        return {
                            width: r.width,
                            height: r.height,
                            aspect: getComputedStyle(n).aspectRatio,
                            poster: !!n.poster,
                        };
                    });
                    results[label].push({ kind, viewport: width, ...dims });
                    await page.screenshot({
                        path: out + '/' + label + '-' + kind + '-' + width + '.png',
                        animations: 'disabled',
                    });
                }
                if (label === 'rewrite') {
                    const data = await (
                            await context.request.get(origin + '/api/chat/bootstrap')
                        ).json(),
                        msg = data.conversations
                            .flatMap((c) => c.messages)
                            .find((m) => m.author.username === name && m.content === url),
                        p = msg.previews[0];
                    assert.deepEqual(
                        [p.mediaWidth, p.mediaHeight, p.title],
                        [w, h, 'Cached ' + kind + ' title'],
                        'Snapshot must carry real cached dimensions and title fallback',
                    );
                }
                await page.setViewportSize({ width: 1280, height: 800 });
                if (kind === 'portrait') {
                    await video.evaluate(async (n) => {
                        window.playingMedia = n;
                        n.loop = true;
                        n.muted = true;
                        await n.play();
                    });
                    await page.waitForFunction(() => window.playingMedia.currentTime > 0.15);
                    await row.hover();
                    await row.locator('.message-actions .action-btn').first().click();
                    await row.locator('.reaction-pill').waitFor();
                    assert(
                        await video.evaluate((n) => n === window.playingMedia && !n.paused),
                        'Reactions must retain the playing media element',
                    );
                    await row.locator('.reaction-pill').first().click();
                    await row.locator('.reaction-pill').waitFor({ state: 'detached' });
                    assert(
                        await video.evaluate((n) => n === window.playingMedia && !n.paused),
                        'Removing a reaction also preserves playback',
                    );
                    await video.evaluate((n) => n.pause());
                    console.log('PASS ' + label + ' reaction add/remove retains video playback');
                }
            }
            await context.close();
            console.log('PASS ' + label + ' real disk-cache media rendering');
        }
        fs.writeFileSync(out + '/geometry.json', JSON.stringify(results, null, 2));
        assert.deepEqual(results.rewrite, results.reference);
        console.log(
            'PASS portrait/landscape/square geometry matches frozen original at desktop/phone widths; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
