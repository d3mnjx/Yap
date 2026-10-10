const { fixturePage } = require('./support/authority.cjs');
// Synthetic account from text-sending.cjs; all new messages stay in isolated offline browser storage.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw new Error('Local test origin required');
const fixture = JSON.parse(fs.readFileSync(process.env.YAP_TEST_STATE, 'utf8'));
(async () => {
    const browser = await chromium.launch();
    try {
        for (const viewport of [
            { width: 1440, height: 1000 },
            { width: 390, height: 844 },
        ]) {
            const context = await browser.newContext({
                storageState: fixture.storageState,
                viewport,
            });
            const page = await fixturePage(context),
                errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(origin + fixture.dmPath);
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
            await page.evaluate(() => navigator.serviceWorker.ready);
            await page.locator('#back').click();
            await page.waitForURL('**/lobby');
            await page.locator('#draft:not([disabled])').waitFor();
            await context.setOffline(true);
            // Enough content to require scrolling even in a previously empty lobby.
            for (const text of [
                Array.from({ length: 45 }, (_, i) => 'Offline scroll fixture line ' + i).join('\n'),
                'Last queued message must be visible',
            ]) {
                await page.locator('#draft').fill(text);
                await page.locator('#send').click();
            }
            await page.waitForFunction(
                () => document.querySelectorAll('#pending [data-operation]').length === 2,
            );
            assert.equal(await page.locator('#pending .delivery-status').count(), 0);
            assert.equal(
                await page
                    .locator('#pending [data-operation]')
                    .nth(1)
                    .locator('.avatar, .message-meta')
                    .count(),
                0,
            );
            const dm = page.locator(`#dms a[href="${fixture.dmPath}"]`);
            if (viewport.width <= 768) await page.locator('#sidebar-button').click();
            await dm.click();
            await page.waitForURL('**' + fixture.dmPath);
            await page.waitForFunction(
                () => document.querySelectorAll('#pending [data-operation]').length === 0,
            );
            // Delay draft reads to expose the frame-before-outbox race deterministically.
            await page.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const req = indexedDB.open(window.fixtureConstants.DB_NAME);
                        req.onerror = () => reject(req.error);
                        req.onsuccess = () => {
                            const db = req.result,
                                tx = db.transaction('drafts', 'readwrite'),
                                store = tx.objectStore('drafts');
                            const end = performance.now() + 500;
                            const keepAlive = () => {
                                const read = store.get('scroll-fixture');
                                read.onsuccess = () => {
                                    if (performance.now() < end) keepAlive();
                                };
                            };
                            tx.oncomplete = () => db.close();
                            keepAlive();
                            resolve();
                        };
                    }),
            );
            await page.locator('#back').click();
            await page.waitForURL('**/lobby');
            await page.waitForFunction(
                () => document.querySelectorAll('#pending [data-operation]').length === 2,
            );
            await page.waitForFunction(
                () => {
                    const scroller = document.querySelector('.messages'),
                        last = document.querySelector('#pending [data-operation]:last-child');
                    return (
                        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2 &&
                        last.getBoundingClientRect().bottom <=
                            scroller.getBoundingClientRect().bottom + 1
                    );
                },
                null,
                { timeout: 5000 },
            );
            // An update in the same conversation must not pull a reader back down.
            await page.evaluate(() => {
                document.querySelector('.messages').scrollTop = 0;
                const channel = new BroadcastChannel(window.fixtureConstants.CHANGE_CHANNEL);
                channel.postMessage('snapshot');
                channel.close();
            });
            await page.waitForTimeout(500);
            assert.equal(await page.locator('.messages').evaluate((el) => el.scrollTop), 0);
            // Controlled cached predecessor: queued messages must share online grouping rules.
            for (const [own, gap, header] of [
                [true, 1000, false],
                [false, 1000, true],
                [true, 3600000, true],
            ]) {
                await page.evaluate(
                    async ({ own, gap }) => {
                        const store = await import('/chat-client/storage.js'),
                            state = await store.readState();
                        const conversation = state.snapshot.conversations.find((c) => c.isDefault);
                        const queued = (await store.outbox()).filter(
                            (m) => m.channelId === conversation.id,
                        );
                        const author = own
                            ? state.snapshot.user
                            : {
                                  ...state.snapshot.user,
                                  id: 'other-layout-fixture',
                                  username: 'other-layout-fixture',
                              };
                        conversation.messages = [
                            {
                                id: 'layout-predecessor',
                                author,
                                timestamp: new Date(queued[0].createdAt - gap).toISOString(),
                                content: 'Cached predecessor',
                                images: [],
                                videos: [],
                                reactions: [],
                            },
                        ];
                        await store.commitUpdate(
                            window.fixtureUpdate({
                                ...state.snapshot,
                                sequence: state.snapshot.sequence + 1,
                            }),
                            state,
                        );
                        const changes = new BroadcastChannel(
                            window.fixtureConstants.CHANGE_CHANNEL,
                        );
                        changes.postMessage('snapshot');
                        changes.close();
                    },
                    { own, gap },
                );
                await page.waitForFunction((header) => {
                    const first = document.querySelector('#pending [data-operation]');
                    return (
                        document.querySelector('#msg-layout-predecessor') &&
                        first?.classList.contains('has-header') === header
                    );
                }, header);
                const rows = page.locator('#pending [data-operation]');
                assert.equal(await rows.first().locator('.avatar').count(), Number(header));
                assert.equal(await rows.first().locator('.message-meta').count(), Number(header));
                assert.equal(await rows.nth(1).locator('.avatar, .message-meta').count(), 0);
                const alignment = await page.evaluate(() =>
                    [...document.querySelectorAll('#pending .message-content')].map(
                        (el) => el.getBoundingClientRect().left,
                    ),
                );
                assert(Math.abs(alignment[0] - alignment[1]) < 1, 'Grouped text stays aligned');
            }
            await page.reload();
            await page.waitForFunction(
                () => document.querySelectorAll('#pending [data-operation]').length === 2,
            );
            assert.equal(await page.locator('#pending .delivery-status').count(), 0);
            assert.equal(await page.locator('#pending .avatar').count(), 1);
            assert.equal(await page.locator('#pending .message-meta').count(), 1);
            if (process.env.YAP_TEST_ARTIFACTS)
                await page.screenshot({
                    path: process.env.YAP_TEST_ARTIFACTS + `/queued-${viewport.width}.png`,
                });
            console.log(
                `PASS ${viewport.width}x${viewport.height}: no queued labels; cached/queued grouping, author/hour boundaries, alignment and offline reload`,
            );
            assert.deepEqual(errors, []);
            console.log(
                `PASS ${viewport.width}x${viewport.height}: offline lobby → DM → lobby includes queued messages; scrolled-up position retained`,
            );
            await context.close();
        }
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
