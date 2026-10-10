const { poll } = require('./support/wait.cjs');
const { readSnapshot } = require('./support/authority.cjs');
const { fixturePage } = require('./support/authority.cjs');
// Run only against an isolated local instance. Creates synthetic accounts through the actual UI.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
    throw new Error('Local test server required');
const artifacts = process.env.YAP_TEST_ARTIFACTS || '/tmp/yap-phase2-browser';
fs.mkdirSync(artifacts, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        if (await check()) return;
        await pause(100);
    }
    throw new Error('Timed out waiting for acceptance');
}
const suffix = Date.now().toString(36),
    names = ['a', 'b'].map((n) => 'send' + n + suffix);
(async () => {
    const browser = await chromium.launch();
    let pages = [];
    try {
        const contexts = await Promise.all(
            names.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })),
        );
        pages = await Promise.all(contexts.map((c) => fixturePage(c)));
        const [alice, bob] = pages;
        const errors = [];
        for (let i = 0; i < pages.length; i++) {
            pages[i].on('pageerror', (e) => errors.push(e.message));
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await pages[i].waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            assert.equal(await pages[i].locator('script[src*="blazor"]').count(), 0);
        }
        const bootstrap = await readSnapshot(contexts[0].request, origin);
        const lobbyId = bootstrap.conversations.find((c) => c.isDefault).id;
        for (const route of ['/chat', '/room/' + lobbyId]) {
            await alice.goto(origin + route);
            await alice.waitForURL('**/lobby');
            await alice.locator('#draft:not([disabled])').waitFor();
        }
        const text = (label) => label + ' ' + suffix;
        async function send(page, value) {
            await page.locator('#draft').fill(value);
            await page.locator('#send').click();
        }
        async function confirmed(page, value) {
            await until(() =>
                page
                    .locator('#timeline .message-text')
                    .filter({ hasText: value })
                    .count()
                    .then((n) => n === 1),
            );
        }
        await bob.locator(`#dms a[href="/dm/${names[0]}"]`).click();
        await bob.locator('#draft:not([disabled])').waitFor();
        await send(bob, text('first DM'));
        await confirmed(bob, text('first DM'));
        await until(() =>
            alice.evaluate(async (name) => {
                const s = await (await import('/chat-client/storage.js')).readState();
                return s.snapshot.conversations.some(
                    (c) => c.path === '/dm/' + name && c.messages.length > 0,
                );
            }, names[1]),
        );
        assert.equal(new URL(alice.url()).pathname, '/lobby');
        await alice.locator(`#dms a[href="/dm/${names[1]}"]`).click();
        await confirmed(alice, text('first DM'));
        const dmId = await alice.evaluate(async () => {
            const s = await (await import('/chat-client/storage.js')).readState();
            return s.snapshot.conversations.find((c) => c.path === location.pathname).id;
        });
        await alice.goto(origin + '/dm/' + names[1]);
        await alice.waitForURL('**/dm/' + names[1]);
        await alice.evaluate(() => navigator.serviceWorker.ready);
        await alice.locator('#back').click();
        await alice.waitForURL('**/lobby');
        await alice.goBack();
        await alice.waitForURL('**/dm/' + names[1]);
        await alice.goForward();
        await alice.waitForURL('**/lobby');
        await alice.goBack();
        await alice.waitForURL('**/dm/' + names[1]);
        console.log(
            'PASS normal routes, login, new DM, background delivery and direct DM navigation',
        );
        // A send must not fire during IME composition; desktop Shift+Enter inserts a newline.
        await alice.locator('#draft').fill('IME draft');
        await alice
            .locator('#draft')
            .dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
        assert.equal(await alice.locator('#draft').inputValue(), 'IME draft');
        await alice.locator('#draft').press('Shift+Enter');
        assert((await alice.locator('#draft').inputValue()).includes('\n'));
        await send(alice, text('online predecessor'));
        await confirmed(alice, text('online predecessor'));
        await contexts[0].setOffline(true);
        await send(alice, text('offline once'));
        await alice.locator('#pending [data-operation]').waitFor();
        assert.equal(
            await alice
                .locator('#pending .avatar, #pending .message-meta, #pending .delivery-status')
                .count(),
            0,
        );
        const operation = await alice
            .locator('#pending [data-operation]')
            .getAttribute('data-operation');
        assert.equal(await alice.locator('#draft').inputValue(), '');
        await alice.locator('#draft').fill('draft after queue');
        await poll(alice, async () => {
            const store = await import('/chat-client/storage.js');
            const { snapshot } = await store.readState();
            const channel = snapshot.conversations.find((c) => c.path === location.pathname);
            return (
                channel &&
                (await store.draft(channel.id)) === document.querySelector('#draft').value
            );
        });
        await alice.reload();
        await alice.locator(`[data-operation="${operation}"]`).waitFor();
        assert.equal(await alice.locator('#draft').inputValue(), 'draft after queue');
        const second = await fixturePage(contexts[0]);
        await second.goto(origin + '/dm/' + names[1]);
        await second.locator(`[data-operation="${operation}"]`).waitFor();
        await contexts[0].setOffline(false);
        await confirmed(alice, text('offline once'));
        await confirmed(bob, text('offline once'));
        await until(() =>
            alice
                .locator('#pending [data-operation]')
                .count()
                .then((n) => n === 0),
        );
        assert.equal(
            await alice
                .locator('#timeline .message-group')
                .filter({ hasText: text('offline once') })
                .locator('.avatar, .message-meta')
                .count(),
            0,
        );
        assert.equal(await alice.locator('#draft').inputValue(), 'draft after queue');
        assert.equal(
            await second
                .locator('#timeline .message-text')
                .filter({ hasText: text('offline once') })
                .count(),
            1,
        );
        await second.close();
        console.log(
            'PASS offline enqueue/reload/reconnect exactly once across two sender tabs; draft retained',
        );
        // Isolate HTTP fault injection from service-worker-owned requests.
        const probeContext = await browser.newContext({
            storageState: await contexts[0].storageState(),
            serviceWorkers: 'block',
        });
        await probeContext.addInitScript(() => {
            ServiceWorkerContainer.prototype.register = async () => {
                throw new Error('Worker disabled for network fault injection');
            };
        });
        const probe = await fixturePage(probeContext);
        await probe.goto(origin + '/dm/' + names[1]);
        await probe.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        // Commit on server, but hold HTTP acknowledgement until the real live stream reconciles it.
        let release;
        const held = new Promise((r) => (release = r));
        let heldCommitted = false;
        await probeContext.route('**/api/chat/conversations/*/messages', async (route) => {
            if (route.request().postDataJSON().content === text('stream first')) {
                const response = await route.fetch();
                heldCommitted = true;
                await held;
                await route.fulfill({ response });
            } else await route.continue();
        });
        await send(probe, text('stream first'));
        await until(() => heldCommitted);
        await confirmed(probe, text('stream first'));
        assert.equal(await probe.locator('#pending [data-operation]').count(), 0);
        release();
        await probeContext.unrouteAll({ behavior: 'wait' });
        // A terminal rejection keeps its text; retry uses precisely the same operation ID.
        await probe.evaluate(() => {
            window.originalFetch = window.fetch;
            window.fetch = (url, options) => {
                if (String(url).endsWith('/messages')) {
                    window.rejectedId = JSON.parse(options.body).operationId;
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                code: 'read_only',
                                error: 'Fixture permission denied',
                            }),
                            { status: 403, headers: { 'Content-Type': 'application/json' } },
                        ),
                    );
                }
                return window.originalFetch(url, options);
            };
        });
        await send(probe, text('retry same ID'));
        await probe.locator('.delivery-status.failed').waitFor();
        assert((await probe.locator('#pending').innerText()).includes(text('retry same ID')));
        await probe.evaluate(() => {
            window.fetch = (url, options) => {
                if (String(url).endsWith('/messages'))
                    window.retriedId = JSON.parse(options.body).operationId;
                return window.originalFetch(url, options);
            };
        });
        await probe.locator('.retry-send').click();
        await confirmed(probe, text('retry same ID'));
        assert.equal(await probe.evaluate(() => window.rejectedId === window.retriedId), true);
        console.log('PASS stream-before-ack reconciliation and failed-send retry with stable ID');
        // Authoritative conversation-removal fixture: failed text remains reachable after metadata disappears.
        await probe.evaluate(() => {
            window.fetch = (url, options) =>
                String(url).endsWith('/messages')
                    ? Promise.resolve(
                          new Response(
                              JSON.stringify({
                                  code: 'conversation_unavailable',
                                  error: 'Conversation removed',
                              }),
                              { status: 404, headers: { 'Content-Type': 'application/json' } },
                          ),
                      )
                    : window.originalFetch(url, options);
        });
        await send(probe, text('removed conversation'));
        await probe.locator('.delivery-status.failed').waitFor();
        await probeContext.setOffline(true);
        await probe.evaluate(async (id) => {
            const store = await import('/chat-client/storage.js');
            const state = await store.readState();
            await store.commitUpdate(
                window.fixtureUpdate({
                    ...state.snapshot,
                    sequence: state.snapshot.sequence + 1,
                    conversations: state.snapshot.conversations.filter((c) => c.id !== id),
                }),
                state,
            );
            const channel = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
            channel.postMessage('snapshot');
            channel.close();
        }, dmId);
        await probe.locator('#outgoing a').click();
        await probe
            .locator('#pending .message-content')
            .filter({ hasText: text('removed conversation') })
            .waitFor();
        await probe.locator('#pending .retry-send').waitFor();
        console.log('PASS failed text remains accessible when its conversation disappears');
        await probeContext.close();
        await alice.locator('#draft').fill('settings roundtrip draft');
        await poll(alice, async () => {
            const store = await import('/chat-client/storage.js');
            const { snapshot } = await store.readState();
            const channel = snapshot.conversations.find((c) => c.path === location.pathname);
            return (
                channel &&
                (await store.draft(channel.id)) === document.querySelector('#draft').value
            );
        });
        await alice.goto(origin + '/settings');
        await alice.goBack();
        await alice.locator('#send').waitFor();
        await until(() =>
            alice
                .locator('#draft')
                .inputValue()
                .then((v) => v === 'settings roundtrip draft'),
        );
        await alice.screenshot({ path: artifacts + '/desktop.png' });
        await alice.setViewportSize({ width: 390, height: 844 });
        await alice.screenshot({ path: artifacts + '/mobile.png', animations: 'disabled' });
        // Separate browser storage, same synthetic cookie: migrate a real v1 IDB before the new client opens.
        const upgrade = await browser.newContext({
            storageState: await contexts[0].storageState(),
        });
        const up = await fixturePage(upgrade);
        await up.goto(origin + '/icon.svg');
        const seed = await alice.evaluate(async () =>
            (await import('/chat-client/storage.js')).readState(),
        );
        await up.evaluate(
            async ({ seed, dmId }) =>
                new Promise((resolve, reject) => {
                    const req = indexedDB.open(window.fixtureConstants.DB_NAME, 1);
                    req.onupgradeneeded = () => {
                        req.result.createObjectStore('state');
                        req.result.createObjectStore('drafts');
                    };
                    req.onsuccess = () => {
                        const tx = req.result.transaction(['state', 'drafts'], 'readwrite');
                        tx.objectStore('state').put(seed, 'active');
                        tx.objectStore('drafts').put('v1 retained draft', dmId);
                        tx.oncomplete = () => {
                            req.result.close();
                            resolve();
                        };
                    };
                    req.onerror = () => reject(req.error);
                }),
            { seed, dmId },
        );
        await up.goto(origin + '/dm/' + names[1]);
        await until(() =>
            up
                .locator('#draft')
                .inputValue()
                .then((v) => v === 'v1 retained draft'),
        );
        assert.equal(
            await up.evaluate(
                async () =>
                    (await indexedDB.databases()).find(
                        (d) => d.name === window.fixtureConstants.DB_NAME,
                    ).version,
            ),
            4,
        );
        await up.evaluate(() => {
            const original = window.fetch;
            window.fetch = (url, options) =>
                String(url).endsWith('/messages')
                    ? Promise.reject(new TypeError('Send transport unavailable'))
                    : original(url, options);
        });
        await send(up, text('queued through worker update'));
        await up.locator('#pending [data-operation]').waitFor();
        await up.evaluate(async () => {
            const manifest = await (
                await fetch('/chat-client/manifest.json', { cache: 'no-store' })
            ).json();
            await navigator.serviceWorker.register(
                '/service-worker-module.js?v=' + manifest.version + '&phase2-update',
                {
                    scope: '/',
                    type: 'module',
                    updateViaCache: 'none',
                },
            );
        });
        await until(() =>
            up.evaluate(async () => {
                const r = await navigator.serviceWorker.getRegistration('/');
                return (
                    r?.active?.scriptURL.includes('phase2-update') && r.active.state === 'activated'
                );
            }),
        );
        assert.equal(
            await up.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length,
            ),
            1,
        );
        await up.locator('#menu-button').click();
        up.once('dialog', (dialog) => dialog.accept());
        await up.locator('#forget').click();
        await until(() =>
            up.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
            ),
        );
        await upgrade.close();
        console.log(
            'PASS Settings return, schema upgrade preserving drafts, worker update preserving queue, explicit purge',
        );
        // Real schema-2 database: retain the durable send outbox when adding observed-read checkpoints.
        const v2 = await browser.newContext({ storageState: await contexts[0].storageState() });
        const v2page = await fixturePage(v2);
        await v2page.addInitScript(() => {
            const fetchOriginal = window.fetch;
            window.fetch = (url, options) =>
                String(url).endsWith('/messages')
                    ? Promise.reject(new TypeError('Hold migration send offline'))
                    : fetchOriginal(url, options);
        });
        await v2page.goto(origin + '/icon.svg');
        await v2page.evaluate(
            async ({ seed, dmId }) =>
                new Promise((resolve, reject) => {
                    const req = indexedDB.open(window.fixtureConstants.DB_NAME, 2);
                    req.onupgradeneeded = () => {
                        for (const name of ['state', 'drafts', 'outbox'])
                            req.result.createObjectStore(name);
                    };
                    req.onerror = () => reject(req.error);
                    req.onsuccess = () => {
                        const tx = req.result.transaction(
                            ['state', 'drafts', 'outbox'],
                            'readwrite',
                        );
                        tx.objectStore('state').put(seed, 'active');
                        tx.objectStore('drafts').put('v2 retained draft', dmId);
                        const operationId = crypto.randomUUID();
                        tx.objectStore('outbox').put(
                            {
                                operationId,
                                channelId: dmId,
                                content: 'v2 queued text',
                                status: 'queued',
                                createdAt: Date.now(),
                            },
                            operationId,
                        );
                        tx.oncomplete = () => {
                            req.result.close();
                            resolve();
                        };
                        tx.onerror = () => reject(tx.error);
                    };
                }),
            { seed, dmId },
        );
        await v2page.goto(origin + '/dm/' + names[1]);
        await until(() =>
            v2page
                .locator('#draft')
                .inputValue()
                .then((v) => v === 'v2 retained draft'),
        );
        await v2page
            .locator('#pending .message-content')
            .filter({ hasText: 'v2 queued text' })
            .waitFor();
        assert.equal(
            await v2page.evaluate(
                async () =>
                    (await indexedDB.databases()).find(
                        (d) => d.name === window.fixtureConstants.DB_NAME,
                    ).version,
            ),
            4,
        );
        assert.deepEqual(
            await v2page.evaluate(async () => (await import('/chat-client/storage.js')).reads()),
            [],
        );
        await v2.close();
        console.log(
            'PASS schema 2 → 4 preserves queued text and draft while adding read checkpoints and conversation storage',
        );
        // Authentication failure locks access without losing an unaccepted outgoing message.
        await alice.evaluate(() => {
            window.fetch = async (url, options) => {
                if (String(url).includes('/api/chat/')) return new Response('', { status: 401 });
                throw new TypeError('Authentication fixture blocks other network requests');
            };
        });
        await send(alice, text('survives authentication loss'));
        await until(() =>
            alice.evaluate(
                async () => !!(await (await import('/chat-client/storage.js')).readState())?.locked,
            ),
        );
        assert.equal(
            await alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length,
            ),
            1,
        );
        await contexts[0].setOffline(true);
        await alice.reload();
        await until(() =>
            alice
                .locator('#notice')
                .innerText()
                .then((t) => t.includes('Connect to sign in')),
        );
        assert.equal(await alice.locator('#rooms a').count(), 0);
        await contexts[0].setOffline(false);
        await alice.reload();
        await confirmed(alice, text('survives authentication loss'));
        await until(() =>
            alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
            ),
        );
        const touch = await browser.newContext({
            storageState: await contexts[0].storageState(),
            isMobile: true,
            hasTouch: true,
            viewport: { width: 390, height: 844 },
        });
        const touchPage = await fixturePage(touch);
        await touchPage.goto(origin + '/dm/' + names[1]);
        await touchPage.locator('#draft:not([disabled])').waitFor();
        await touchPage.locator('#draft').fill('touch keyboard');
        await touchPage.locator('#draft').press('Enter');
        assert.equal((await touchPage.locator('#draft').inputValue()).includes('\n'), true);
        assert.equal(
            await touchPage.evaluate(
                async () => (await (await import('/chat-client/storage.js')).outbox()).length,
            ),
            0,
        );
        await touch.close();
        console.log(
            'PASS authentication lock retains queue, same-account reauthentication resumes it, touch Enter inserts newline',
        );
        if (process.env.YAP_TEST_STATE)
            fs.writeFileSync(
                process.env.YAP_TEST_STATE,
                JSON.stringify({
                    storageState: await contexts[0].storageState(),
                    dmPath: '/dm/' + names[1],
                    dmId,
                }),
            );
        assert.deepEqual(errors, []);
        console.log('PASS Chromium ' + browser.version());
    } catch (error) {
        for (let i = 0; i < pages.length; i++)
            await pages[i].screenshot({ path: artifacts + `/failure-${i}.png` }).catch(() => {});
        console.log(
            await pages[0]
                ?.locator('body')
                .innerText()
                .catch(() => ''),
        );
        throw error;
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
