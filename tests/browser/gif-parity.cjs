const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = 'http://127.0.0.1:7643',
    out = '/tmp/yap-gif-parity';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        const shapes = {};
        for (const [label, address] of [
            ['reference', 'https://localhost:7443'],
            ['rewrite', origin],
        ]) {
            const c = await browser.newContext({
                    ignoreHTTPSErrors: true,
                    viewport: { width: 1440, height: 1000 },
                }),
                p = await c.newPage();
            await p.goto(address + '/login');
            await p.locator('.username-input').fill('gifshape' + Date.now().toString(36));
            await p.locator('.join-button').click();
            await p.waitForURL('**/lobby');
            if (label === 'rewrite')
                await p.waitForFunction(() =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced'),
                );
            else await p.locator('.gif-picker').waitFor({ state: 'attached' });
            await p.locator('.gif-toggle-button').click();
            await p.locator('.gif-picker:visible').waitFor();
            await p.waitForTimeout(500);
            shapes[label] = await p.evaluate(() => {
                const picker = [...document.querySelectorAll('.gif-picker')].find(
                        (n) => n.offsetWidth,
                    ),
                    r = {};
                for (const cls of ['gif-picker', 'gif-sidebar', 'gif-search', 'gif-upload-btn']) {
                    const n = cls === 'gif-picker' ? picker : picker.querySelector('.' + cls),
                        b = n.getBoundingClientRect();
                    r[cls] = { x: b.x, y: b.y, width: b.width, height: b.height };
                }
                return r;
            });
            await p.screenshot({ path: `${out}/${label}.png` });
            await c.close();
        }
        for (const cls of Object.keys(shapes.reference))
            for (const key of ['x', 'y', 'width', 'height'])
                assert(
                    Math.abs(shapes.reference[cls][key] - shapes.rewrite[cls][key]) <= 1,
                    `${cls}.${key}`,
                );
        console.log('PASS original/rewrite GIF panel/sidebar/search/upload geometry');
        fs.writeFileSync(out + '/geometry.json', JSON.stringify(shapes, null, 2));
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
            page = await context.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('gifbehavior' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        // Controlled provider/library fixtures exercise offline UI without depending on external configuration.
        const img = '/emoji_selection_color.png',
            local = {
                id: '11111111-1111-1111-1111-111111111111',
                width: 120,
                height: 80,
                preview: img,
                url: img,
                title: 'local happy',
                favorite: true,
            };
        let configured = true,
            remoteRequests = 0,
            searches = [],
            selected = 0,
            resolved = false;
        const library = () => ({
            recent: [local],
            favorites: [
                local,
                { ...local, id: '22222222-2222-2222-2222-222222222222', title: 'unsorted' },
            ],
            server: [
                { ...local, id: '33333333-3333-3333-3333-333333333333', serverFolder: 'Shared' },
            ],
            favoriteFolders: ['Faces'],
            favoriteFolderMap: { [local.id]: 'Faces' },
            serverFolders: ['Shared'],
            configured,
            provider: 'Fixture provider',
            attribution: img,
            projectName: 'Fixture chat',
        });
        const remote = (id) => ({
            sourceId: id,
            title: 'remote ' + id,
            width: 120,
            height: 80,
            previewFormats: [
                { url: '/bad-preview.mp4', contentType: 'video/mp4' },
                { url: img, contentType: 'image/webp' },
            ],
            formats: [{ url: img, contentType: 'image/gif' }],
        });
        await context.route('**/api/chat/gifs/library', (r) => r.fulfill({ json: library() }));
        await context.route('**/api/chat/gifs?*', async (r) => {
            const u = new URL(r.request().url());
            if (u.searchParams.get('mode') === 'trending') remoteRequests++;
            else searches.push(u.searchParams.get('q'));
            if (u.searchParams.get('q') === 'slow')
                await new Promise((resolve) => setTimeout(resolve, 600));
            await r
                .fulfill({
                    json: {
                        items: u.searchParams.get('mode') === 'trending' ? [] : [local],
                        remote: {
                            items: [remote(u.searchParams.get('q') || 'trending')],
                            nextCursor: u.searchParams.get('cursor') ? null : 'page2',
                        },
                        configured,
                        provider: 'Fixture provider',
                    },
                })
                .catch(() => {});
        });
        await context.route('**/api/chat/gifs/select', async (r) => {
            selected++;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            resolved = true;
            await r.fulfill({ status: 404, json: { error: 'That GIF is unavailable.' } });
        });
        assert.equal(remoteRequests, 0);
        await page.locator('#gif-button').click();
        const picker = page.getByRole('dialog', { name: 'GIF picker' });
        await picker
            .getByRole('button', { name: 'Faces', exact: true })
            .waitFor({ state: 'hidden' });
        await picker.locator('.gif-folder-tile').filter({ hasText: 'Favorites' }).waitFor();
        assert(
            await picker
                .getByTitle('Browse', { exact: true })
                .evaluate((n) => n.classList.contains('active')),
        );
        assert(remoteRequests > 0);
        await picker.locator('.gif-folder-tile').filter({ hasText: 'Favorites' }).click();
        await picker.getByRole('button', { name: 'Faces', exact: true }).click();
        assert.equal(await picker.locator('.gif-card').count(), 1);
        await picker.getByTitle('Back to Favorites').click();
        await picker.locator('.gif-section-header').filter({ hasText: 'Unsorted' }).waitFor();
        await picker.getByTitle('Server library', { exact: true }).click();
        await picker.getByRole('button', { name: 'Shared', exact: true }).click();
        assert.equal(await picker.locator('.gif-card').count(), 1);
        const search = picker.getByRole('textbox', { name: 'Search GIFs', exact: true });
        await search.fill('slow');
        await page.waitForTimeout(300);
        await search.fill('happy');
        await picker
            .locator('.gif-section-header')
            .filter({ hasText: 'Fixture provider' })
            .waitFor();
        await page.waitForTimeout(700);
        assert.equal(await picker.locator('.gif-card[title="remote slow"]').count(), 0);
        assert.equal(
            await picker.locator('.gif-card[title="remote happy"] img').getAttribute('src'),
            img,
        );
        await picker
            .locator('.gif-section-header')
            .filter({ hasText: 'From your library' })
            .waitFor();
        await picker.getByTitle('Clear', { exact: true }).click();
        assert.equal(await search.inputValue(), '');
        assert(
            await picker
                .getByTitle('Server library', { exact: true })
                .evaluate((n) => n.classList.contains('active')),
        );
        await picker.getByTitle('Trending', { exact: true }).click();
        await picker.locator('.gif-card[title="remote trending"]').waitFor();
        assert.equal(await picker.locator('.gif-fav-btn').count(), 0);
        await picker.getByRole('button', { name: 'Load more', exact: true }).click();
        await page.waitForFunction(
            () => document.querySelectorAll('.gif-picker .gif-card').length === 2,
        );
        await picker.locator('.gif-card').first().click();
        await picker.waitFor({ state: 'hidden' });
        await page.locator('#pending .gif-message').waitFor();
        assert.equal(resolved, false, 'preview is visible before provider resolution');
        await page.waitForFunction(() =>
            document.querySelector('#pending .delivery-status.failed'),
        );
        assert.equal(selected, 1);
        await page.locator('#pending .delivery-error').filter({ hasText: 'unavailable' }).waitFor();
        console.log(
            'PASS Browse/favorite/server folder tiles, split search/cancel/clear, preview preference, paging and durable provider preview/failure',
        );
        configured = false;
        await page.locator('#gif-button').click();
        await page.waitForFunction(
            () => document.querySelector('.gif-picker [title="Trending"]').disabled,
        );
        await picker.getByTitle('Favorites', { exact: true }).click();
        await picker.getByRole('button', { name: 'Faces', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#emoji-button').click();
        await page.locator('[data-combined-tab="gifs"]').click();
        await picker.waitFor();
        await picker.getByTitle('Favorites', { exact: true }).click();
        await picker.getByRole('button', { name: 'Faces', exact: true }).click();
        await search.fill('kept');
        await page.locator('[data-combined-tab="emoji"]').click();
        await page.locator('[data-combined-tab="gifs"]').click();
        assert.equal(await search.inputValue(), 'kept');
        await page.screenshot({ path: out + '/mobile.png' });
        assert.deepEqual(errors, []);
        console.log(
            'PASS provider-unconfigured local library and mounted mobile state; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
