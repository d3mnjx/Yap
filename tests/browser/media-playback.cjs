const { fixturePage } = require('./support/authority.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs'),
    { execFileSync } = require('node:child_process');
const out = '/tmp/yap-media-playback';
fs.mkdirSync(out, { recursive: true });
execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=240x160:r=12',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=22050',
    '-t',
    '1.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    out + '/fixture.mp4',
]);
execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=22050',
    '-t',
    '1',
    '-y',
    out + '/fixture.wav',
]);
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
            page = await fixturePage(context),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const name = 'playback' + Date.now().toString(36);
        await page.goto('http://127.0.0.1:7643/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.locator('#upload-files').setInputFiles(out + '/fixture.mp4');
        const row = page
            .locator(`#timeline .message-group[data-author="${name}"]`)
            .filter({ has: page.locator('.video-player') })
            .last();
        await row.waitFor({ timeout: 60000 });
        const video = row.locator('video');
        assert.equal(await video.getAttribute('controls'), null);
        await row.getByRole('button', { name: 'Play video' }).click();
        await page.waitForFunction(
            (name) => {
                const v = document.querySelector(
                    `.message-group[data-author="${name}"] .video-player`,
                );
                return v?.readyState >= 2 && v.controls && v.currentTime > 0;
            },
            name,
            { timeout: 30000 },
        );
        assert((await video.getAttribute('poster')).endsWith('_poster.webp'));
        await video.evaluate((n) => n.pause());
        console.log(
            'PASS real video with audio upload, original poster/play overlay, native decoding/playback and controls',
        );
        await page.evaluate(
            async (fixtures) => {
                const store = await import('/chat-client/storage.js'),
                    state = await store.readState(),
                    cache = await caches.open(
                        window.fixtureConstants.MEDIA_CACHE_PREFIX + state.userId,
                    );
                for (const f of fixtures)
                    await cache.put(
                        f.url,
                        new Response(
                            Uint8Array.from(atob(f.bytes), (c) => c.charCodeAt(0)),
                            { headers: { 'Content-Type': f.type } },
                        ),
                    );
            },
            [
                {
                    url: '/media-cache/playback-fixture.mp4',
                    type: 'video/mp4',
                    bytes: fs.readFileSync(out + '/fixture.mp4').toString('base64'),
                },
                {
                    url: '/media-cache/playback-fixture.wav',
                    type: 'audio/wav',
                    bytes: fs.readFileSync(out + '/fixture.wav').toString('base64'),
                },
            ],
        );
        await context.setOffline(true);
        await page.evaluate(async () => {
            const store = await import('/chat-client/storage.js'),
                state = await store.readState(),
                c = state.snapshot.conversations.find((c) => c.isDefault),
                seed = c.messages.at(-1);
            c.messages.push({
                ...seed,
                id: 'playback-fixtures',
                content: 'Enriched media',
                images: [],
                videos: [],
                gifs: [],
                gifCount: 0,
                previews: [
                    {
                        url: 'https://example.com/video',
                        title: 'Video source title',
                        siteName: 'Source site',
                        cachedMediaUrl: '/media-cache/playback-fixture.mp4',
                        cachedPosterUrl: '/emoji_selection_color.png',
                        mediaType: 0,
                        mediaWidth: 240,
                        mediaHeight: 160,
                    },
                    {
                        url: 'https://example.com/audio',
                        title: 'Audio title',
                        siteName: 'Audio site',
                        imageUrl: '/emoji_selection_color.png',
                        cachedMediaUrl: '/media-cache/playback-fixture.wav',
                        mediaType: 1,
                    },
                    {
                        url: 'https://example.com/failed',
                        title: 'Should stay hidden',
                        failed: true,
                    },
                ],
            });
            await store.commitUpdate(
                window.fixtureUpdate({ ...state.snapshot, sequence: state.snapshot.sequence + 1 }),
                state,
            );
            const b = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
            b.postMessage('snapshot');
            b.close();
        });
        const fixture = page.locator('#msg-playback-fixtures');
        await fixture.locator('.video-title').waitFor();
        assert.equal(
            await fixture.locator('.video-title').getAttribute('href'),
            'https://example.com/video',
        );
        assert.equal(
            await fixture.locator('.cached-video-player').getAttribute('poster'),
            '/emoji_selection_color.png',
        );
        assert.equal(await fixture.locator('.audio-title').innerText(), 'Audio title');
        assert.equal(await fixture.locator('.audio-thumbnail').count(), 1);
        assert.equal(await fixture.locator('.link-preview-card').count(), 0);
        await page.waitForFunction(() => {
            const root = document.querySelector('#msg-playback-fixtures');
            return (
                root?.querySelector('audio')?.readyState >= 1 &&
                root.querySelector('video')?.readyState >= 2
            );
        });
        assert((await fixture.locator('audio').evaluate((n) => n.duration)) > 0);
        assert((await fixture.locator('video').evaluate((n) => n.videoWidth)) > 0);
        await page.screenshot({ path: out + '/desktop.png', animations: 'disabled' });
        await page.setViewportSize({ width: 390, height: 844 });
        await fixture.scrollIntoViewIfNeeded();
        assert(
            (await fixture.locator('.media-player-container').first().boundingBox()).width <= 390,
        );
        await page.waitForTimeout(400);
        await page.screenshot({ path: out + '/mobile.png', animations: 'disabled' });
        assert.deepEqual(errors, []);
        console.log(
            'PASS cached offline video/audio native decoding, original title/source/artwork/poster wrappers, failed-preview suppression and mobile sizing; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
