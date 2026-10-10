// Owns a private copy of YAP_TEST_PACKAGE and its memory-only server on port 8097.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { poll } = require('./support/wait.cjs');
const origin = 'http://127.0.0.1:8097';
(async () => {
    assert(process.env.YAP_TEST_PACKAGE, 'Set YAP_TEST_PACKAGE to a complete publish output');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yap-memory-browser-'));
    let server, browser;
    async function start() {
        server = spawn('dotnet', ['Yap.dll', '--urls', origin], {
            cwd: root,
            env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' },
            stdio: 'ignore',
        });
        for (let i = 0; i < 300; i++) {
            assert(server.exitCode === null, 'Fixture server exited');
            try {
                if ((await fetch(origin + '/login')).ok) return;
            } catch {}
            await delay(100);
        }
        throw Error('Fixture did not become ready');
    }
    async function stop() {
        if (!server || server.exitCode !== null) return;
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
    }
    try {
        const source = path.resolve(process.env.YAP_TEST_PACKAGE);
        await fs.cp(source, root, {
            recursive: true,
            filter: (p) =>
                !['Data', 'wwwroot/uploads'].some(
                    (skip) =>
                        p === path.join(source, skip) ||
                        p.startsWith(path.join(source, skip) + path.sep),
                ),
        });
        await fs.mkdir(path.join(root, 'Data'));
        await fs.writeFile(
            path.join(root, 'Data/appsettings.json'),
            JSON.stringify({
                Logging: { LogLevel: { Default: 'Warning' } },
                ChatSettings: {
                    Persistence: { Enabled: false },
                    Bot: { Enabled: false },
                    WelcomePageEnabled: false,
                },
                Vapid: { PublicKey: '', PrivateKey: '' },
            }),
        );
        await start();
        browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        const username = 'memorybrowser';
        async function login() {
            await page.goto(origin + '/login');
            await page.locator('.username-input').fill(username);
            await page.locator('.join-button').click();
            await page.waitForURL('**/lobby');
            await page.waitForFunction(() =>
                document.querySelector('#connection')?.textContent.startsWith('Synced'),
            );
        }
        async function drained() {
            await poll(
                page,
                async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
            );
        }
        const row = (text) =>
            page
                .locator('#timeline .message-group')
                .filter({
                    has: page.locator('.message-content').getByText(text, { exact: true }),
                })
                .first();
        async function send(text) {
            await page.locator('#draft').fill(text);
            await page.locator('#send').click();
            await row(text).waitFor();
            await drained();
        }
        async function action(text, title) {
            await row(text).hover();
            await row(text).getByTitle(title, { exact: true }).click();
        }
        await login();
        await page.evaluate(async () => {
            await navigator.serviceWorker.ready;
        });
        await send('memory action target');
        const initial = await page.evaluate(async () => {
            const state = await (await import('/chat-client/storage.js')).readState();
            const conversation = state.snapshot.conversations.find((c) => c.path === '/lobby');
            return {
                userId: state.userId,
                channelId: conversation.id,
                message: conversation.messages.find((m) => m.content === 'memory action target'),
            };
        });
        await action('memory action target', 'Edit');
        await page.locator('.edit-input').fill('memory edited');
        await page.locator('.edit-save').click();
        await row('memory edited').waitFor();
        await drained();
        await action('memory edited', '👍');
        await row('memory edited').locator('.reaction-pill').waitFor();
        await drained();
        console.log('PASS memory-only browser sends, edits and reacts');

        await context.setOffline(true);
        await page.locator('#draft').fill('memory reconnect queue');
        await page.locator('#send').click();
        await page
            .locator('#pending')
            .getByText('memory reconnect queue', { exact: true })
            .waitFor();
        await context.setOffline(false);
        await row('memory reconnect queue').waitFor();
        await drained();
        const replay = await page.evaluate(async (initial) => {
            const session = await (await fetch('/api/chat/session')).json();
            const response = await fetch(
                '/api/chat/conversations/' + initial.channelId + '/messages',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': session.csrfToken,
                    },
                    body: JSON.stringify({
                        operationId: initial.message.operationId,
                        content: 'memory action target',
                    }),
                },
            );
            const result = await response.json();
            const window = await (
                await fetch('/api/chat/conversations/' + initial.channelId)
            ).json();
            return {
                status: response.status,
                id: result.messageId,
                matches: window.conversation.messages.filter((m) => m.id === initial.message.id),
            };
        }, initial);
        assert.equal(replay.status, 200);
        assert.equal(replay.id, initial.message.id);
        assert.equal(replay.matches.length, 1);
        assert.equal(replay.matches[0].content, 'memory edited');
        console.log(
            'PASS memory reconnect delivers queued work and replay preserves the later edit exactly once',
        );

        await action('memory edited', 'More');
        await page.getByRole('button', { name: 'Delete Message', exact: true }).click();
        await page.locator('.confirm-delete').click();
        await row('memory edited').waitFor({ state: 'detached' });
        await drained();
        console.log('PASS memory-only browser deletes accepted messages');

        await context.setOffline(true);
        await page.locator('#draft').fill('old account queue must not migrate');
        await page.locator('#send').click();
        await page
            .locator('#pending')
            .getByText('old account queue must not migrate', { exact: true })
            .waitFor();
        await page.locator('#draft').fill('old account draft');
        await poll(page, async () => {
            const storage = await import('/chat-client/storage.js');
            return (
                (await storage.outbox()).length === 1 &&
                (await storage.draft(
                    (await storage.readState()).snapshot.conversations.find(
                        (c) => c.path === '/lobby',
                    ).id,
                )) === 'old account draft'
            );
        });
        await stop();
        await start();
        await context.setOffline(false);
        await page.reload();
        await poll(
            page,
            async () =>
                (await (await import('/chat-client/storage.js')).readIdentity())?.locked === true,
        );
        await page.locator('#notice').getByRole('link', { name: 'Sign in', exact: true }).waitFor();
        assert.match(
            await page.locator('#notice').innerText(),
            /registering again creates a new account and discards the old drafts and outgoing messages/,
        );
        assert.equal(await page.locator('#timeline .message-group').count(), 0);
        assert(await page.locator('#draft').isDisabled());
        const locked = await page.evaluate(async () => {
            const storage = await import('/chat-client/storage.js');
            return {
                identity: await storage.readIdentity(),
                outbox: await storage.outbox(),
                sessionStatus: (await fetch('/api/chat/session')).status,
            };
        });
        assert.equal(locked.identity.userId, initial.userId);
        assert.equal(locked.sessionStatus, 401);
        assert.equal(locked.outbox.length, 1);
        console.log(
            'PASS real memory restart rejects the old login and locks cached work without sending it',
        );

        await login(); // The same username still creates a different account.
        const fresh = await page.evaluate(async () => {
            const storage = await import('/chat-client/storage.js');
            return { state: await storage.readState(), outbox: await storage.outbox() };
        });
        assert.notEqual(fresh.state.userId, initial.userId);
        assert.equal(fresh.outbox.length, 0);
        assert(fresh.state.snapshot.conversations.every((c) => c.messages.length === 0));
        await send('new account send');
        assert.equal(
            await page
                .locator('#timeline')
                .getByText('old account queue must not migrate', { exact: true })
                .count(),
            0,
        );
        assert(
            !(await fs.readdir(path.join(root, 'Data'))).some((name) => /\.db(?:-|$)/.test(name)),
        );
        console.log(
            'PASS new memory account starts empty, never inherits old queued work and sends without a database',
        );
    } finally {
        await browser?.close();
        await stop();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
