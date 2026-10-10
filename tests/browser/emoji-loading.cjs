// Isolated real-app checks: metadata/artwork delays, in-place repair, and offline images.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ||
    new URL(origin).port === '7543'
)
    throw Error('Disposable local fixture required');
async function poll(fn) {
    const until = Date.now() + 20000;
    while (!(await fn())) {
        if (Date.now() > until) throw Error('Condition did not become true');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
async function join(page) {
    await page.goto(origin + '/login');
    await page.locator('.username-input').fill('emoji' + Date.now().toString(36));
    await page.locator('.join-button').click();
    await page.waitForURL('**/lobby');
    await page.locator('#draft:not([disabled])').waitFor();
}
(async () => {
    const browser = await chromium.launch();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    try {
        const context = await browser.newContext({
            serviceWorkers: 'block',
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });
        const page = await context.newPage();
        const requests = [],
            errors = [];
        page.on('request', (r) => requests.push(r.url()));
        page.on('pageerror', (e) => errors.push(e.message));
        let catalogs = 0;
        await context.route('**/api/chat/catalog', async (route) => {
            const response = await route.fetch();
            const json = await response.json();
            catalogs++;
            await gate;
            json.quick = ['🦊', '🐙', ':late:'];
            json.recent = ['🐙'];
            json.categories.unshift({
                key: 'custom',
                name: 'Custom',
                icon: '/emoji-packs/wechat/bitter.png',
                items: [
                    {
                        value: ':late:',
                        keywords: 'late fixture',
                        src: '/emoji-packs/wechat/bitter.png',
                    },
                ],
            });
            await route.fulfill({ response, json });
        });
        // Image requests remain pending on first visit. Metadata still permits touch selection.
        await context.route('**/chat-client/emoji/*.svg', async (route) => {
            await gate;
            await route.abort();
        });
        await join(page);
        await page.locator('#emoji-button').click();
        await page.locator('.emoji-search input').fill('grinning');
        await page.locator('.emoji-btn[data-emoji="😀"]:visible').first().click();
        assert.equal(await page.locator('#draft').inputValue(), '😀');
        await page.keyboard.press('Escape');
        await page.locator('#draft').fill('emoji fixture 😀 👍🏽 👩‍💻 :bitter: :late:');
        await page.locator('#send').click();
        const row = page.locator('#timeline article').filter({ hasText: 'emoji fixture' });
        await row.waitFor();
        await poll(() => row.evaluate((n) => !n.classList.contains('pending-message')));
        await page.evaluate(() => {
            window.emojiRow = [...document.querySelectorAll('#timeline article')].find((n) =>
                n.textContent.includes('emoji fixture'),
            );
        });
        assert((await row.textContent()).includes(':late:'));
        await poll(() => catalogs > 0);
        release();
        await row.locator('img[alt=":late:"]').first().waitFor();
        await poll(() =>
            row
                .locator('.message-actions button[title="🦊"]')
                .count()
                .then((n) => n > 0),
        );
        assert(
            await page.evaluate(
                () =>
                    window.emojiRow ===
                    [...document.querySelectorAll('#timeline article')].find((n) =>
                        n.textContent.includes('emoji fixture'),
                    ),
            ),
        );
        await page.locator('#emoji-button').click();
        await page.locator('.emoji-search input').fill('late fixture');
        await page.locator('.emoji-btn[data-emoji=":late:"]:visible').waitFor();
        await page.keyboard.press('Escape');
        // Cached personal metadata must apply even when the next refresh never completes.
        await context.unroute('**/api/chat/catalog');
        await context.route('**/api/chat/catalog', (route) => route.abort());
        await page.reload();
        await page.locator('#draft:not([disabled])').waitFor();
        await page
            .locator('#timeline .message-actions img[alt=":late:"]')
            .first()
            .waitFor({ state: 'attached' });
        assert(!requests.some((url) => url.endsWith('/artwork.json')));
        assert.deepEqual(errors, []);
        console.log(
            'PASS first-use selection with unavailable artwork and blocked catalog; late custom/personal data repairs retained rows and mounted picker; cached preferences survive refresh failure',
        );
        await context.close();

        const offline = await browser.newContext();
        const view = await offline.newPage();
        const network = [];
        view.on('request', (r) => network.push(r.url()));
        await join(view);
        await view.evaluate(() => navigator.serviceWorker.ready);
        await view.reload();
        await view.waitForFunction(() => !!navigator.serviceWorker.controller);
        await view.locator('#draft:not([disabled])').waitFor();
        const marker = 'offline emojis ' + Date.now();
        await view.locator('#draft').fill(marker + ' 😀 👍🏽 👩‍💻 :bitter:');
        await view.locator('#send').click();
        const saved = view.locator('#timeline article').filter({ hasText: marker });
        await saved.waitFor();
        await poll(() =>
            saved
                .locator('.message-content img.emoji')
                .evaluateAll(
                    (imgs) =>
                        imgs.length === 4 &&
                        imgs.every(
                            (i) => i.complete && i.naturalWidth > 0 && !i.src.startsWith('blob:'),
                        ),
                ),
        );
        await poll(() =>
            view.evaluate(async () => {
                const storage = await import('/chat-client/storage.js');
                return (await storage.outbox()).length === 0;
            }),
        );
        await poll(() =>
            view.evaluate(async () => {
                const names = await caches.keys();
                const cache = await caches.open(names.find((n) => n.startsWith('yap-chat-emoji-')));
                return !!(await cache.match('/chat-client/emoji/1f600.svg'));
            }),
        );
        await offline.setOffline(true);
        await view.reload();
        await saved.waitFor();
        await poll(() =>
            saved
                .locator('.message-content img.emoji')
                .evaluateAll(
                    (imgs) =>
                        imgs.length === 4 && imgs.every((i) => i.complete && i.naturalWidth > 0),
                ),
        );
        const fallback = await view.evaluate(async () => {
            const { richText } = await import('/chat-client/content.js');
            const node = richText('🫆 :bitter:');
            node.id = 'uncached-emoji-test';
            document.querySelector('#timeline').append(node);
            return node.querySelector('img[alt="🫆"]')?.getAttribute('src');
        });
        assert(fallback?.endsWith('.svg'));
        await view.waitForFunction(() =>
            document.querySelector('#uncached-emoji-test')?.textContent.includes('🫆'),
        );
        assert(!network.some((url) => url.endsWith('/artwork.json')));
        console.log(
            'PASS direct SVG decode, compound emoji/custom pack, warm offline reload, and native fallback for unseen offline artwork; no bundle requests',
        );
        await offline.close();
    } finally {
        release();
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
