// Owns a disposable server/database copied from a complete publish output.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const origin = 'http://127.0.0.1:8055';
(async () => {
    if (!process.env.YAP_TEST_PACKAGE)
        throw new Error('Set YAP_TEST_PACKAGE to a complete publish output');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yap-restart-cache-'));
    let server, browser, release;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    async function wait(check) {
        for (let i = 0; i < 300; i++) {
            if (await check()) return;
            await delay(100);
        }
        throw new Error('Timed out waiting for restart cache state');
    }
    async function start() {
        server = spawn('dotnet', ['Yap.dll', '--urls', origin], {
            cwd: root,
            env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' },
            stdio: 'ignore',
        });
        await wait(async () => {
            if (server.exitCode !== null) throw new Error('Fixture server exited');
            try {
                return (await fetch(origin + '/login')).ok;
            } catch {
                return false;
            }
        });
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
                    Persistence: {
                        Enabled: true,
                        ConnectionStrings: { SQLite: 'Data Source=Data/yap.db' },
                    },
                    Bot: { Enabled: false },
                    WelcomePageEnabled: false,
                },
                Vapid: { PublicKey: '', PrivateKey: '' },
            }),
        );
        await start();
        browser = await chromium.launch();
        const contexts = await Promise.all(
            [0, 1, 2].map(() => browser.newContext({ serviceWorkers: 'block' })),
        );
        const pages = await Promise.all(contexts.map((c) => c.newPage()));
        const names = ['restartalice', 'restartbob', 'restartcarol'];
        for (let i = 0; i < pages.length; i++) {
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await pages[i].locator('#draft:not([disabled])').waitFor();
        }
        const ids = [];
        for (const i of [1, 2])
            ids.push(
                await pages[i].evaluate(
                    async ({ name, i }) => {
                        const session = await (await fetch('/api/chat/session')).json();
                        async function post(route, value) {
                            const r = await fetch('/api/chat/' + route, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-CSRF-TOKEN': session.csrfToken,
                                },
                                body: JSON.stringify(value),
                            });
                            if (!r.ok) throw new Error('Fixture write failed');
                            return r.json();
                        }
                        const dm = await post('dm/' + name, {});
                        for (const content of i === 1
                            ? ['restart-deleted', 'restart-keep']
                            : ['restart-other'])
                            await post('conversations/' + dm.channelId + '/messages', {
                                operationId: crypto.randomUUID(),
                                content,
                            });
                        return dm.channelId;
                    },
                    { name: names[0], i },
                ),
            );
        const alice = pages[0];
        const state = () =>
            alice.evaluate(
                async () => (await (await import('/chat-client/storage.js')).readState()).snapshot,
            );
        // Read inside each retry; do not use async predicates in Playwright's wait helper.
        async function cachedReady() {
            const s = await state();
            return ids.every((id) => s.conversations.find((c) => c.id === id)?.sync.loaded);
        }
        await wait(cachedReady);
        const before = await state();
        await contexts[1].close();
        await contexts[2].close();
        await contexts[0].route('**/api/chat/windows/*', async (r) => {
            await blocked;
            await r.continue().catch(() => {});
        });
        await stop();
        execFileSync(
            'python3',
            [
                '-c',
                "import sqlite3; db=sqlite3.connect('Data/yap.db'); db.execute(\"DELETE FROM Messages WHERE Content = 'restart-deleted'\"); db.commit()",
            ],
            { cwd: root },
        );
        await start();
        await alice.reload();
        await wait(async () => (await state()).serverEpoch !== before.serverEpoch);
        const after = await state();
        assert(
            ids.every((id) => after.conversations.find((c) => c.id === id)?.messages.length > 0),
        );
        assert(
            ids.every((id) => after.conversations.find((c) => c.id === id)?.sync.loaded === false),
        );
        await contexts[0].setOffline(true);
        await alice.locator('#dms a[href="/dm/restartbob"]').click();
        await alice.locator('#timeline').getByText('restart-keep', { exact: true }).waitFor();
        await alice.locator('#dms a[href="/dm/restartcarol"]').click();
        await alice.locator('#timeline').getByText('restart-other', { exact: true }).waitFor();
        assert(await alice.locator('#window-state').isVisible());
        await contexts[0].setOffline(false);
        release();
        await wait(cachedReady);
        await wait(() => alice.locator('#window-state').isHidden());
        assert(
            !(await state()).conversations
                .find((c) => c.id === ids[0])
                .messages.some((m) => m.content === 'restart-deleted'),
        );
        console.log(
            'PASS real server restart retains multiple inactive caches through blocked recovery/offline navigation, then reconciles deletion',
        );
    } finally {
        release?.();
        await browser?.close();
        await stop();
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
