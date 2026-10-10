const { poll } = require('./support/wait.cjs');
// Serve previous/candidate static packages on one disposable origin; APIs use the isolated fixture.
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'),
    path = require('node:path'),
    http = require('node:http');
const assert = require('node:assert/strict');
const oldPackage = process.env.YAP_PREVIOUS_PACKAGE;
const newPackage = process.env.YAP_REWRITE_PACKAGE;
if (!oldPackage || !newPackage)
    throw new Error(
        'Set YAP_PREVIOUS_PACKAGE and YAP_REWRITE_PACKAGE to compatible chat releases.',
    );
const { manifest } = require('./support/manifest.cjs');
const manifests = new Map(
    [oldPackage, newPackage].map((p) => [p, manifest(path.join(p, 'wwwroot'))]),
);
let previousCache, candidateCache;
const backend = new URL(process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643');
if (backend.hostname !== '127.0.0.1' || backend.port === '7543')
    throw new Error('Isolated localhost fixture required');
const origin = 'http://127.0.0.1:7844',
    sockets = new Set();
let packagePath = oldPackage,
    holdWrites = false,
    browser;
const proxy = http.createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === '/chat-client/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(manifests.get(packagePath)));
        return;
    }
    if (holdWrites && req.method === 'POST' && pathname.endsWith('/messages')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Held by upgrade fixture' }));
        return;
    }
    const asset = pathname === '/lobby' ? '/chat-client/index.html' : pathname;
    const root = path.join(packagePath, 'wwwroot');
    const file = path.resolve(root, '.' + asset);
    if (
        req.method === 'GET' &&
        file.startsWith(root + path.sep) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile()
    ) {
        const types = {
            '.js': 'text/javascript',
            '.html': 'text/html',
            '.css': 'text/css',
            '.json': 'application/json',
            '.webmanifest': 'application/manifest+json',
        };
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return;
    }
    const upstream = http.request(
        {
            hostname: backend.hostname,
            port: backend.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
        },
        (response) => {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
        },
    );
    upstream.on('error', () => {
        res.writeHead(503);
        res.end();
    });
    req.pipe(upstream);
});
proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});
proxy.on('upgrade', (req, socket, head) => {
    const upstream = http.request({
        hostname: backend.hostname,
        port: backend.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
    });
    upstream.on('upgrade', (response, back, extra) => {
        socket.write(
            `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
                response.rawHeaders.reduce(
                    (text, value, index) => text + (index % 2 ? value + '\r\n' : value + ': '),
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
    upstream.on('response', () =>
        socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'),
    );
    upstream.on('error', () => socket.destroy());
    upstream.end();
});

(async () => {
    try {
        const { SHELL_CACHE_PREFIX } = await import(
            path.resolve(__dirname, '../../Yap/wwwroot/chat-client/constants.js')
        );
        previousCache = SHELL_CACHE_PREFIX + manifests.get(oldPackage).version;
        candidateCache = SHELL_CACHE_PREFIX + manifests.get(newPackage).version;
        assert.notEqual(previousCache, candidateCache, 'An upgrade requires changed assets');
        for (const dir of [oldPackage, newPackage])
            assert(fs.existsSync(path.join(dir, 'wwwroot/chat-client/worker.js')));
        await new Promise((resolve, reject) => {
            proxy.once('error', reject);
            proxy.listen(7844, '127.0.0.1', resolve);
        });
        browser = await (process.env.YAP_BROWSER === 'firefox' ? firefox : chromium).launch();
        const context = await browser.newContext(),
            page = await context.newPage();
        // Login on the backend creates only a synthetic account. Cookies share the host,
        // while worker/cache/IndexedDB state on the disposable port starts empty.
        await page.goto(backend.origin + '/login');
        await page.locator('.username-input').fill('workerupgrade' + Date.now().toString(36));
        await page.locator('.join-button').click();
        await page.waitForURL('**/lobby');
        await page.goto(origin + '/lobby');
        await page.waitForFunction(
            () =>
                document.querySelector('#connection')?.textContent === 'Synced · available offline',
        );
        previousCache = (await page.evaluate(() => caches.keys())).find((name) =>
            name.startsWith(SHELL_CACHE_PREFIX),
        );
        assert(previousCache, 'Incumbent shell is installed');
        assert.notEqual(previousCache, candidateCache);
        await context.setOffline(true);
        const text = 'Queued across shell update ' + Date.now();
        await page.locator('#draft').fill(text);
        await page.locator('#send').click();
        await page.locator('#pending [data-operation]').waitFor();
        await page.locator('#draft').fill('Unsent draft survives shell update');
        await poll(page, async () => {
            const store = await import('/chat-client/storage.js'),
                state = await store.readState();
            return (
                (await store.draft(state.snapshot.conversations.find((c) => c.isDefault).id)) ===
                document.querySelector('#draft').value
            );
        });
        const id = await page.locator('#pending [data-operation]').getAttribute('data-operation');
        holdWrites = true;
        packagePath = newPackage;
        await context.setOffline(false);
        await page.reload();
        // Fresh HTML loads the watcher even while the incumbent worker serves the old app.
        await poll(
            page,
            async ({ previousCache, candidateCache }) => {
                const names = await caches.keys();
                return names.includes(candidateCache) && !names.includes(previousCache);
            },
            { previousCache, candidateCache },
        );
        await page.reload();
        await page.waitForFunction(
            () =>
                document.querySelector('#connection')?.textContent === 'Synced · available offline',
        );
        assert.equal(
            await page.locator('#draft').inputValue(),
            'Unsent draft survives shell update',
        );
        assert.equal(
            await page.locator('#pending [data-operation]').getAttribute('data-operation'),
            id,
        );
        holdWrites = false;
        await page.locator('#timeline .message-text').filter({ hasText: text }).waitFor();
        await poll(
            page,
            async () => (await (await import('/chat-client/storage.js')).outbox()).length === 0,
        );
        assert.equal(
            await page.locator('#timeline .message-text').filter({ hasText: text }).count(),
            1,
        );
        await context.setOffline(true);
        await page.reload();
        await page.locator('#timeline .message-text').filter({ hasText: text }).waitFor();
        await page.locator('#draft:not([disabled])').waitFor();
        assert.equal(
            await page.locator('#draft').inputValue(),
            'Unsent draft survives shell update',
        );
        console.log(
            `PASS actual ${previousCache} → ${candidateCache} activation, retained draft/outbox, exactly-once recovery and offline reload; ` +
                browser.version(),
        );
    } finally {
        await browser?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => proxy.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
