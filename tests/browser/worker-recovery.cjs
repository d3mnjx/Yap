const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../Yap/wwwroot');
const required = [
    '/service-worker-module.js',
    '/chat-client/worker.js',
    '/chat-client/constants.js',
    '/chat-client/worker-common.js',
    '/chat-client/push.js',
    '/chat-client/index.html',
];
const assets = required.map((url) => ({
    url,
    hash: createHash('sha256')
        .update(fs.readFileSync(path.join(root, url)))
        .digest('hex'),
    install: true,
}));
assets.push({ url: '/themes/optional-scene.png', hash: 'unavailable', install: false });
const manifest = { version: 'eviction-fixture', assets };
let optionalRequests = 0;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (url === '/probe' || url === '/lobby') {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<!doctype html><title>Network ' + url + '</title>');
    }
    if (
        url === '/chat-client/manifest.json' ||
        url.startsWith('/api/') ||
        url.startsWith('/hubs/')
    ) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(
            JSON.stringify(url === '/chat-client/manifest.json' ? manifest : { network: true }),
        );
    }
    if (url === '/themes/optional-scene.png') optionalRequests++;
    try {
        res.setHeader(
            'Content-Type',
            url.endsWith('.js')
                ? 'text/javascript'
                : url.endsWith('.html')
                  ? 'text/html'
                  : 'image/svg+xml',
        );
        res.end(fs.readFileSync(path.join(root, url)));
    } catch {
        res.statusCode = 404;
        res.end();
    }
});
(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await (process.env.YAP_BROWSER === 'firefox' ? firefox : chromium).launch();
    try {
        const legacy = await browser.newContext();
        const oldPage = await legacy.newPage();
        await oldPage.goto('http://127.0.0.1:' + server.address().port + '/lobby');
        await oldPage.evaluate(async () => {
            window.unsavedComposer = 'legacy draft';
            await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
        });
        await oldPage.waitForFunction(() => !!navigator.serviceWorker.controller);
        assert.equal(await oldPage.evaluate(() => window.unsavedComposer), 'legacy draft');
        console.log('PASS classic bridge activation leaves an open composer document intact');
        await legacy.close();
        const context = await browser.newContext();
        const page = await context.newPage();
        const origin = 'http://127.0.0.1:' + server.address().port;
        await page.goto(origin + '/probe');
        await page.evaluate(async () => {
            await caches.open('yap-v2');
            await caches.open('yap-media-v1');
            const r = await navigator.serviceWorker.register(
                '/service-worker-module.js?v=eviction-fixture',
                { type: 'module', scope: '/' },
            );
            const activate = (w) => {
                if (!w) return;
                const ready = () => {
                    if (w.state === 'installed') w.postMessage({ type: 'SKIP_WAITING' });
                };
                w.addEventListener('statechange', ready);
                ready();
            };
            r.addEventListener('updatefound', () => activate(r.installing));
            activate(r.installing || r.waiting);
        });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        const cachesAfter = await page.evaluate(() => caches.keys());
        assert(!cachesAfter.includes('yap-v2') && !cachesAfter.includes('yap-media-v1'));
        assert.equal(optionalRequests, 0);
        console.log(
            'PASS missing optional artwork does not block install; obsolete root caches are removed',
        );
        await context.setOffline(true);
        const offline = await page.goto(origin + '/lobby');
        assert(offline.ok());
        assert((await offline.text()).includes('data-appearance'));
        await context.setOffline(false);
        await page.goto(origin + '/probe');
        console.log('PASS installed module worker serves offline chat navigation');
        await page.evaluate(async () => {
            for (const name of await caches.keys()) await caches.delete(name);
        });
        // Restart the actual worker so it cannot satisfy manifest() from its in-memory copy.
        if (browser.browserType().name() === 'chromium') {
            const cdp = await context.newCDPSession(page);
            await cdp.send('ServiceWorker.enable');
            await cdp.send('ServiceWorker.stopAllWorkers');
            await cdp.detach();
        }
        const values = await page.evaluate(async () => {
            const result = [];
            for (const url of ['/api/probe', '/hubs/chat/negotiate', '/chat-client/constants.js']) {
                const response = await fetch(url);
                result.push({ ok: response.ok, text: await response.text() });
            }
            return result;
        });
        assert(values.every((v) => v.ok));
        assert(values[0].text.includes('network') && values[1].text.includes('network'));
        await page.goto(origin + '/lobby');
        assert.equal(await page.title(), 'Network /lobby');
        console.log(
            'PASS evicted shell and worker restart preserve API, hub, asset and navigation network access',
        );
        await context.close();
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
