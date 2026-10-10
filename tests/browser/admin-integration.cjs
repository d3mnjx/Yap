const { readSnapshot } = require('./support/authority.cjs');
// Use a fresh isolated server: its first permitted account becomes admin. Never target development data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict');
const origin = process.env.YAP_ADMIN_TEST_ORIGIN || 'http://127.0.0.1:7743';
if (new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port === '7543')
    throw Error('Dedicated local fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const admin = await browser.newContext(),
            page = await admin.newPage(),
            member = await browser.newContext(),
            reader = await member.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        reader.on('pageerror', (e) => errors.push(e.message));
        const suffix = Date.now().toString(36),
            name = 'admin' + suffix,
            other = 'member' + suffix;
        async function login(p, n) {
            await p.goto(origin + '/login');
            await p.locator('.username-input').fill(n);
            await p.locator('.join-button').click();
            await p.waitForURL('**/lobby');
            await p.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
        }
        await login(page, name);
        assert(
            (await readSnapshot(admin.request, origin)).isAdmin,
            'This test requires a fresh server with no existing admin',
        );
        await login(reader, other);
        await page.locator('a.add-room').click();
        await page.waitForFunction(() => !!window._yapProbeTimer);
        await page.locator('#channel-name').fill('parity-room');
        await page.locator('#channel-description').fill('A real administered room');
        await page.locator('select.form-input').selectOption('Unlimited');
        await page.getByRole('checkbox').uncheck();
        await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
        await page.waitForURL('**/room/*');
        await page.locator('#draft:not([disabled])').waitFor();
        const path = new URL(page.url()).pathname,
            id = path.split('/').at(-1);
        await reader.goto(origin + path);
        await reader.locator('#draft:not([disabled])').waitFor();
        assert.equal(await reader.locator('#history-note').innerText(), 'A real administered room');
        await page.locator(`#rooms a[data-channel="${id}"] .room-settings`).click();
        await page.waitForFunction(() => !!window._yapProbeTimer);
        await page.locator('.permission-card').filter({ hasText: 'Admin Only' }).click();
        await page.locator('select.form-input').selectOption('OneDay');
        await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await page.locator('#draft:not([disabled])').waitFor();
        await reader.locator('#permission-note').waitFor();
        assert.equal(await reader.locator('.message-input-container').isVisible(), false);
        await reader.waitForFunction(
            () =>
                document.querySelector('#history-note')?.textContent ===
                'Older messages are not available in this channel',
        );
        const session = await (await member.request.get(origin + '/api/chat/session')).json();
        assert.equal(
            (
                await member.request.post(origin + `/api/chat/conversations/${id}/messages`, {
                    headers: { 'X-CSRF-TOKEN': session.csrfToken },
                    data: {
                        operationId: require('node:crypto').randomUUID(),
                        content: 'forbidden',
                    },
                })
            ).status(),
            403,
        );
        await page.locator(`#rooms a[data-channel="${id}"] .room-settings`).click();
        await page.waitForFunction(() => !!window._yapProbeTimer);
        await page.getByRole('button', { name: 'Delete Channel', exact: true }).click();
        await page.getByRole('button', { name: 'Click again to confirm', exact: true }).click();
        await page.waitForURL('**/lobby');
        await page.locator('#draft:not([disabled])').waitFor();
        await reader.locator('#history-note').filter({ hasText: 'no longer accessible' }).waitFor();
        await page
            .locator('#rooms a.room-item')
            .filter({ hasText: 'lobby' })
            .getByRole('button', { name: 'Channel settings' })
            .click();
        await page.waitForFunction(() => !!window._yapProbeTimer);
        assert.equal(
            await page.getByRole('button', { name: 'Delete Channel', exact: true }).count(),
            0,
        );
        await page.locator('.settings-header .channelsettings-back-button').click();
        await page.waitForURL('**/lobby');
        await page.locator('#draft:not([disabled])').waitFor();
        console.log(
            'PASS real admin create/edit/delete/default-room restrictions, Server-to-client return, live member read-only/history changes and server write rejection',
        );
        await page.goto(origin + '/settings');
        await page.waitForFunction(() => !!window._yapProbeTimer);
        await page.locator('.users-list .user-item').filter({ hasText: other }).click();
        await page.waitForURL('**/dm/' + other);
        await page.locator('#draft:not([disabled])').waitFor();
        await page.goto(origin + '/admin');
        await page.locator('.admin-sidebar-header .admin-back-button').click();
        await page.waitForURL('**/lobby');
        await page.locator('#draft:not([disabled])').waitFor();
        await reader.goto(origin + '/admin');
        await reader.waitForURL('**/lobby');
        await reader.locator('#draft:not([disabled])').waitFor();
        assert.deepEqual(errors, []);
        console.log(
            'PASS retained Settings sidebar DM navigation, Admin back and non-admin redirect into client; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
