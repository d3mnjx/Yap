// Exercise non-arrival snapshot updates that will also be used by later edit/reaction/history phases.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw new Error('Local test origin required');
(async () => {
    const browser = await chromium.launch();
    try {
        const fixture = JSON.parse(fs.readFileSync(process.env.YAP_TEST_STATE, 'utf8'));
        const context = await browser.newContext({ storageState: fixture.storageState });
        const page = await context.newPage();
        await page.goto(origin + '/icon.svg');
        const result = await page.evaluate(async () => {
            const store = await import('/chat-client/storage.js'),
                { createNotifications } = await import('/chat-client/notifications.js');
            const data = await (await fetch('/api/chat/sync')).json(),
                owner = await store.establish(data.user.id);
            await store.commit(data, owner);
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            let calls = 0;
            HTMLMediaElement.prototype.play = function () {
                calls++;
                return Promise.resolve();
            };
            let current = data;
            const dmId = current.conversations.find((c) => c.kind === 'dm' && !c.muted)?.id;
            if (!dmId) throw new Error('Fixture requires an unmuted DM');
            const notifier = createNotifications({
                identity: () => owner,
                snapshot: () => current,
                current: () => current.conversations.find((c) => c.id === dmId),
            });
            await notifier.observe(current, { baseline: true });
            const base = document.title;
            const unchanged = () => {
                if (document.title !== base || calls !== 0)
                    throw new Error('A non-arrival generated a notification');
            };
            current = structuredClone(current);
            current.sequence++;
            const dm = current.conversations.find((c) => c.id === dmId);
            if (dm.messages.length) {
                dm.messages[0].content = 'edited snapshot fixture';
                dm.messages[0].isEdited = true;
                dm.messages[0].reactions = [{ emoji: '👍', users: ['fixture'] }];
            }
            await notifier.observe(current, { live: true });
            unchanged();
            current = structuredClone(current);
            current.sequence++;
            const changed = current.conversations.find((c) => c.id === dmId);
            changed.messages.pop();
            changed.messages.unshift({
                id: crypto.randomUUID(),
                author: { id: 'older-author' },
                content: 'older history exposed after deletion',
                timestamp: '2000-01-01T00:00:00Z',
            });
            await notifier.observe(current, { live: true });
            unchanged();
            current = structuredClone(current);
            current.sequence++;
            current.conversations.find((c) => c.id === dmId).unread = 0;
            await notifier.observe(current, { live: true });
            await notifier.observe(current, { live: true });
            unchanged();
            await notifier.observe(
                { ...current, serverEpoch: 'retired-fixture', sequence: current.sequence + 100 },
                { live: true },
            );
            await notifier.observe(
                { ...current, user: { id: 'another-account' }, sequence: current.sequence + 100 },
                { live: true },
            );
            unchanged();
            return true;
        });
        assert.equal(result, true);
        console.log(
            'PASS edited/reaction, deletion/backfill, read-only and duplicate snapshots do not notify; wrong-account and retired-epoch input ignored',
        );
        console.log('PASS Chromium ' + browser.version());
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
