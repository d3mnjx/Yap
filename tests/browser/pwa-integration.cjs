const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'),
    assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw Error('Local fixture only');
(async () => {
    const browser = await chromium.launch();
    try {
        const errors = [];
        async function context(options = {}) {
            const c = await browser.newContext(
                options.storageState ? { storageState: options.storageState } : {},
            );
            await c.addInitScript(({ standalone, permission, rotated }) => {
                // about:blank setup frames are not secure contexts and expose no registration constructor.
                if (!('ServiceWorkerRegistration' in window) || !('Notification' in window)) return;
                const match = window.matchMedia.bind(window);
                window.matchMedia = (q) => {
                    const result = match(q);
                    if (q.includes('display-mode'))
                        Object.defineProperty(result, 'matches', { value: !!standalone });
                    return result;
                };
                let currentPermission = permission || 'default';
                window.permissionRequests = 0;
                window.subscriptions = 0;
                window.unsubscribes = 0;
                window.badges = [];
                Object.defineProperty(Notification, 'permission', { get: () => currentPermission });
                Notification.requestPermission = async () => {
                    window.permissionRequests++;
                    currentPermission = 'granted';
                    return 'granted';
                };
                const key = new Uint8Array(65);
                key[0] = 4;
                window.fixturePublicKey = btoa(String.fromCharCode(...key)).replace(/=+$/, '');
                function subscription(bytes) {
                    return {
                        endpoint: 'https://push.invalid/yap-browser-fixture',
                        options: { applicationServerKey: bytes.buffer },
                        toJSON: () => ({
                            endpoint: 'https://push.invalid/yap-browser-fixture',
                            keys: { p256dh: 'fixture-key', auth: 'fixture-auth' },
                        }),
                        unsubscribe: async () => {
                            window.unsubscribes++;
                            existing = null;
                            return true;
                        },
                    };
                }
                let existing = rotated ? subscription(new Uint8Array([1, 2, 3])) : null;
                Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
                    get: () => ({
                        getSubscription: async () => existing,
                        subscribe: async ({ applicationServerKey }) => {
                            window.subscriptions++;
                            existing = subscription(applicationServerKey);
                            return existing;
                        },
                    }),
                });
                Object.defineProperty(navigator, 'setAppBadge', {
                    value: async (count) => window.badges.push(count),
                    configurable: true,
                });
                Object.defineProperty(navigator, 'clearAppBadge', {
                    value: async () => window.badges.push(0),
                    configurable: true,
                });
            }, options);
            await c.route('**/api/push/vapid-public-key', async (route) =>
                route.fulfill({
                    json: {
                        publicKey: Buffer.from([4, ...Array(64).fill(0)]).toString('base64url'),
                    },
                }),
            );
            c.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
            return c;
        }
        const base = await context(),
            page = await base.newPage(),
            name = 'pwa' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        assert.equal(
            await page.locator('link[rel="manifest"]').getAttribute('href'),
            '/manifest.webmanifest',
        );
        assert.equal(await page.locator('.push-prompt-overlay').count(), 0);
        assert.equal(await page.evaluate(() => permissionRequests), 0);
        const manifestResponse = await base.request.get(origin + '/manifest.webmanifest'),
            manifest = await manifestResponse.json();
        assert(manifestResponse.headers()['cache-control'].includes('no-store'));
        assert.equal(manifest.id, '/');
        assert(manifest.start_url.startsWith('/pwa-launch?lt='));
        const userId = (await (await base.request.get(origin + '/api/chat/session')).json()).userId;
        // Real token redemption into an empty cookie jar (not a simulated cookie copy).
        const handoff = await context({ standalone: true, permission: 'denied' }),
            launch = await handoff.newPage();
        await launch.goto(origin + manifest.start_url);
        await launch.waitForURL('**/lobby');
        await launch.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(
            (await (await handoff.request.get(origin + '/api/chat/session')).json()).userId,
            userId,
        );
        await launch.evaluate(() => navigator.serviceWorker.ready);
        await handoff.setOffline(true);
        await launch.goto(origin + '/pwa-launch?lt=expired-fixture');
        await launch.waitForURL('**/lobby');
        await launch.locator('#draft:not([disabled])').waitFor();
        assert(!launch.url().includes('lt='));
        assert.equal(
            await launch.evaluate(async () => {
                for (const key of await caches.keys())
                    for (const r of await (await caches.open(key)).keys())
                        if (
                            new URL(r.url).pathname === '/manifest.webmanifest' ||
                            new URL(r.url).pathname === '/pwa-launch'
                        )
                            return true;
                return false;
            }),
            false,
        );
        console.log(
            'PASS credentialed no-store manifest, real separate-cookie handoff, cached launch and token removal',
        );
        const state = await base.storageState();
        const denied = await context({
                storageState: state,
                standalone: true,
                permission: 'denied',
            }),
            deniedPage = await denied.newPage();
        await deniedPage.goto(origin + '/lobby');
        await deniedPage.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(await deniedPage.locator('.push-prompt-overlay').count(), 0);
        const prompts = await context({ storageState: state, standalone: true }),
            p = await prompts.newPage();
        await p.goto(origin + '/lobby');
        await p.locator('.push-prompt-enable').waitFor();
        assert.equal(await p.evaluate(() => permissionRequests), 0);
        const beforePermission = await p.evaluate(() => badges.length);
        const subscribed = p.waitForResponse(
            (r) => r.url().endsWith('/api/push/subscribe') && r.status() === 200,
        );
        await p.locator('.push-prompt-enable').click();
        await subscribed;
        await p.locator('.push-prompt-overlay').waitFor({ state: 'detached' });
        assert.equal(await p.evaluate(() => permissionRequests), 1);
        assert.equal(await p.evaluate(() => subscriptions), 1);
        await p.waitForFunction((before) => badges.length > before, beforePermission);
        // Refresh a granted subscription and replace an obsolete application server key.
        const repair = await context({ storageState: state, permission: 'granted', rotated: true }),
            r = await repair.newPage();
        const refreshed = r.waitForResponse(
            (x) => x.url().endsWith('/api/push/subscribe') && x.status() === 200,
        );
        await r.goto(origin + '/lobby');
        await refreshed;
        assert.equal(await r.evaluate(() => unsubscribes), 1);
        assert.equal(await r.evaluate(() => permissionRequests), 0);
        console.log(
            'PASS PWA-only explicit permission, denied silence, granted subscription repair and key rotation (browser API fixtures)',
        );
        const dismiss = await context({ storageState: state, standalone: true }),
            d = await dismiss.newPage();
        for (let i = 0; i < 3; i++) {
            await d.goto(origin + '/lobby');
            await d.locator('.push-prompt-later').click();
        }
        await d.reload();
        await d.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        assert.equal(await d.locator('.push-prompt-overlay').count(), 0);
        assert.equal(
            await d.evaluate(() => localStorage.getItem('push-prompt-dismiss-count')),
            '3',
        );
        // Actual worker handler, instrumented badge/banner boundaries; no external push is sent.
        const worker = base.serviceWorkers()[0];
        await worker.evaluate(async () => {
            self.testBadges = [];
            self.testNotices = [];
            Object.defineProperty(self.navigator, 'setAppBadge', {
                value: async (n) => self.testBadges.push(n),
                configurable: true,
            });
            self.registration.showNotification = async (title, options) =>
                self.testNotices.push({ title, options });
            const waits = [];
            const event = new Event('push');
            event.data = {
                json: () => ({
                    title: 'Fixture push',
                    body: 'Fixture body',
                    url: '/lobby',
                    unreadCount: 4,
                }),
            };
            event.waitUntil = (p) => waits.push(p);
            self.dispatchEvent(event);
            await Promise.all(waits);
        });
        assert.deepEqual(await worker.evaluate(() => testBadges), [4]);
        assert.equal((await worker.evaluate(() => testNotices))[0].title, 'Fixture push');
        await page.evaluate(() =>
            navigator.serviceWorker.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'NOTIFICATION_CLICK',
                        url: '/room/11111111-1111-1111-1111-111111111111',
                    },
                }),
            ),
        );
        await page.waitForURL('**/room/11111111-1111-1111-1111-111111111111');
        await page.locator('#history-note').filter({ hasText: 'not cached' }).waitFor();
        await page.evaluate(() =>
            navigator.serviceWorker.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'NOTIFICATION_CLICK', url: 'https://external.invalid/' },
                }),
            ),
        );
        assert.equal(new URL(page.url()).origin, origin);
        await worker.evaluate(async () => {
            const original = self.clients.matchAll.bind(self.clients);
            self.clients.matchAll = async (options) =>
                (await original(options)).map((client) => ({
                    url: client.url,
                    postMessage: (data) => client.postMessage(data),
                    focus: async () => {
                        self.testFocused = true;
                    },
                }));
            const waits = [];
            const event = new Event('notificationclick');
            event.notification = { close() {}, data: { url: '/lobby' } };
            event.waitUntil = (p) => waits.push(p);
            self.dispatchEvent(event);
            await Promise.all(waits);
            self.clients.matchAll = original;
        });
        await page.waitForURL('**/lobby');
        assert.equal(await worker.evaluate(() => testFocused), true);
        console.log(
            'PASS three-dismissal policy, worker push badge/banner and click handler, notification routing and uncached destination',
        );
        // Native install prompt stays gesture-driven through the bot action link.
        await page.goto(origin + '/lobby');
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await base.setOffline(true);
        await page.evaluate(async () => {
            window.installRequests = 0;
            const event = new Event('beforeinstallprompt');
            event.prompt = async () => installRequests++;
            event.userChoice = Promise.resolve({ outcome: 'dismissed' });
            window.dispatchEvent(event);
            const store = await import('/chat-client/storage.js'),
                s = await store.readState(),
                c = s.snapshot.conversations.find((c) => c.isDefault);
            c.messages.push({
                id: 'install-fixture',
                author: { ...s.snapshot.user, isBot: true },
                content: 'You can [pwa-install] today.',
                timestamp: new Date().toISOString(),
                images: [],
                videos: [],
                reactions: [],
            });
            await store.commit({ ...s.snapshot, sequence: s.snapshot.sequence + 1 }, s);
            const b = new BroadcastChannel('yap-chat-v1');
            b.postMessage('snapshot');
            b.close();
        });
        await page.locator('#msg-install-fixture .bot-action-link').click();
        assert.equal(await page.evaluate(() => installRequests), 1);
        const removed = p.waitForResponse(
            (x) => x.url().endsWith('/api/push/unsubscribe') && x.status() === 200,
        );
        await p.locator('#menu-button').click();
        await p.locator('#signout').click();
        await removed;
        assert.deepEqual(errors, []);
        console.log(
            'PASS bot install gesture and explicit sign-out unsubscribe; Chromium ' +
                browser.version(),
        );
        console.log(
            'LIMIT: permission, push service, notification focus and OS badge presentation are instrumented; real devices/external delivery remain manual checks.',
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
