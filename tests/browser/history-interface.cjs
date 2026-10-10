const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643',
    artifacts = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-history-browser';
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
        const name = 'history' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        const other = await browser.newContext(),
            buddy = await other.newPage();
        await buddy.goto(origin + '/login');
        await buddy.locator('.username-input').fill(name + 'b');
        await buddy.locator('.join-button').click();
        await buddy.waitForURL('**/lobby');
        await page.bringToFront();
        const session = await (await context.request.get(origin + '/api/chat/session')).json(),
            headers = { 'X-CSRF-TOKEN': session.csrfToken };
        const opened = await (
                await context.request.post(origin + '/api/chat/dm/' + name + 'b', {
                    headers,
                    data: {},
                })
            ).json(),
            id = opened.channelId;
        let first, last;
        for (let i = 0; i < 122; i++) {
            const response = await context.request.post(
                origin + `/api/chat/conversations/${id}/messages`,
                {
                    headers,
                    data: {
                        operationId: require('node:crypto').randomUUID(),
                        content: 'History fixture ' + i,
                        replyToMessageId: i === 121 ? first : undefined,
                    },
                },
            );
            assert.equal(response.status(), 200);
            const receipt = await response.json();
            first ??= receipt.messageId;
            last = receipt.messageId;
        }
        await page.goto(origin + '/dm/' + name + 'b');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(await page.locator('#msg-' + first).count(), 0);
        assert(
            (await page.locator('#msg-' + last + ' .reply-preview').innerText()).includes(
                'History fixture 0',
            ),
        );
        await page.locator('.messages').evaluate((n) => (n.scrollTop = 0));
        await page.locator('#msg-' + first).waitFor();
        assert.equal(await page.locator('#timeline .message-group').count(), 122);
        let historyRequests = 0;
        page.on('request', (request) => {
            if (request.url().includes('/history?')) historyRequests++;
        });
        const arrival = await context.request.post(
            origin + `/api/chat/conversations/${id}/messages`,
            {
                headers,
                data: {
                    operationId: require('node:crypto').randomUUID(),
                    content: 'History boundary arrival',
                },
            },
        );
        const arrivalId = (await arrival.json()).messageId;
        await page.locator('#msg-' + arrivalId).waitFor();
        assert.equal(await page.locator('#timeline .message-group').count(), 123);
        assert.equal(historyRequests, 0);
        console.log(
            'PASS arrival preserves loaded history and window boundary without a history request',
        );
        await page.locator('#msg-' + last + ' .reply-preview').click();
        await page.locator('#msg-' + first + '.highlight-message').waitFor();
        await context.setOffline(true);
        await page.reload();
        await page.locator('#msg-' + first).waitFor();
        assert.equal(await page.locator('#timeline .message-group').count(), 123);
        // Edit a message outside the server's recent window from another instance of the same account.
        const edit = await context.request.post(
            origin + `/api/chat/conversations/${id}/messages/${first}/actions`,
            {
                headers,
                data: {
                    operationId: require('node:crypto').randomUUID(),
                    kind: 'edit',
                    content: 'Older history updated',
                    active: false,
                },
            },
        );
        assert.equal(edit.status(), 200);
        await context.setOffline(false);
        await page.waitForFunction(
            (id) =>
                document
                    .getElementById('msg-' + id)
                    ?.querySelector('.message-content')
                    ?.textContent.includes('Older history updated'),
            first,
        );
        console.log(
            'PASS older history paging, loaded reply highlight, offline reload and older edit reconciliation',
        );
        // Older history must reconcile even if its invalidating snapshot arrived in another room.
        const removeId = await page.evaluate(
            async ({ id, first }) => {
                const pages = await (await import('/chat-client/storage.js')).metadata('history');
                return pages[id].messages.find((m) => m.id !== first).id;
            },
            { id, first },
        );
        await page.locator('#back').click();
        await page.locator('#draft:not([disabled])').waitFor();
        const inactiveEdit = await context.request.post(
            origin + `/api/chat/conversations/${id}/messages/${first}/actions`,
            {
                headers,
                data: {
                    operationId: require('node:crypto').randomUUID(),
                    kind: 'edit',
                    content: 'Inactive history updated',
                    active: false,
                },
            },
        );
        assert.equal(inactiveEdit.status(), 200);
        const inactiveDelete = await context.request.post(
            origin + `/api/chat/conversations/${id}/messages/${removeId}/actions`,
            {
                headers,
                data: {
                    operationId: require('node:crypto').randomUUID(),
                    kind: 'delete',
                    active: false,
                },
            },
        );
        assert.equal(inactiveDelete.status(), 200);
        const changedVersion = (await inactiveDelete.json()).update.conversations.find(
            (c) => c.id === id,
        ).state.contentVersion;
        await page.waitForFunction(
            async ({ id, changedVersion }) =>
                (
                    await (await import('/chat-client/storage.js')).readState()
                ).snapshot.conversations.find((c) => c.id === id).contentVersion >= changedVersion,
            { id, changedVersion },
        );
        await page.locator(`#dms a[href="/dm/${name + 'b'}"]`).click();
        await page.waitForFunction(
            (first) =>
                document
                    .getElementById('msg-' + first)
                    ?.textContent.includes('Inactive history updated'),
            first,
        );
        assert.equal(await page.locator('#msg-' + removeId).count(), 0);
        await context.setOffline(true);
        await page.reload();
        await page.locator('#msg-' + first).waitFor();
        assert(
            (await page.locator('#msg-' + first).innerText()).includes('Inactive history updated'),
        );
        assert.equal(await page.locator('#msg-' + removeId).count(), 0);
        await context.setOffline(false);
        console.log(
            'PASS inactive older edit/delete reconciled on navigation and preserved through offline reload',
        );
        // Clean storage verifies a reply jump can fetch a target that was never paged locally.
        const fresh = await browser.newContext({ storageState: await context.storageState() });
        const jump = await fresh.newPage();
        await jump.goto(origin + '/dm/' + name + 'b');
        await jump.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(await jump.locator('#msg-' + first).count(), 0);
        await jump.locator('#msg-' + last + ' .reply-preview').click();
        await jump.locator('#msg-' + first + '.highlight-message').waitFor();
        await fresh.close();
        await page.bringToFront();
        const person = page.locator(`#dms a[data-username="${name + 'b'}"]`);
        await person.locator('.user-name').hover();
        await page.getByRole('dialog', { name: 'Profile of ' + name + 'b', exact: true }).waitFor();
        assert((await page.locator('.profile-card').innerText()).includes('Member since'));
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#sidebar-button').click();
        await person.getByRole('button', { name: 'View profile', exact: true }).click();
        await page.locator('.profile-popup.is-mobile').waitFor();
        await page.waitForTimeout(200);
        await page.locator('.profile-popup.is-mobile .profile-card').waitFor();
        await page.screenshot({ path: artifacts + '/profile-mobile.png', animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.locator('.sidebar-backdrop').click({ position: { x: 10, y: 200 } });
        await page.locator('#emoji-button').click();
        await page.getByRole('textbox', { name: 'Search emojis', exact: true }).fill('grinning');
        await page
            .locator('.combined-tabs')
            .getByRole('button', { name: 'GIFs', exact: true })
            .click();
        await page.getByRole('dialog', { name: 'GIF picker' }).waitFor();
        await page.getByRole('textbox', { name: 'Search GIFs', exact: true }).fill('saved search');
        await page
            .locator('.combined-tabs')
            .getByRole('button', { name: 'Emoji', exact: true })
            .click();
        assert.equal(
            await page.getByRole('textbox', { name: 'Search emojis', exact: true }).inputValue(),
            'grinning',
        );
        await page.keyboard.press('Escape');
        console.log(
            'PASS uncached reply target jump, desktop/mobile profile, combined picker state',
        );
        const dates = await page.evaluate(async () => {
            const { timestamp } = await import('/chat-client/dates.js');
            const base = {
                zone: 'UTC+1',
                offsetMinutes: 60,
                time: 'h:mm tt',
                dateInYear: 'dd/MM',
                fullDate: 'dd/MM/yyyy',
                dateSeparator: '.',
                timeSeparator: ':',
                amDesignator: 'AM',
                pmDesignator: 'PM',
            };
            return [
                timestamp('2026-10-08T22:05:00Z', base, Date.parse('2026-10-09T10:00:00Z')),
                timestamp(
                    '2025-02-03T04:07:00Z',
                    { ...base, time: 'HH:mm' },
                    Date.parse('2026-10-09T10:00:00Z'),
                ),
            ];
        });
        assert.deepEqual(dates, ['Yesterday 11:05 PM', '03.02.2025 05:07']);
        // Cached preference fixtures exercise layouts without changing the retained account settings.
        await context.setOffline(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const theme of ['discord-dark', 'nord', 'teahouse']) {
            await page.evaluate(async (theme) => {
                const store = await import('/chat-client/storage.js'),
                    s = await store.readState();
                await store.commit(
                    { ...s.snapshot, theme, fontSize: 20, sequence: s.snapshot.sequence + 1 },
                    s,
                );
                const b = new BroadcastChannel('yap-chat-v1');
                b.postMessage('snapshot');
                b.close();
            }, theme);
            await page.waitForFunction(
                (theme) => document.documentElement.dataset.theme === theme,
                theme,
            );
            assert.equal(
                await page.locator('meta[name="theme-color"]').getAttribute('content'),
                await page.evaluate(
                    () => getComputedStyle(document.documentElement).backgroundColor,
                ),
            );
            await page.screenshot({ path: artifacts + '/' + theme + '.png' });
            assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                true,
            );
        }
        assert.deepEqual(errors, []);
        console.log(
            'PASS date/offset/separator cases and large-text theme layouts, Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
