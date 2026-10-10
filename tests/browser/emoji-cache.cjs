// Real module worker lifecycle; phase 1 changes CSS only, phase 2 changes the artwork pin.
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { manifest } = require('./support/manifest.cjs');
const root = path.resolve(__dirname, '../../Yap/wwwroot');
let phase = 0;
let corrupt = false;
const requests = new Map();
const images = ['/chat-client/emoji/1f600.svg', '/chat-client/emoji/1f680.svg'];
const custom = '/emoji-fallback/1f525.png';
function read(url) {
    const bytes = fs.readFileSync(path.join(root, url));
    if (url === '/chat-client/chat.css' && phase)
        return Buffer.concat([bytes, Buffer.from('\n/* CSS-only release ' + phase + ' */')]);
    if (url === '/chat-client/worker.js' && phase === 2)
        return Buffer.from(
            bytes.toString().replace('yap-chat-emoji-17.0.3', 'yap-chat-emoji-next-fixture'),
        );
    if (url.endsWith('.svg') && phase === 2)
        return Buffer.concat([bytes, Buffer.from('<!-- new artwork fixture -->')]);
    return bytes;
}
let current = manifest(root, read);
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    requests.set(url, (requests.get(url) || 0) + 1);
    const types = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
        '.json': 'application/json',
    };
    res.setHeader(
        'Cache-Control',
        url.endsWith('.svg') ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    res.setHeader('Content-Type', types[path.extname(url)] || 'application/octet-stream');
    if (url === '/probe') {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<!doctype html><title>Worker fixture</title>');
    }
    if (url === '/chat-client/manifest.json') return res.end(JSON.stringify(current));
    try {
        res.end(corrupt && url === '/chat-client/chat.css' ? 'incomplete deployment' : read(url));
    } catch {
        res.statusCode = 404;
        res.end();
    }
});
async function poll(fn) {
    const until = Date.now() + 60000;
    while (!(await fn())) {
        if (Date.now() > until) throw Error('Cache lifecycle condition timed out');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
(async () => {
    const { SHELL_CACHE_PREFIX } = await import(path.join(root, 'chat-client/constants.js'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await (process.env.YAP_BROWSER === 'firefox' ? firefox : chromium).launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port + '/probe');
        const register = () =>
            page.evaluate(async () =>
                (await import('/chat-client/worker-updates.js')).registerWorker().then(() => null),
            );
        await register();
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
            timeout: 60000,
        });
        const original = SHELL_CACHE_PREFIX + current.version;
        await page.evaluate(
            async ({ images, custom }) => {
                await fetch(images[0]);
                await fetch(custom);
                navigator.serviceWorker.controller.postMessage({
                    type: 'chat-warm-emoji',
                    paths: [images[1]],
                });
            },
            { images, custom },
        );
        const artwork = (await page.evaluate(() => caches.keys())).find((k) =>
            k.startsWith('yap-chat-emoji-'),
        );
        await poll(() =>
            page.evaluate(
                async ({ artwork, image }) => !!(await (await caches.open(artwork)).match(image)),
                { artwork, image: images[1] },
            ),
        );
        assert(
            await page.evaluate(
                async ({ artwork, custom, original }) =>
                    !(await (await caches.open(artwork)).match(custom)) &&
                    !!(await (await caches.open(original)).match(custom)),
                { artwork, custom, original },
            ),
        );
        const before = [...requests].filter(([name]) =>
            /^\/chat-client\/emoji\/.*\.svg$/.test(name),
        );
        const workerBefore = read('/chat-client/worker.js');
        phase = 1;
        current = manifest(root, read);
        assert.deepEqual(read('/chat-client/worker.js'), workerBefore);
        await register();
        await poll(() =>
            page.evaluate(
                async ({ original, candidate }) => {
                    const keys = await caches.keys();
                    return !keys.includes(original) && keys.includes(candidate);
                },
                { original, candidate: SHELL_CACHE_PREFIX + current.version },
            ),
        );
        assert(
            (
                await page.evaluate(async () => (await fetch('/chat-client/chat.css')).text())
            ).includes('CSS-only release 1'),
        );
        await context.setOffline(true);
        assert(
            await page.evaluate(
                async (images) =>
                    (
                        await Promise.all(
                            images.map(async (url) =>
                                (await (await fetch(url)).text()).includes('<svg'),
                            ),
                        )
                    ).every(Boolean),
                images,
            ),
        );
        assert.deepEqual(
            [...requests].filter(([name]) => /^\/chat-client\/emoji\/.*\.svg$/.test(name)),
            before,
        );
        console.log(
            'PASS CSS-only release installs with unchanged worker source; emoji retained with zero requests and offline reuse; custom cache separate',
        );
        await context.setOffline(false);
        phase = 2;
        current = manifest(root, read);
        await register();
        await poll(() =>
            page.evaluate(async (artwork) => {
                const keys = await caches.keys();
                return !keys.includes(artwork) && keys.includes('yap-chat-emoji-next-fixture');
            }, artwork),
        );
        assert(
            (await page.evaluate(async (url) => (await fetch(url)).text(), images[0])).includes(
                'new artwork fixture',
            ),
        );
        console.log(
            'PASS changed artwork pin replaces SVG bytes despite immutable HTTP cache; ' +
                browser.version(),
        );
        const acceptedVersion = current.version;
        phase = 3;
        current = manifest(root, read);
        corrupt = true;
        await page.evaluate(async () => {
            const registration = await (
                await import('/chat-client/worker-updates.js')
            ).registerWorker();
            const worker = registration.installing;
            if (worker && worker.state !== 'redundant')
                await new Promise((resolve) => {
                    worker.addEventListener('statechange', () => {
                        if (['redundant', 'activated'].includes(worker.state)) resolve();
                    });
                });
        });
        assert(
            (await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).includes(
                acceptedVersion,
            ),
        );
        await context.setOffline(true);
        assert(
            (
                await page.evaluate(async () => (await fetch('/chat-client/chat.css')).text())
            ).includes('CSS-only release 2'),
        );
        console.log(
            'PASS mismatched deployment bytes reject the candidate and preserve the incumbent offline shell',
        );
        await context.close();
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    server.closeAllConnections();
    server.close();
    process.exitCode = 1;
});
