const { poll } = require('./support/wait.cjs');
const { fixturePage } = require('./support/authority.cjs');
// Reopen with aged local authentication metadata; standalone mode is a browser fixture,
// not an assertion about iOS/Android suspension or storage retention.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Disposable local fixture required');
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        await context.addInitScript(() => {
            const native = matchMedia.bind(window);
            window.matchMedia = (q) => {
                const result = native(q);
                if (q.includes('display-mode: standalone'))
                    Object.defineProperty(result, 'matches', { value: true });
                return result;
            };
        });
        let page = await fixturePage(context);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill('pwareturn' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(
            () =>
                document.querySelector('#connection')?.textContent === 'Synced · available offline',
        );
        const user = await page.evaluate(
            async () => (await (await import('/chat-client/storage.js')).readState()).userId,
        );
        await page.locator('#draft').fill('Draft kept for four weeks');
        await poll(page, async () => {
            const s = await import('/chat-client/storage.js'),
                state = await s.readState();
            return (
                (await s.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                'Draft kept for four weeks'
            );
        });
        async function age() {
            await context.setOffline(true);
            await page.evaluate(async () => {
                await navigator.locks.request(window.fixtureConstants.ACCOUNT_LOCK, async () => {
                    const db = await new Promise((resolve, reject) => {
                        const r = indexedDB.open(
                            window.fixtureConstants.DB_NAME,
                            window.fixtureConstants.DB_VERSION,
                        );
                        r.onsuccess = () => resolve(r.result);
                        r.onerror = () => reject(r.error);
                    });
                    await new Promise((resolve, reject) => {
                        const tx = db.transaction('state', 'readwrite'),
                            store = tx.objectStore('state'),
                            r = store.get('active');
                        r.onsuccess = () =>
                            store.put(
                                { ...r.result, authenticatedAt: Date.now() - 28 * 86400000 },
                                'active',
                            );
                        tx.oncomplete = resolve;
                        tx.onerror = () => reject(tx.error);
                    });
                    db.close();
                });
            });
            await page.close();
        }
        await age();
        await context.setOffline(false);
        page = await fixturePage(context);
        await page.goto(origin + '/pwa-launch');
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(await page.locator('#draft').inputValue(), 'Draft kept for four weeks');
        assert.equal(
            await page.evaluate(
                async () => (await (await import('/chat-client/storage.js')).readState()).userId,
            ),
            user,
        );
        console.log(
            'PASS standalone online return with 28-day-old local state keeps the account and draft without sign-in',
        );
        const length = await page.evaluate(async () => {
            const api = await import('/chat-client/api.js'),
                session = await api.get('session');
            api.useSession({ ...session, csrfToken: 'deliberately-invalid-fixture-token' });
            return session.csrfToken.length;
        });
        const statuses = [];
        let refreshes = 0;
        page.on('response', (r) => {
            if (r.url().endsWith('/messages') && r.request().method() === 'POST')
                statuses.push(r.status());
        });
        page.on('request', (r) => {
            if (r.url().endsWith('/api/chat/session')) refreshes++;
        });
        const text = 'Recovered token ' + Date.now();
        await page.locator('#draft').fill(text);
        await page.locator('#send').click();
        await page.locator('#timeline .message-content').filter({ hasText: text }).waitFor();
        await poll(
            page,
            async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
        );
        assert.deepEqual(statuses, [403, 200]);
        assert.equal(refreshes, 1);
        assert.equal(
            await page.locator('#timeline .message-content').filter({ hasText: text }).count(),
            1,
        );
        console.log(
            `PASS rejected token refreshes once and sends exactly once; observed token length ${length} characters`,
        );
        await page.evaluate(async (userId) => {
            const bytes = Uint8Array.from(
                atob(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=',
                ),
                (c) => c.charCodeAt(0),
            );
            await (
                await caches.open(window.fixtureConstants.MEDIA_CACHE_PREFIX + userId)
            ).put(
                '/uploads/pwa-age-fixture.png',
                new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
            );
        }, user);
        await age();
        page = await fixturePage(context);
        await page.goto(origin + '/lobby');
        await page.locator('#draft:not([disabled])').waitFor();
        await page.locator('#timeline .message-content').filter({ hasText: text }).waitFor();
        console.log(
            'PASS standalone offline return after 28 days opens cached messages without an age limit',
        );
        assert(await page.evaluate(async () => (await fetch('/uploads/pwa-age-fixture.png')).ok));
        console.log('PASS cached media remains available after 28 days offline');
        await page.evaluate(async () => (await import('/chat-client/storage.js')).lockAccount());
        await page.reload();
        await page.waitForFunction(
            () => document.querySelector('#connection')?.textContent === 'Connect to continue',
        );
        assert.equal(
            await page.locator('#timeline .message-content').filter({ hasText: text }).count(),
            0,
        );
        assert.equal(
            await page.evaluate(async () =>
                fetch('/uploads/pwa-age-fixture.png')
                    .then((r) => r.ok)
                    .catch(() => false),
            ),
            false,
        );
        console.log('PASS known revocation still locks cached messages and media');
        await context.close();
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
