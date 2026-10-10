const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643',
    artifacts = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-content-browser';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw Error('Local fixture only');
fs.mkdirSync(artifacts, { recursive: true });
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
            page = await context.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('rich' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        const other = await browser.newContext(),
            buddy = await other.newPage(),
            name = 'mediafriend' + Date.now().toString(36);
        await buddy.goto(origin + '/login');
        await buddy.locator('.username-input').fill(name);
        await buddy.locator('.join-button').click();
        await buddy.waitForURL('**/lobby');
        await page.bringToFront();
        await page.goto(origin + '/dm/' + name);
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.locator('#draft').fill('left right');
        await page.locator('#draft').evaluate((n) => n.setSelectionRange(5, 5));
        await page.locator('#emoji-button').click();
        await page.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('grinning');
        await page.locator('.emoji-btn[title="😀"]').first().click();
        await page.waitForFunction(() => document.querySelector('#draft').value === 'left 😀right');
        await page.locator('#send').click();
        await page.waitForFunction(() =>
            [...document.querySelectorAll('#timeline .message-text')].some(
                (n) => n.textContent === 'left right' && n.querySelector('img[alt="😀"]'),
            ),
        );
        await page.locator('#emoji-button').click();
        await page
            .locator('.emoji-section[data-section="recent"] .emoji-btn[title="😀"]')
            .waitFor();
        await page.keyboard.press('Escape');
        await page.locator('#draft').fill('👍🏽 👩‍💻');
        await page.locator('#send').click();
        await page.waitForFunction(() =>
            [...document.querySelectorAll('#timeline .message-text')].some(
                (n) =>
                    n.querySelector('img[alt="👍🏽"]') &&
                    n.querySelector('img[alt="👩‍💻"]') &&
                    n.querySelectorAll('img').length === 2,
            ),
        );
        const image = Buffer.from(
            await page.evaluate(() => {
                const c = document.createElement('canvas');
                c.width = 32;
                c.height = 24;
                c.getContext('2d').fillRect(0, 0, 32, 24);
                return c.toDataURL('image/png').split(',')[1];
            }),
            'base64',
        );
        await context.setOffline(true);
        await page
            .locator('#upload-files')
            .setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: image });
        await page.locator('#pending .attachment-preview').waitFor();
        await page.reload();
        await page.locator('#pending .attachment-preview').waitFor();
        assert((await page.locator('#pending').innerText()).includes('offline.png'));
        await context.setOffline(false);
        await page.waitForFunction(
            () => document.querySelectorAll('#pending [data-operation]').length === 0,
            null,
            { timeout: 60000 },
        );
        await page.waitForFunction(
            () =>
                [...document.querySelectorAll('#timeline .gallery-image')].some(
                    (i) => i.complete && i.naturalWidth > 0,
                ),
            null,
            { timeout: 30000 },
        );
        const uploaded = await page.evaluate(async () => {
            const s = await (await import('/chat-client/storage.js')).readState();
            return s.snapshot.conversations
                .find((c) => c.path === location.pathname)
                .messages.filter((m) => m.author.id === s.userId && m.images.length)
                .at(-1);
        });
        assert(uploaded);
        await page.locator('#msg-' + uploaded.id + ' .gallery-item').click();
        await page.locator('.modal-stage img').waitFor();
        await page.keyboard.press('Escape');
        console.log(
            'PASS emoji search/caret/recents and actual offline PNG queue/reload/upload/decode/gallery',
        );
        // Real GIF processing, favorites and cached selection; a tiny GIF is sufficient for service acceptance.
        require('node:child_process').execFileSync('ffmpeg', [
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=blue:s=160x100:r=5',
            '-t',
            '1',
            '-y',
            artifacts + '/fixture.gif',
        ]);
        const gif = fs.readFileSync(artifacts + '/fixture.gif');
        await page
            .locator('#upload-files')
            .setInputFiles({ name: 'fixture.gif', mimeType: 'image/gif', buffer: gif });
        await page.waitForFunction(
            () =>
                [
                    ...document.querySelectorAll(
                        '#timeline .gif-message img, #timeline .gif-message video',
                    ),
                ].some((i) =>
                    i.tagName === 'VIDEO' ? i.readyState >= 2 : i.complete && i.naturalWidth > 0,
                ),
            null,
            { timeout: 60000 },
        );
        await page.locator('#timeline .gif-message').last().hover();
        await page.locator('#timeline .gif-message-fav').last().click();
        await page.locator('#timeline .gif-message-fav.favorited').last().waitFor();
        await page.locator('#gif-button').click();
        await page
            .getByRole('dialog', { name: 'GIF picker' })
            .getByTitle('Favorites', { exact: true })
            .click();
        await page
            .getByRole('dialog', { name: 'GIF picker' })
            .getByRole('button', { name: 'Send GIF', exact: true })
            .first()
            .waitFor();
        await page
            .getByRole('dialog', { name: 'GIF picker' })
            .getByRole('button', { name: 'Send GIF', exact: true })
            .first()
            .click();
        await page.waitForFunction(
            () => document.querySelectorAll('#timeline .gif-message').length >= 2,
        );
        await page.locator('#gif-button').click();
        await page
            .getByRole('dialog', { name: 'GIF picker' })
            .getByTitle('Favorites', { exact: true })
            .click();
        await page.getByRole('link', { name: 'Manage your GIFs in Settings', exact: true }).click();
        await page.getByRole('heading', { name: 'My GIFs', exact: true }).waitFor();
        assert.equal((await context.request.get(origin + '/api/gifs/export')).status(), 200);
        await page.goBack();
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        console.log(
            'PASS real GIF upload/render, favorite and Favorites selection; retained library link',
        );
        const beforeLibrary = await (
            await context.request.get(origin + '/api/chat/gifs/library')
        ).json();
        require('node:child_process').execFileSync('ffmpeg', [
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=red:s=162x102:r=5',
            '-t',
            '1',
            '-y',
            artifacts + '/picker-fixture.gif',
        ]);
        await context.route('**/api/tus/**', async (route) => {
            if (route.request().method() === 'PATCH')
                await new Promise((resolve) => setTimeout(resolve, 800));
            await route.continue();
        });
        await page.locator('#gif-button').click();
        const fileChoice = page.waitForEvent('filechooser');
        await page.getByRole('dialog', { name: 'GIF picker' }).getByTitle('Upload a GIF').click();
        await (await fileChoice).setFiles(artifacts + '/picker-fixture.gif');
        await page.locator('.gif-upload-overlay:visible').waitFor();
        await page.waitForFunction(
            () => document.querySelectorAll('#pending [data-operation]').length === 0,
            null,
            { timeout: 60000 },
        );
        await page.getByRole('dialog', { name: 'GIF picker' }).waitFor({ state: 'hidden' });
        const afterLibrary = await (
            await context.request.get(origin + '/api/chat/gifs/library')
        ).json();
        assert.equal(afterLibrary.favorites.length, beforeLibrary.favorites.length + 1);
        await context.unroute('**/api/tus/**');
        console.log(
            'PASS actual picker file chooser/upload overlay, send completion and automatic favorite',
        );

        await page.waitForFunction(async () => {
            const s = await (await import('/chat-client/storage.js')).readState();
            const url = s.snapshot.conversations
                .find((c) => c.path === location.pathname)
                .messages.flatMap((m) => m.gifs || [])
                .at(-1)?.url;
            return url && !!(await (await caches.open('yap-chat-media-' + s.userId)).match(url));
        });
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(() =>
            [
                ...document.querySelectorAll(
                    '#timeline .gif-message video,#timeline .gif-message img',
                ),
            ].some((m) =>
                m.tagName === 'VIDEO' ? m.readyState >= 2 : m.complete && m.naturalWidth > 0,
            ),
        );
        console.log(
            'PASS cached GIF playback after offline reload, including media range handling',
        );
        // Persisted protocol fixture verifies rendering of server-enriched content without depending on public providers.
        await context.setOffline(true);
        await page.evaluate(async () => {
            const store = await import('/chat-client/storage.js'),
                state = await store.readState(),
                c = state.snapshot.conversations.find((c) => c.path === location.pathname);
            const seed = c.messages.at(-1);
            c.messages.push({
                ...seed,
                id: 'media-fixture',
                content: 'Link fixture',
                gifs: [],
                gifCount: 0,
                images: [],
                videos: ['/uploads/fixture.mp4'],
                previews: [
                    {
                        url: 'https://example.com/',
                        title: 'Preview title',
                        description: 'Preview body',
                        siteName: 'Example',
                    },
                    {
                        url: 'https://example.com/audio',
                        cachedMediaUrl: '/uploads/fixture.mp3',
                        mediaType: 1,
                    },
                ],
            });
            await store.commit({ ...state.snapshot, sequence: state.snapshot.sequence + 1 }, state);
            const b = new BroadcastChannel('yap-chat-v1');
            b.postMessage('snapshot');
            b.close();
        });
        await page.locator('#msg-media-fixture video.video-player').waitFor();
        await page.locator('#msg-media-fixture .video-play-overlay').waitFor();
        await page.locator('#msg-media-fixture audio[controls]').waitFor();
        await page.locator('#msg-media-fixture .link-preview-title').waitFor();
        await page.screenshot({ path: artifacts + '/rich-desktop.png' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#emoji-button').click();
        await page.screenshot({ path: artifacts + '/emoji-mobile.png' });
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        console.log(
            'PASS media/link markup fixture, mobile-sized picker, Chromium ' + browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
