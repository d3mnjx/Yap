const { readSnapshot } = require('./support/authority.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw new Error('Local test origin required');
const artifacts = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-phase3-browser';
fs.mkdirSync(artifacts, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        if (await check()) return;
        await pause(100);
    }
    throw new Error('Timed out waiting for presence/read acceptance');
}
(async () => {
    const browser = await chromium.launch();
    let pages = [];
    try {
        const names = ['pa', 'pb'].map((n) => n + Date.now().toString(36));
        const contexts = await Promise.all(
            names.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })),
        );
        pages = await Promise.all(contexts.map((c) => c.newPage()));
        const [alice, bob] = pages;
        const readSources = [];
        contexts[0].on('request', (request) => {
            if (request.method() === 'POST' && request.url().endsWith('/api/chat/reads'))
                readSources.push(...request.postDataJSON().map((marker) => marker.source));
        });
        const errors = [];
        for (let i = 0; i < 2; i++) {
            pages[i].on('pageerror', (e) => errors.push(e.message));
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await pages[i].waitForFunction(
                () => !document.querySelector('[data-status="online"]').disabled,
            );
        }
        const row = (page, name) => page.locator(`#dms [data-username="${name}"]`);
        await row(alice, names[1]).locator('.user-status-dot.online').waitFor();
        await row(bob, names[0]).click();
        await bob.waitForURL('**/dm/' + names[0]);
        await bob.locator('#draft:not([disabled])').waitFor();
        await bob.locator('#draft').fill('typing fixture');
        await pause(700);
        assert.equal(await alice.locator('#typing').isVisible(), false);
        await row(alice, names[1]).click();
        await alice.waitForURL('**/dm/' + names[1]);
        await bob.locator('#draft').fill('typing in DM now');
        await alice.locator('#typing').waitFor();
        assert((await alice.locator('#typing-text').innerText()).includes(names[1]));
        assert.equal(await bob.locator('#typing').isVisible(), false);
        await until(() => alice.locator('#typing').isHidden());
        await bob.locator('#draft').fill('typing before navigation');
        await alice.locator('#typing').waitFor();
        await bob.locator('#back').click();
        await until(() => alice.locator('#typing').isHidden());
        console.log(
            'PASS typing is private to the selected conversation, excludes self, expires and stops on navigation',
        );
        async function status(page, value) {
            await page.locator('#menu-button').click();
            await page.locator(`[data-status="${value}"]`).click();
            await page.locator('#menu-button.status-' + value).waitFor();
        }
        await status(bob, 'away');
        await row(alice, names[1]).locator('.user-status-dot.away').waitFor();
        await status(bob, 'invisible');
        await row(alice, names[1]).locator('.user-status-dot.invisible').waitFor();
        await status(bob, 'online');
        const sibling = await contexts[1].newPage();
        await sibling.goto(origin + '/lobby');
        await sibling.waitForFunction(
            () => !document.querySelector('[data-status="online"]').disabled,
        );
        await status(bob, 'away');
        await sibling.locator('#menu-button.status-away').waitFor();
        await sibling.close();
        await row(alice, names[1]).locator('.user-status-dot.away').waitFor();
        await status(bob, 'online');
        console.log(
            'PASS manual Online/Away/Invisible synchronize across tabs; closing a sibling retains presence',
        );
        await bob.goto(origin + '/dm/' + names[0]);
        await bob.waitForFunction(() => !document.querySelector('[data-status="online"]').disabled);
        const data = await readSnapshot(contexts[0].request, origin);
        const dm = data.conversations.find((c) => c.path === '/dm/' + names[1]);
        const unread = async () => {
            const s = await readSnapshot(contexts[0].request, origin);
            return s.conversations.find((c) => c.id === dm.id).unread;
        };
        const send = async (text) => {
            await bob.locator('#draft').fill(text);
            await bob.locator('#send').click();
            await until(() =>
                bob
                    .locator('#timeline .message-text')
                    .filter({ hasText: text })
                    .count()
                    .then((n) => n === 1),
            );
        };
        await alice.locator('#back').click();
        await send('background unread ' + names[0]);
        await until(() =>
            row(alice, names[1])
                .locator('.unread-badge')
                .textContent()
                .then((t) => t === '1'),
        );
        assert.equal(await alice.locator('#mailbox').isVisible(), true);
        await row(alice, names[1]).click();
        await until(async () => (await unread()) === 0);
        // An independent cookie context models another device, with its own local DB.
        const secondDevice = await browser.newContext({
            storageState: await contexts[0].storageState(),
        });
        const secondPage = await secondDevice.newPage();
        const streamedUnread = [];
        secondPage.on('websocket', (socket) =>
            socket.on('framereceived', ({ payload }) => {
                for (const part of String(payload).split('\x1e').filter(Boolean)) {
                    try {
                        const packet = JSON.parse(part);
                        for (const c of packet.item?.conversations || [])
                            if (c.id === dm.id && c.state) streamedUnread.push(c.state.unread);
                    } catch {}
                }
            }),
        );
        await secondPage.goto(origin + '/lobby');
        await secondPage.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        streamedUnread.length = 0;
        await send('foreground without badge flash ' + names[0]);
        await alice
            .locator('#timeline .message-text')
            .filter({ hasText: 'foreground without badge flash ' + names[0] })
            .waitFor();
        await pause(500);
        assert.equal(await unread(), 0);
        assert(streamedUnread.length > 0, 'Second device received the arrival metadata');
        assert(
            streamedUnread.every((count) => count === 0),
            'No transient unread increment reached the second device',
        );
        await secondDevice.close();
        console.log(
            'PASS foreground reading delivers messages without an unread flash on another device',
        );
        await status(alice, 'away');
        await send('manual Away retains unread ' + names[0]);
        await until(async () => (await unread()) === 1);
        await pause(700);
        assert.equal(await unread(), 1);
        await status(alice, 'online');
        await until(async () => (await unread()) === 0);
        // Deterministic visibility fixture; actual device lock/browser suspension remains device testing.
        async function hidden(page, value) {
            await page.evaluate((value) => {
                window.testHidden = value;
                Object.defineProperty(document, 'hidden', {
                    configurable: true,
                    get: () => window.testHidden,
                });
                document.dispatchEvent(new Event('visibilitychange'));
            }, value);
        }
        await hidden(alice, true);
        await pause(300);
        await send('hidden tab retains unread ' + names[0]);
        await until(async () => (await unread()) === 1);
        await hidden(alice, false);
        await until(async () => (await unread()) === 0);
        console.log(
            'PASS background badges/mailbox, explicit-open reads, manual Away and visibility-gated auto-read',
        );
        assert(
            ['open', 'arrival', 'resume'].every((source) => readSources.includes(source)),
            'Read writes distinguish navigation, arrival and resume in the audit',
        );
        console.log('PASS browser read writes retain open, arrival and resume sources');
        // Cache the unread first, open it offline, then deliver newer text before replaying the read.
        await alice.locator('#back').click();
        await send('observed before offline ' + names[0]);
        await until(() =>
            row(alice, names[1])
                .locator('.unread-badge')
                .textContent()
                .then((t) => t === '1'),
        );
        await alice.evaluate(() => navigator.serviceWorker.ready);
        await contexts[0].setOffline(true);
        await row(alice, names[1]).click();
        await until(() =>
            alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).reads()).length > 0,
            ),
        );
        await alice.locator('#back').click();
        await alice.reload();
        await alice.locator('#rooms a').first().waitFor();
        assert.equal(await alice.locator('.user-status-dot.online').count(), 0);
        assert.equal(await alice.locator('#typing').isVisible(), false);
        assert(
            await alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).reads()).length > 0,
            ),
        );
        await send('newer unseen during offline ' + names[0]);
        await contexts[0].setOffline(false);
        await until(() =>
            alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).reads()).length === 0,
            ),
        );
        await until(async () => (await unread()) === 1);
        await until(() =>
            row(alice, names[1])
                .locator('.unread-badge')
                .textContent()
                .then((t) => t === '1'),
        );
        await alice.screenshot({ path: artifacts + '/desktop.png', animations: 'disabled' });
        await alice.setViewportSize({ width: 390, height: 844 });
        await alice.locator('#mailbox').click();
        await row(alice, names[1]).click();
        await until(async () => (await unread()) === 0);
        await bob.locator('#draft').fill('mobile typing fixture');
        await alice.locator('#typing').waitFor();
        await alice.screenshot({ path: artifacts + '/mobile.png', animations: 'disabled' });
        console.log(
            'PASS offline read survives reload, reconnect preserves newer unread, offline presence/typing cleared, mobile mailbox opens DM',
        );
        await alice.setViewportSize({ width: 1440, height: 1000 });
        await alice.goto(origin + '/settings#notification-settings');
        const mute = alice
            .getByRole('radiogroup', { name: 'Direct messages', exact: true })
            .getByRole('radio', { name: 'Mute all', exact: true });
        await mute.click();
        await until(() => mute.evaluate((button) => button.classList.contains('seg-selected')));
        await alice.goto(origin + '/lobby');
        await alice.waitForFunction(
            () => !document.querySelector('[data-status="online"]').disabled,
        );
        await row(alice, names[1]).locator('.mute-bell').waitFor();
        const totalBefore = await alice.locator('#mailbox-count').textContent();
        await send('muted DM only gets a dot ' + names[0]);
        await row(alice, names[1]).locator('.unread-dot').waitFor();
        assert.equal(await row(alice, names[1]).locator('.unread-badge').count(), 0);
        assert.equal(await alice.locator('#mailbox-count').textContent(), totalBefore);
        await row(alice, names[1]).click();
        await until(async () => (await unread()) === 0);
        await bob.locator('#back').click();
        await send('muted room only gets a dot ' + names[0]);
        await alice.locator('#rooms a[href="/lobby"] .unread-dot').waitFor();
        assert.equal(await alice.locator('#rooms a[href="/lobby"] .mute-bell').count(), 0);
        console.log(
            'PASS actual Settings mute yields quiet DM/room dots, DM bell, no numeric badge or mailbox increase',
        );
        assert.deepEqual(errors, []);
        console.log('PASS Chromium ' + browser.version());
    } catch (error) {
        for (let i = 0; i < pages.length; i++)
            await pages[i]
                .screenshot({ path: artifacts + '/failure-' + i + '.png' })
                .catch(() => {});
        throw error;
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
