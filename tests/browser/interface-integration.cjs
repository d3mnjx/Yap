const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = 'http://127.0.0.1:7643',
    out = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-interface-integration';
fs.mkdirSync(out, { recursive: true });
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
            page = await context.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const name = 'interface' + Date.now().toString(36);
        await page.route('**/api/chat/catalog', async (route) => {
            const response = await route.fetch(),
                data = await response.json();
            data.labels = {
                roomHeaders: ['Welcome to {0}'],
                messagePlaceholders: ['Write something here'],
            };
            await route.fulfill({ response, json: data });
        });
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        assert.match(await page.locator('#title').innerText(), /^Welcome to /);
        assert.equal(
            await page.locator('#draft').getAttribute('placeholder'),
            'Write something here',
        );
        await page.locator('#draft').fill('Settings preserves this draft');
        await page.waitForFunction(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            return (
                (await s.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                'Settings preserves this draft'
            );
        });
        await page.locator('#menu-button').click();
        await page.locator('#account-menu a[href="/settings"]').click();
        await page.locator('#bio').waitFor();
        await page.locator('#display-name').fill('Interface Person');
        await page.locator('#bio').fill('A tested profile');
        await page.locator('#country').fill('Prague');
        await page.locator('.save-status.saved').filter({ hasText: 'Saved' }).first().waitFor();
        await page.getByRole('button', { name: 'Nord', exact: true }).click();
        await page.locator('.font-size-option').filter({ hasText: '20px' }).click();
        // The retained Settings page inspects Cache Storage only; queued writes and drafts live in IndexedDB.
        const queued = await page.evaluate(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState(),
                id = state.snapshot.conversations.find((c) => c.isDefault).id;
            const item = await s.enqueue(id, 'Cache-clear queue fixture', state);
            const cache = await caches.open('yap-chat-media-' + state.userId);
            await cache.put('/uploads/cache-clear-fixture.png', new Response('fixture'));
            return item.operationId;
        });
        await page.reload();
        await page.locator('.debug-info summary').click();
        const cache = page.locator('.cache-group').filter({
            has: page.locator('.cache-group-name', {
                hasText: 'Media — saved chat attachments',
            }),
        });
        await cache.getByRole('button', { name: 'Clear this cache' }).click();
        await page.waitForFunction(
            async () => !(await caches.keys()).some((k) => k.startsWith('yap-chat-media-')),
        );
        assert(
            await page.evaluate(
                async (id) =>
                    (await (await import('/chat-client/storage.js')).outbox()).some(
                        (i) => i.operationId === id,
                    ),
                queued,
            ),
        );
        await page.goto(origin + '/lobby');
        await page.waitForFunction(
            () =>
                document.documentElement.dataset.theme === 'nord' &&
                getComputedStyle(document.documentElement).fontSize === '20px',
        );
        assert.equal(await page.locator('#draft').inputValue(), 'Settings preserves this draft');
        await page.waitForFunction(
            () => document.querySelector('#status-username')?.textContent === 'Interface Person',
        );
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(
            () => document.querySelector('#draft')?.value === 'Settings preserves this draft',
        );
        assert.equal(await page.locator('#draft').inputValue(), 'Settings preserves this draft');
        assert.equal(
            await page.locator('#draft').getAttribute('placeholder'),
            'Write something here',
        );
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'nord');
        console.log(
            'PASS real Settings profile/theme/font updates, return and offline preferences/draft; actual media-cache clear retains queue and draft',
        );
        // Cached fixtures isolate administrative controls and permission rendering from server authorization.
        await page.evaluate(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            state.snapshot.isAdmin = true;
            const c = state.snapshot.conversations.find((c) => c.isDefault);
            c.hasMore = false;
            c.historyLimited = true;
            await s.commit({ ...state.snapshot, sequence: state.snapshot.sequence + 1 }, state);
            const b = new BroadcastChannel('yap-chat-v1');
            b.postMessage('snapshot');
            b.close();
        });
        await page.locator('.room-settings').first().waitFor();
        assert.equal(await page.locator('a.add-room').getAttribute('href'), '/channel/new');
        assert.equal(
            await page.locator('#history-note').innerText(),
            'Older messages are not available in this channel',
        );
        await page.evaluate(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            const c = state.snapshot.conversations.find((c) => c.isDefault);
            c.historyLimited = false;
            c.description = 'First line\nSecond line';
            await s.commit({ ...state.snapshot, sequence: state.snapshot.sequence + 1 }, state);
            const b = new BroadcastChannel('yap-chat-v1');
            b.postMessage('snapshot');
            b.close();
        });
        await page.waitForFunction(
            () => document.querySelector('#history-note').textContent === 'First line\nSecond line',
        );
        const drag = async (type, files) =>
            page.locator('.message-input-container').dispatchEvent(type, {
                dataTransfer: await page.evaluateHandle((files) => {
                    const d = new DataTransfer();
                    if (files) d.items.add(new File(['x'], 'fixture.png', { type: 'image/png' }));
                    else d.setData('text/plain', 'text');
                    return d;
                }, files),
            });
        await drag('dragenter', false);
        assert.equal(await page.locator('[data-dragging]').count(), 0);
        await drag('dragenter', true);
        await drag('dragenter', true);
        await drag('dragleave', true);
        assert.equal(await page.locator('[data-dragging]').count(), 1);
        await drag('dragleave', true);
        assert.equal(await page.locator('[data-dragging]').count(), 0);
        await drag('dragenter', true);
        await page.dispatchEvent('body', 'dragend');
        assert.equal(await page.locator('[data-dragging]').count(), 0);
        await page.locator('#draft').fill('');
        await page.locator('#upload-files').setInputFiles([
            {
                name: 'valid.png',
                mimeType: 'image/png',
                buffer: Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=',
                    'base64',
                ),
            },
            { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') },
        ]);
        await page.getByRole('alertdialog', { name: 'Some files could not be uploaded' }).waitFor();
        assert.match(await page.locator('.warning-modal-message').innerText(), /invalid.txt/);
        assert(
            await page.evaluate(async () =>
                (await (await import('/chat-client/storage.js')).outbox()).some((i) =>
                    i.files?.some((f) => f.name === 'valid.png'),
                ),
            ),
        );
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#sidebar-button').click();
        const self = page.locator(`#dms [data-username="${name}"]`);
        await self.locator('.user-name').click();
        assert(
            await page
                .locator('.users-sidebar')
                .evaluate((n) => n.classList.contains('sidebar-open')),
        );
        await self.getByRole('button', { name: 'View profile' }).click();
        await page.locator('.profile-card-bio').waitFor();
        assert.equal(await page.locator('.profile-card-bio').innerText(), 'A tested profile');
        await page.screenshot({ path: out + '/profile-mobile.png', animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.locator('.sidebar-backdrop').click({ position: { x: 5, y: 100 } });
        await page.locator('#draft').fill('Recovery preserves draft');
        await page.waitForFunction(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            return (
                (await s.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                'Recovery preserves draft'
            );
        });
        const count = await page.evaluate(
            async () => (await (await import('/chat-client/storage.js')).outbox()).length,
        );
        await page.evaluate(() =>
            setTimeout(() => {
                throw Error('Recovery fixture');
            }, 0),
        );
        await page.getByRole('button', { name: 'Try Again', exact: true }).click();
        assert.equal(await page.locator('#recovery').isVisible(), false);
        assert.equal(await page.locator('#draft').inputValue(), 'Recovery preserves draft');
        await page.evaluate(() =>
            setTimeout(() => {
                throw Error('Recovery fixture');
            }, 0),
        );
        await page.getByRole('button', { name: 'Reload Page', exact: true }).click();
        await page.waitForFunction(
            () => document.querySelector('#draft')?.value === 'Recovery preserves draft',
        );
        assert.equal(
            await page.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length,
            ),
            count,
        );
        assert.deepEqual(errors, ['Recovery fixture', 'Recovery fixture']);
        console.log('PASS unexpected-error retry and offline reload preserve durable draft/outbox');
        console.log(
            'PASS configured/offline labels, history/admin fixtures, file-only nested drag/cancel, mixed-file warning with valid durable queue, mobile self-tap/profile; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
