// Dependency checks, not a latency benchmark: optional traffic is deliberately held open.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw new Error('Disposable local fixture required');
(async () => {
    const browser = await chromium.launch();
    let release;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    try {
        const contexts = await Promise.all(
            [0, 1].map(() => browser.newContext({ serviceWorkers: 'block' })),
        );
        const pages = await Promise.all(contexts.map((c) => c.newPage()));
        const names = ['comm_a', 'comm_b'].map((s) => s + Date.now().toString(36));
        for (let i = 0; i < pages.length; i++) {
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await pages[i].locator('#draft:not([disabled])').waitFor();
        }
        const [alice, bob] = pages;
        let catalogs = 0;
        await contexts[0].route('**/api/chat/catalog', async (route) => {
            catalogs++;
            await blocked;
            await route.abort();
        });
        await contexts[0].route('**/api/chat/windows/*', async (route) => {
            await blocked;
            await route.abort();
        });
        const requests = [];
        alice.on('request', (r) => {
            if (r.url().includes('/api/chat/')) requests.push({ url: r.url(), method: r.method() });
        });
        await alice.goto(origin + '/');
        assert.equal(await alice.locator('script[src*="blazor"]').count(), 0);
        await alice.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await alice.locator('#draft:not([disabled])').waitFor();
        assert.equal(requests.filter((r) => r.url.includes('/bootstrap?')).length, 1);
        assert(
            new URL(requests.find((r) => r.url.includes('/bootstrap?')).url).searchParams.has(
                'revision',
            ),
        );
        assert.equal(requests.filter((r) => r.url.endsWith('/session')).length, 0);
        requests.length = 0;
        await alice.locator('#draft').fill('Foreground while catalog blocked');
        const acceptance = alice.waitForResponse(
            (r) => r.request().method() === 'POST' && r.url().endsWith('/messages'),
        );
        await alice.locator('#send').click();
        assert.equal((await acceptance).status(), 200);
        await alice.waitForFunction(
            async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
        );
        assert.equal(
            requests.filter((r) => r.method === 'POST' && r.url.endsWith('/messages')).length,
            1,
        );
        assert.equal(requests.filter((r) => r.url.endsWith('/session')).length, 0);
        assert(catalogs > 0);
        console.log(
            'PASS one bootstrap; send uses one POST while catalog and inactive windows are blocked',
        );
        await bob.locator(`#dms a[href="/dm/${names[0]}"]`).click();
        await bob.locator('#draft:not([disabled])').waitFor();
        await bob.locator('#draft').fill('Inactive live arrival');
        await bob.locator('#send').click();
        await alice.waitForFunction(async (name) => {
            const state = await (await import('/chat-client/storage.js')).readState();
            return state.snapshot.conversations.some(
                (c) =>
                    c.path === '/dm/' + name &&
                    c.messages.some((m) => m.content === 'Inactive live arrival'),
            );
        }, names[1]);
        assert.equal(new URL(alice.url()).pathname, '/lobby');
        console.log(
            'PASS new inactive DM arrives over SignalR without waiting for a background window',
        );
        release();
        await Promise.all(contexts.map((c) => c.close()));
    } finally {
        release();
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
