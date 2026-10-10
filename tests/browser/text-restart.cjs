// Starts/stops only its own isolated server. Requires the synthetic state from text-sending.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process'),
    { once } = require('node:events');
const fs = require('node:fs'),
    assert = require('node:assert/strict');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
    throw new Error('Local test server required');
const launcher = process.env.YAP_TEST_LAUNCHER,
    fixture = JSON.parse(fs.readFileSync(process.env.YAP_TEST_STATE, 'utf8'));
if (!launcher) throw new Error('Isolated foreground launcher required');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        if (await check()) return;
        await pause(100);
    }
    throw new Error('Timed out');
}
let server;
function launch() {
    const log = fs.openSync('/tmp/yap-text-restart-server.log', 'a');
    server = spawn(launcher, [], { detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    server.unref();
}
(async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ storageState: fixture.storageState });
        if (await context.request.get(origin + '/api/chat/session').catch(() => null))
            throw new Error('Stop the isolated test server before running this check');
        launch();
        const alive = () =>
            context.request
                .get(origin + '/api/chat/session')
                .then((r) => r.ok())
                .catch(() => false);
        await until(alive);
        const page = await context.newPage();
        await page.goto(origin + fixture.dmPath);
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        // Suppress live confirmation; lose the HTTP response only AFTER the real server commits it.
        await page.addInitScript(() => {
            const original = window.fetch;
            window.fetch = async (url, options) => {
                if (String(url).includes('/hubs/chat'))
                    throw new TypeError('Live transport unavailable');
                const response = await original(url, options);
                if (window.loseAck && String(url).endsWith('/messages')) {
                    window.loseAck = false;
                    window.acceptedFixture = {
                        request: JSON.parse(options.body),
                        response: await response.clone().json(),
                    };
                    throw new TypeError('Acknowledgement lost after commit');
                }
                return response;
            };
        });
        await page.reload();
        await page.locator('#draft:not([disabled])').waitFor();
        const label = 'lost ack ' + Date.now();
        await page.evaluate(() => (window.loseAck = true));
        await page.locator('#draft').fill(label);
        await page.locator('#send').click();
        await until(() => page.evaluate(() => !!window.acceptedFixture));
        await context.setOffline(true);
        const accepted = await page.evaluate(() => window.acceptedFixture);
        assert(accepted.response.messageId);
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
        server = null;
        await page.locator('#draft').fill('queued during restart');
        await page.locator('#send').click();
        await page.locator('#draft').fill('draft survives restart');
        await page.waitForFunction(async () => {
            const store = await import('/chat-client/storage.js');
            const { snapshot } = await store.readState();
            const channel = snapshot.conversations.find((c) => c.path === location.pathname);
            return (
                channel &&
                (await store.draft(channel.id)) === document.querySelector('#draft').value
            );
        });
        await page.reload();
        await until(() =>
            page
                .locator('#pending [data-operation]')
                .count()
                .then((n) => n === 2),
        );
        assert.equal(await page.locator('#draft').inputValue(), 'draft survives restart');
        console.log(
            'PASS accepted-but-unacknowledged and unsent messages both survive offline reload',
        );
        launch();
        await until(alive);
        const session = await (await context.request.get(origin + '/api/chat/session')).json();
        const replay = await context.request.post(
            origin + `/api/chat/conversations/${fixture.dmId}/messages`,
            { headers: { 'X-CSRF-TOKEN': session.csrfToken }, data: accepted.request },
        );
        assert(replay.ok());
        assert.equal((await replay.json()).messageId, accepted.response.messageId);
        await context.setOffline(false);
        await until(() =>
            page
                .locator('#pending [data-operation]')
                .count()
                .then((n) => n === 0),
        );
        assert.equal(
            await page.locator('#timeline .message-text').filter({ hasText: label }).count(),
            1,
        );
        assert.equal(
            await page
                .locator('#timeline .message-text')
                .filter({ hasText: 'queued during restart' })
                .count(),
            1,
        );
        assert.equal(await page.locator('#draft').inputValue(), 'draft survives restart');
        console.log(
            'PASS process restart returns the original receipt, sends queued text exactly once, and preserves draft',
        );
        console.log('Isolated test server left running; PID ' + server.pid);
    } catch (error) {
        server?.kill('SIGTERM');
        throw error;
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
