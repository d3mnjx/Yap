const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:7643';
(async () => {
    const browser = await chromium.launch();
    try {
        const current = await browser.newContext(),
            page = await current.newPage(),
            errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const name = 'account' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(
            (await (await current.request.get(origin + '/api/chat/session')).json()).hasWayBack,
            true,
        );
        const second = await browser.newContext({ storageState: await current.storageState() }),
            other = await second.newPage();
        other.on('pageerror', (e) => errors.push(e.message));
        await other.goto(origin + '/lobby');
        await other.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await other.locator('#draft').fill('Retained on revoked device');
        await page.locator('#menu-button').click();
        await page.locator('[data-status="away"]').click();
        await page.locator('#menu-button.status-away').waitFor();
        await page.goto(origin + '/settings');
        await page.locator('.cache-group').first().waitFor({ state: 'attached' });
        await page.locator('.status-button.status-away').waitFor();
        await page.locator('.status-button').click();
        await page.getByRole('button', { name: 'Invisible', exact: true }).click();
        await other.locator('#menu-button.status-invisible').waitFor();
        const sessions = page
            .locator('.settings-section')
            .filter({ has: page.getByRole('heading', { name: 'Active Sessions', exact: true }) });
        await sessions.getByRole('button', { name: 'Sign out all other devices' }).waitFor();
        assert(!(await sessions.innerText()).includes('Unknown IP'));
        await sessions.getByRole('button', { name: 'Sign out all other devices' }).click();
        await page.waitForURL('**/settings?kicked=1').catch(async (error) => {
            console.log(
                'Navigation stopped at',
                new URL(page.url()).pathname,
                'status',
                await page.locator('.save-status').allTextContents(),
            );
            throw error;
        });
        await other
            .locator('#connection')
            .filter({ hasText: 'Sign in required' })
            .waitFor({ timeout: 45000 });
        assert.equal(await other.locator('#timeline .message-group').count(), 0);
        assert.equal((await second.request.get(origin + '/api/chat/session')).status(), 401);
        assert.equal((await current.request.get(origin + '/api/chat/session')).status(), 200);
        const locked = await other.evaluate(async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            return {
                locked: state.locked,
                draft: await s.draft(state.snapshot.conversations.find((c) => c.isDefault).id),
            };
        });
        assert.equal(locked.locked, true);
        assert.equal(locked.draft, 'Retained on revoked device');
        console.log(
            'PASS real Settings status handoff/session IP and sign-out-other-devices: current cookie survives, other session locks without exposing cached messages and retains draft',
        );
        await page.locator('.cache-group').first().waitFor({ state: 'attached' });
        const login = page
            .locator('.settings-section')
            .filter({ has: page.getByRole('heading', { name: 'Login Link', exact: true }) });
        await login.getByRole('button', { name: 'Revoke', exact: true }).click();
        await login.getByRole('button', { name: 'Create Login Link', exact: true }).waitFor();
        assert.equal(
            (await (await current.request.get(origin + '/api/chat/session')).json()).hasWayBack,
            false,
        );
        await page.goto(origin + '/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.locator('#draft').fill('Cancel signout keeps draft');
        let prompts = 0;
        page.on('dialog', async (dialog) => {
            prompts++;
            assert.match(dialog.message(), /no login link and no secret code/);
            await dialog.dismiss();
        });
        await page.locator('#menu-button').click();
        await page.locator('#signout').click();
        await page.waitForTimeout(300);
        assert.equal(prompts, 1);
        assert.equal(await page.locator('#draft').inputValue(), 'Cancel signout keeps draft');
        assert.equal((await current.request.get(origin + '/api/chat/session')).status(), 200);
        await current.setOffline(true);
        const offlineDialog = page.waitForEvent('dialog');
        await page.locator('#menu-button').click();
        await page.locator('#signout').click();
        await offlineDialog;
        assert.equal(prompts, 2);
        await current.setOffline(false);
        page.removeAllListeners('dialog');
        page.once('dialog', async (dialog) => dialog.accept());
        await page.locator('#menu-button').click();
        await page.locator('#signout').click();
        await page.waitForURL((url) => url.pathname === '/');
        assert.equal((await current.request.get(origin + '/api/chat/session')).status(), 401);
        assert.equal(
            await page.evaluate(
                async () => await (await import('/chat-client/storage.js')).readState(),
            ),
            undefined,
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS real revoked login link, original online/offline sign-out warning, cancel preservation and confirmed logout/cache purge; Chromium ' +
                browser.version(),
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
