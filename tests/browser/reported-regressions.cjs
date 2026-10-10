const { fixturePage } = require('./support/authority.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643',
    mode = process.env.YAP_TEST_CASE || 'sessions';
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
            page = await fixturePage(context),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const username = 'report' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(username);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        if (mode === 'sessions') {
            for (let n = 0; n < 3; n++) {
                await page.goto(origin + '/settings');
                await page.waitForFunction(() => !!window._yapProbeTimer);
                await page.waitForTimeout(700);
                assert.equal(
                    await page.locator('.session-item').count(),
                    1,
                    'One connected tab must not include retained disconnected chat/circuits',
                );
                assert.equal(await page.locator('.session-item.current').count(), 1);
                await page.goto(origin + '/lobby');
                await page.waitForFunction(() =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced'),
                );
            }
            const sibling = await fixturePage(context);
            await sibling.goto(origin + '/lobby');
            await sibling.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            await page.goto(origin + '/settings');
            await page.waitForFunction(() => !!window._yapProbeTimer);
            await page.waitForFunction(
                () => document.querySelectorAll('.session-item').length === 2,
            );
            await sibling.close();
            await page.waitForFunction(
                () => document.querySelectorAll('.session-item').length === 1,
            );
            console.log(
                'PASS active-session counts across repeated Settings/chat/reloads, connected sibling and sibling closure',
            );
        } else if (mode === 'upload-online') {
            let release;
            const held = new Promise((resolve) => (release = resolve));
            await page.route('**/api/tus', async (route) => {
                await held;
                await route.continue();
            });
            await page.locator('.messages').evaluate((n) => (n.scrollTop = 0));
            const png = Buffer.from(
                await page.evaluate(() => {
                    const c = document.createElement('canvas');
                    c.width = 64;
                    c.height = 48;
                    c.getContext('2d').fillRect(0, 0, 64, 48);
                    return c.toDataURL('image/png').split(',')[1];
                }),
                'base64',
            );
            const choice = page.waitForEvent('filechooser');
            await page.locator('#upload-button').click();
            await (
                await choice
            ).setFiles({ name: 'scroll-online.png', mimeType: 'image/png', buffer: png });
            try {
                await page.locator('#pending progress').waitFor();
                await page.waitForTimeout(150);
                assert(
                    await page
                        .locator('.messages')
                        .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop < 3),
                    'Delayed upload progress must stay visible',
                );
            } finally {
                release();
            }
            await page.waitForFunction(
                () => !document.querySelector('#pending [data-operation]'),
                null,
                { timeout: 60000 },
            );
            // Removing the pending row precedes ResizeObserver's next-frame bottom adjustment.
            await page.waitForFunction(
                () => {
                    const n = document.querySelector('.messages');
                    return n.scrollHeight - n.clientHeight - n.scrollTop < 3;
                },
                null,
                { timeout: 2000 },
            );
            console.log(
                'PASS plus-button online upload stays visible through delayed tus progress and accepted image',
            );
        } else {
            await context.setOffline(true);
            await page.evaluate(async (username) => {
                const s = await import('/chat-client/storage.js'),
                    state = await s.readState(),
                    c = state.snapshot.conversations.find((c) => c.isDefault),
                    author = {
                        ...state.snapshot.user,
                        id: 'other-fixture',
                        username: 'other-fixture',
                    };
                c.hasMore = false;
                c.messages = Array.from({ length: 65 }, (_, i) => ({
                    id: 'scroll-fixture-' + i,
                    author,
                    content: 'Fixture ' + i + '\nEnough text to fill the timeline.',
                    timestamp: new Date(Date.now() - 70000 + i * 1000).toISOString(),
                    images: [],
                    videos: [],
                    reactions: [],
                }));
                const dest = {
                    ...c,
                    id: '11111111-2222-3333-4444-555555555555',
                    name: 'Fixture room',
                    path: '/room/11111111-2222-3333-4444-555555555555',
                    isDefault: false,
                    messages: c.messages.map((m) => ({ ...m, id: m.id + '-dest' })),
                };
                state.snapshot.conversations.push(dest);
                await s.saveDraft(dest.id, 'Restored destination draft', state);
                await s.commitUpdate(
                    window.fixtureUpdate({
                        ...state.snapshot,
                        sequence: state.snapshot.sequence + 1,
                    }),
                    state,
                );
                const b = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
                b.postMessage('snapshot');
                b.close();
            }, username);
            await page.locator('#msg-scroll-fixture-64').waitFor();
            if (mode === 'menu') {
                const row = page.locator('#msg-scroll-fixture-64');
                await row.hover();
                await row.getByTitle('More', { exact: true }).click();
                await page.getByRole('button', { name: 'Copy Text', exact: true }).waitFor();
                await page.mouse.move(20, 20);
                await page.waitForTimeout(250);
                assert.equal(
                    await row
                        .locator('.message-actions')
                        .evaluate((n) => getComputedStyle(n).opacity),
                    '1',
                    'Open More must retain action bar when backdrop removes hover',
                );
                assert.equal(
                    await page.getByRole('button', { name: 'Delete Message', exact: true }).count(),
                    0,
                );
                await page.keyboard.press('Escape');
                assert.equal(await row.evaluate((n) => n.classList.contains('menu-open')), false);
                console.log(
                    'PASS other-author More retains action bar and offers only Copy; dismissal clears menu state',
                );
                await page.locator('#draft').fill('Queued menu fixture');
                await page.locator('#send').click();
                const queued = page.locator('#pending .pending-message').last();
                await queued.hover();
                await queued.getByTitle('More', { exact: true }).click();
                await page.getByRole('button', { name: 'Delete Message', exact: true }).waitFor();
                await page.mouse.move(20, 20);
                await page.waitForTimeout(150);
                assert.equal(
                    await queued
                        .locator('.message-actions')
                        .evaluate((n) => getComputedStyle(n).opacity),
                    '1',
                );
                await page.evaluate(() => {
                    const b = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
                    b.postMessage('outbox');
                    b.close();
                });
                await page.waitForTimeout(150);
                assert.equal(
                    await queued
                        .locator('.message-actions')
                        .evaluate((n) => getComputedStyle(n).opacity),
                    '1',
                );
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('.message-group.menu-open').count(), 0);
                console.log(
                    'PASS own queued More retains Copy/Delete and its action bar through pending-row replacement',
                );
            } else if (mode === 'upload') {
                await page.locator('.messages').evaluate((n) => (n.scrollTop = 0));
                const png = Buffer.from(
                    await page.evaluate(() => {
                        const c = document.createElement('canvas');
                        c.width = 64;
                        c.height = 48;
                        c.getContext('2d').fillRect(0, 0, 64, 48);
                        return c.toDataURL('image/png').split(',')[1];
                    }),
                    'base64',
                );
                const choice = page.waitForEvent('filechooser');
                await page.locator('#upload-button').click();
                await (
                    await choice
                ).setFiles({ name: 'scroll.png', mimeType: 'image/png', buffer: png });
                await page.locator('#pending [data-operation]').waitFor();
                await page.waitForTimeout(150);
                assert(
                    await page
                        .locator('.messages')
                        .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop < 3),
                    'New attachment must be visible even when composed while scrolled up',
                );
                console.log('PASS plus-button queued attachment scrolls into view');
            } else if (mode === 'media') {
                const destination = page.locator(
                    '#rooms a[href="/room/11111111-2222-3333-4444-555555555555"]',
                );
                await destination.click();
                await page.locator('#draft:not([disabled])').waitFor();
                await page.waitForTimeout(100);
                const grow = () =>
                    page.evaluate(async () => {
                        const img = new Image();
                        img.style.cssText = 'display:block;width:240px;height:auto';
                        document
                            .querySelector('#timeline .message-group:last-child .message-content')
                            .append(img);
                        await new Promise((resolve) => setTimeout(resolve, 120));
                        img.src =
                            'data:image/svg+xml,' +
                            encodeURIComponent(
                                '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="900"><rect width="240" height="900" fill="teal"/></svg>',
                            );
                        await img.decode();
                    });
                await grow();
                await page.waitForTimeout(100);
                assert(
                    await page
                        .locator('.messages')
                        .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop < 3),
                    'Late media height must keep navigation at bottom',
                );
                await page.locator('.messages').evaluate((n) => (n.scrollTop = 100));
                await page.waitForTimeout(80);
                const top = await page.locator('.messages').evaluate((n) => n.scrollTop);
                await grow();
                await page.waitForTimeout(100);
                assert(
                    Math.abs((await page.locator('.messages').evaluate((n) => n.scrollTop)) - top) <
                        3,
                    'Late media must not yank a reader away from older messages',
                );
                console.log(
                    'PASS delayed image layout follows navigation bottom and respects subsequent upward reading',
                );
            } else if (mode === 'navigation') {
                await page.evaluate(() => {
                    const original = IDBObjectStore.prototype.getAll;
                    window.releaseOutbox = null;
                    IDBObjectStore.prototype.getAll = function (...args) {
                        const request = original.apply(this, args);
                        if (this.name !== 'outbox') return request;
                        IDBObjectStore.prototype.getAll = original;
                        const delayed = {
                            get result() {
                                return request.result;
                            },
                            get error() {
                                return request.error;
                            },
                        };
                        request.onsuccess = () => {
                            window.releaseOutbox = () => delayed.onsuccess?.();
                        };
                        request.onerror = () => delayed.onerror?.();
                        return delayed;
                    };
                });
                await page
                    .locator('#rooms a[href="/room/11111111-2222-3333-4444-555555555555"]')
                    .click();
                await page.waitForFunction(() => !!window.releaseOutbox);
                await page.evaluate(async () => {
                    const s = await import('/chat-client/storage.js'),
                        state = await s.readState();
                    await s.commitUpdate(
                        window.fixtureUpdate({
                            ...state.snapshot,
                            sequence: state.snapshot.sequence + 1,
                        }),
                        state,
                    );
                    const b = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
                    b.postMessage('snapshot');
                    b.close();
                });
                await page.locator('#msg-scroll-fixture-64-dest').waitFor();
                await page.evaluate(() => window.releaseOutbox());
                await page.waitForTimeout(250);
                assert.equal(
                    await page.locator('#draft').isDisabled(),
                    false,
                    'An overlapping snapshot must not cancel navigation draft restoration',
                );
                assert.equal(
                    await page.locator('#draft').inputValue(),
                    'Restored destination draft',
                );
                assert(
                    await page
                        .locator('.messages')
                        .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop < 3),
                );
                console.log(
                    'PASS overlapping snapshot/navigation completes draft restoration and bottom scroll',
                );
            }
        }
        assert.deepEqual(errors, []);
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
