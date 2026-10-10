const { poll } = require('./support/wait.cjs');
const { fixturePage } = require('./support/authority.cjs');
// A disposable same-origin deployment rehearsal. Never swaps the shared development/reference apps.
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'),
    path = require('node:path'),
    os = require('node:os'),
    http = require('node:http'),
    https = require('node:https'),
    assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const reference = process.env.YAP_REFERENCE_PACKAGE || '/home/agent/.local/share/yap-reference/app';
const rewrite =
    process.env.YAP_REWRITE_PACKAGE || '/home/agent/.local/share/yap-development/upgrade-publish';
const cert =
    process.env.YAP_TEST_PFX || '/home/agent/.local/share/yap-reference/certs/localhost.pfx';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yap-upgrade-')),
    origin = 'https://localhost:7743';
let server,
    proxy,
    browser,
    stallNavigation = false,
    holdInstall = false,
    installRequested = false,
    releaseInstall;
const installGate = new Promise((r) => (releaseInstall = r));
const sockets = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function db(query) {
    return JSON.parse(
        execFileSync(
            'python3',
            [
                '-c',
                'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchall()))',
                path.join(root, 'Data/yap.db'),
                query,
            ],
            { encoding: 'utf8' },
        ),
    );
}
function packageAt(src, name) {
    const dest = path.join(root, name);
    fs.cpSync(src, dest, {
        recursive: true,
        filter: (f) => {
            const r = path.relative(src, f);
            return (
                r !== 'Data' &&
                !r.startsWith('Data/') &&
                r !== 'wwwroot/uploads' &&
                !r.startsWith('wwwroot/uploads/')
            );
        },
    });
    fs.symlinkSync(path.join(root, 'Data'), path.join(dest, 'Data'), 'dir');
    fs.symlinkSync(path.join(root, 'uploads'), path.join(dest, 'wwwroot/uploads'), 'dir');
    return dest;
}
async function stop() {
    if (!server) return;
    const child = server;
    server = null;
    const stopped = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    await stopped;
    clearTimeout(timeout);
}
async function start(cwd) {
    server = spawn('dotnet', ['Yap.dll', '--urls', 'http://127.0.0.1:7843'], {
        cwd,
        env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production' },
        stdio: [
            'ignore',
            fs.openSync(path.join(root, 'server.log'), 'a'),
            fs.openSync(path.join(root, 'server.log'), 'a'),
        ],
    });
    for (let i = 0; i < 150; i++) {
        if (server.exitCode !== null)
            throw Error('Fixture server failed; see ' + root + '/server.log');
        try {
            const r = await fetch('http://127.0.0.1:7843/login');
            if (r.ok) return;
        } catch {}
        await delay(200);
    }
    throw Error('Fixture startup timeout');
}
function proxyHeaders(req) {
    return { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' };
}
(async () => {
    try {
        fs.mkdirSync(path.join(root, 'Data'));
        fs.mkdirSync(path.join(root, 'uploads'));
        fs.copyFileSync(
            path.join(reference, 'appsettings.json'),
            path.join(root, 'Data/appsettings.json'),
        );
        const old = packageAt(reference, 'original'),
            next = packageAt(rewrite, 'rewrite');
        proxy = https.createServer(
            {
                pfx: fs.readFileSync(cert),
                passphrase: process.env.YAP_TEST_PFX_PASSWORD || 'sandbox-reference',
            },
            async (req, res) => {
                if (
                    holdInstall &&
                    req.headers['sec-fetch-dest'] !== 'script' &&
                    req.url === '/chat-client/constants.js'
                ) {
                    installRequested = true;
                    await installGate;
                }
                if (stallNavigation && req.url === '/lobby') return;
                const upstream = http.request(
                    {
                        hostname: '127.0.0.1',
                        port: 7843,
                        path: req.url,
                        method: req.method,
                        headers: proxyHeaders(req),
                    },
                    (r) => {
                        res.writeHead(r.statusCode, r.headers);
                        r.pipe(res);
                    },
                );
                upstream.on('error', () => {
                    res.writeHead(503);
                    res.end();
                });
                req.pipe(upstream);
            },
        );
        proxy.on('upgrade', (req, socket, head) => {
            const upstream = http.request({
                hostname: '127.0.0.1',
                port: 7843,
                path: req.url,
                method: req.method,
                headers: proxyHeaders(req),
            });
            upstream.on('upgrade', (res, back, extra) => {
                socket.write(
                    `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` +
                        res.rawHeaders.reduce(
                            (s, v, i) => s + (i % 2 ? v + '\r\n' : v + ': '),
                            '',
                        ) +
                        '\r\n',
                );
                if (extra.length) socket.write(extra);
                if (head.length) back.write(head);
                socket.pipe(back);
                back.pipe(socket);
                socket.on('error', () => back.destroy());
                back.on('error', () => socket.destroy());
            });
            upstream.on('response', (r) => {
                socket.end(`HTTP/1.1 ${r.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
            });
            upstream.on('error', () => socket.destroy());
            upstream.end();
        });
        proxy.on('connection', (s) => {
            sockets.add(s);
            s.on('close', () => sockets.delete(s));
        });
        await new Promise((r) => proxy.listen(7743, '127.0.0.1', r));
        await start(old);
        const type = process.env.YAP_BROWSER === 'firefox' ? firefox : chromium;
        browser = await type.launch(
            type === chromium ? { args: ['--ignore-certificate-errors'] } : {},
        );
        const context = await browser.newContext({ ignoreHTTPSErrors: true }),
            page = await fixturePage(context);
        // The original shell used a CDN global. Supply the pinned test dependency so
        // provider outages cannot silently disable the baseline upload control.
        await context.route('**/npm/tus-js-client@*/dist/tus.min.js', (route) =>
            route.fulfill({
                contentType: 'text/javascript',
                path: path.resolve(__dirname, '../../node_modules/tus-js-client/dist/tus.min.js'),
            }),
        );
        const name = 'upgrade' + Date.now().toString(36);
        await page.goto(origin + '/login');
        await page.locator('.username-input').fill(name);
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.locator('.message-input:enabled').waitFor();
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.locator('.message-input').fill('Existing message before upgrade');
        await page.locator('.send-button').click();
        await page.getByText('Existing message before upgrade', { exact: true }).waitFor();
        await page
            .locator('input[type=file]')
            .first()
            .setInputFiles({
                name: 'existing.png',
                mimeType: 'image/png',
                buffer: Buffer.from(
                    await page.evaluate(() => {
                        const c = document.createElement('canvas');
                        c.width = 80;
                        c.height = 60;
                        c.getContext('2d').fillRect(0, 0, 80, 60);
                        return c.toDataURL().split(',')[1];
                    }),
                    'base64',
                ),
            });
        await page.locator(`.message-group[data-author="${name}"] .gallery-image`).waitFor();
        await page.goto(origin + '/settings');
        await page.locator('#display-name').fill('Upgrade Person');
        await page.locator('#bio').fill('Existing profile');
        await page.locator('#country').fill('Prague');
        await page.locator('.save-status.saved').filter({ hasText: 'Saved' }).first().waitFor();
        await page.goto(origin + '/lobby');
        await page.locator('.message-input:enabled').waitFor();
        const buddy = await browser.newContext({ ignoreHTTPSErrors: true }),
            bp = await fixturePage(buddy);
        await bp.goto(origin + '/login');
        await bp.locator('.username-input').fill(name + 'b');
        await bp.locator('.join-button').click();
        await bp.waitForURL('**/lobby');
        await bp.locator('.message-input:enabled').waitFor();
        await page.goto(origin + '/dm/' + name + 'b');
        await page.locator('.message-input:enabled').waitFor();
        await page.locator('.message-input').fill('Existing DM');
        await page.locator('.send-button').click();
        await page.getByText('Existing DM', { exact: true }).waitFor();
        const sibling = await fixturePage(context);
        await sibling.goto(origin + '/lobby');
        await sibling.locator('.message-input:enabled').waitFor();
        await sibling.locator('.message-input').fill('Unsent legacy draft');
        console.log(
            'PASS original users, DM/lobby history, uploaded image, profile and active sibling prepared',
        );
        const cookie = (await context.cookies()).find((c) => c.name === 'yap_auth');
        assert(cookie);
        await context.addCookies([{ ...cookie, expires: Math.floor(Date.now() / 1000) + 300 }]);
        const configBefore = fs.readFileSync(path.join(root, 'Data/appsettings.json'));
        const before = {
            users: db('SELECT Id,Token FROM Users'),
            messages: db('SELECT Id,Content FROM Messages'),
            profile: db("SELECT DisplayName,Bio,Country FROM Users WHERE Username='" + name + "'"),
        };
        const manifest = await (await context.request.get(origin + '/manifest.webmanifest')).json();
        const key = fs.readFileSync(path.join(root, 'Data/link-token.key'));
        holdInstall = true;
        await stop();
        await start(next);
        console.log('PASS original persisted data upgraded behind HTTPS proxy; runtime ' + root);
        console.log(
            'Original tab after restart',
            await sibling
                .locator('.message-input')
                .inputValue()
                .catch(() => '(reloaded)'),
        );
        // The legacy reconnect handler may reload automatically after its circuit is lost.
        try {
            await page.waitForFunction(() => document.querySelector('#draft'), null, {
                timeout: 6000,
            });
        } catch {
            await page.reload();
        }
        await page.waitForFunction(
            () => document.querySelector('#connection')?.textContent.startsWith('Synced'),
            null,
            { timeout: 20000 },
        );
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        const installDeadline = Date.now() + 15000;
        while (!installRequested && Date.now() < installDeadline) await delay(50);
        assert(installRequested, 'Fixture must hold the new worker installation');
        assert(
            !(await page.locator('#connection').innerText()).includes('available offline'),
            'An active legacy worker must not advertise offline readiness before the new shell installs',
        );
        holdInstall = false;
        releaseInstall();
        await page.waitForFunction(
            () =>
                document.querySelector('#connection')?.textContent === 'Synced · available offline',
        );
        console.log(
            'PASS first-upgrade offline readiness waits for the capable controlling worker',
        );
        for (const asset of ['/service-worker.js', '/chat-client/worker.js', '/chat-client/app.js'])
            assert(
                (await context.request.get(origin + asset))
                    .headers()
                    ['cache-control'].includes('no-cache'),
                'Deployment assets must revalidate: ' + asset,
            );
        assert.equal(new URL(page.url()).pathname, '/dm/' + name + 'b');
        await page.getByText('Existing DM', { exact: true }).waitFor();
        assert.equal(
            (await context.cookies()).find((c) => c.name === 'yap_auth').value,
            cookie.value,
        );
        assert.deepEqual(db('SELECT Id,Token FROM Users'), before.users);
        for (const m of before.messages)
            assert(
                db('SELECT Id,Content FROM Messages').some(
                    (n) => JSON.stringify(n) === JSON.stringify(m),
                ),
            );
        assert.deepEqual(
            db("SELECT DisplayName,Bio,Country FROM Users WHERE Username='" + name + "'"),
            before.profile,
        );
        assert(fs.readFileSync(path.join(root, 'Data/link-token.key')).equals(key));
        assert(fs.readFileSync(path.join(root, 'Data/appsettings.json')).equals(configBefore));
        await page.locator('#draft').fill('First message after upgrade');
        await page.locator('#send').click();
        await page
            .locator('#timeline')
            .getByText('First message after upgrade', { exact: true })
            .waitFor();
        await page.waitForFunction(() => !document.querySelector('#pending [data-operation]'));
        assert(
            (await context.cookies()).find((c) => c.name === 'yap_auth').expires >
                Date.now() / 1000 + 300 * 86400,
            'Active legacy cookie expiry must refresh',
        );
        console.log(
            'PASS existing account/cookie, DM route, messages, media files, profile and refreshed session; HTTPS writes/live hub work',
        );
        await sibling.reload();
        await sibling.locator('#draft:enabled').waitFor();
        await sibling.locator(`.message-group[data-author="${name}"] .gallery-image`).waitFor();
        await sibling.waitForFunction(
            (name) =>
                document.querySelector(`.message-group[data-author="${name}"] .gallery-image`)
                    ?.naturalWidth > 0,
            name,
        );
        await sibling.locator('#upload-files').setInputFiles({
            name: 'after-upgrade.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
                await sibling.evaluate(() => {
                    const c = document.createElement('canvas');
                    c.width = 60;
                    c.height = 40;
                    return c.toDataURL().split(',')[1];
                }),
                'base64',
            ),
        });
        await sibling.waitForFunction(
            (name) =>
                document.querySelectorAll(
                    `#timeline .message-group[data-author="${name}"] .gallery-image`,
                ).length === 2,
            name,
        );
        await sibling.waitForFunction(() => !document.querySelector('#pending [data-operation]'));
        await sibling.locator('#draft').fill('New durable draft');
        console.log(
            'PASS new tus upload through HTTPS terminator and revalidating deployment assets',
        );
        await page.evaluate(() => navigator.serviceWorker.ready);
        await poll(page, async () =>
            (await caches.keys()).some((k) =>
                k.startsWith(window.fixtureConstants.SHELL_CACHE_PREFIX),
            ),
        );
        // Firefox's Playwright routing layer bypasses normal offline navigation handling.
        // The original tus dependency is loaded; remove that fixture before testing workers.
        await context.unroute('**/npm/tus-js-client@*/dist/tus.min.js');
        // ready/cache existence can still describe the bridge during a registration race.
        // Offline navigation requires this document to be controlled by the module worker.
        await page.waitForFunction(
            () =>
                navigator.serviceWorker.controller?.scriptURL.includes(
                    '/service-worker-module.js',
                ) &&
                document.querySelector('#connection')?.textContent === 'Synced · available offline',
        );
        console.log('PASS module worker controls the document before offline navigation');
        await context.setOffline(true);
        await page.reload();
        await page.getByText('Existing DM', { exact: true }).waitFor();
        await page.locator('#draft').fill('Queued during outage');
        await page.locator('#send').click();
        await page.locator('#pending').getByText('Queued during outage', { exact: true }).waitFor();
        await page.reload();
        await page.locator('#pending').getByText('Queued during outage', { exact: true }).waitFor();
        await context.setOffline(false);
        await page
            .locator('#timeline')
            .getByText('Queued during outage', { exact: true })
            .waitFor();
        stallNavigation = true;
        const stalledAt = Date.now();
        await page.goto(origin + '/lobby');
        await page.locator('#draft:enabled').waitFor();
        assert(Date.now() - stalledAt < 12000, 'Stalled navigation must fall back to cached shell');
        stallNavigation = false;
        await page.goto(origin + '/dm/' + name + 'b');
        await page.locator('#draft:enabled').waitFor();
        console.log(
            'PASS stalled online navigation falls back to cached shell within bounded timeout',
        );
        const installed = await browser.newContext({ ignoreHTTPSErrors: true }),
            ip = await fixturePage(installed);
        await ip.goto(origin + manifest.start_url);
        await ip.locator('#draft:enabled').waitFor();
        assert.equal(
            (await installed.cookies()).find((c) => c.name === 'yap_auth').value,
            cookie.value,
        );
        console.log(
            'PASS old install link redeems after upgrade, multi-tab refresh, offline cache/reload and queued-send reconciliation',
        );
        // Keep unsent work in browser storage while the old app temporarily owns the origin.
        await context.setOffline(true);
        await page.locator('#draft').fill('Held across rollback');
        await page.locator('#send').click();
        await page.locator('#pending').getByText('Held across rollback', { exact: true }).waitFor();
        // Rollback retains the migrated database: destructive backup restore is not an automatic rollback.
        await stop();
        await start(old);
        await context.setOffline(false);
        await page.goto(origin + '/');
        await page.locator('.message-input:enabled').waitFor({ timeout: 15000 });
        assert.equal(
            await page.locator('#draft').count(),
            0,
            'Online root navigation must leave the cached rewrite after rollback',
        );
        console.log('PASS original rollback on same database/cookie through online root');
        // Returning to the candidate must preserve its existing browser storage too.
        await stop();
        await start(next);
        try {
            await page.waitForFunction(() => document.querySelector('#draft'), null, {
                timeout: 6000,
            });
        } catch {
            await page.reload();
        }
        await page.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        // Root is the rollback escape route; select the original DM again after re-upgrade.
        await page.goto(origin + '/dm/' + name + 'b');
        await page.getByText('First message after upgrade', { exact: true }).waitFor();
        await sibling.reload();
        await sibling.waitForFunction(
            () => document.querySelector('#draft')?.value === 'New durable draft',
        );
        await page
            .locator('#timeline')
            .getByText('Held across rollback', { exact: true })
            .waitFor();
        assert.equal(
            db("SELECT COUNT(*) FROM Messages WHERE Content='Queued during outage'")[0][0],
            1,
        );
        assert.equal(
            db("SELECT COUNT(*) FROM Messages WHERE Content='Held across rollback'")[0][0],
            1,
        );
        console.log(
            'PASS re-upgrade retains accepted messages, durable draft and retry deduplication',
        );
        console.log('PASS ' + type.name() + ' ' + browser.version());
    } finally {
        releaseInstall();
        // Close proxy sockets before browser shutdown: a stalled navigation otherwise
        // leaves Chromium waiting on a connection the fixture owns.
        for (const s of sockets) s.destroy();
        await browser?.close();
        await stop();
        await new Promise((r) => (proxy ? proxy.close(r) : r()));
        console.log('Private rehearsal state: ' + root);
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
