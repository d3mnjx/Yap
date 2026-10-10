// Exercise the real root/client workers on a disposable static origin; no account/server data.
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../../Yap/wwwroot');
const worker = fs.readFileSync(path.join(root, 'chat-client/worker.js'), 'utf8');
const shell = /const CHAT_SHELL = '([^']+)'/.exec(worker)[1];
const artwork = /const CHAT_EMOJI_CACHE = '([^']+)'/.exec(worker)[1];
const images = [
    '/chat-client/emoji/1f600.svg',
    '/chat-client/emoji/1f680.svg',
    '/chat-client/emoji/1f419.svg',
];
const custom = '/emoji-fallback/1f525.png';
let phase = 0;
const requests = new Map();
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.set(pathname, (requests.get(pathname) || 0) + 1);
    if (pathname === '/probe') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Emoji cache fixture</title>');
        return;
    }
    const types = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
        '.png': 'image/png',
        '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, {
        'Content-Type': types[path.extname(pathname)] || 'application/octet-stream',
        'Cache-Control': pathname.endsWith('.svg')
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
    });
    if (pathname === '/chat-client/worker.js') {
        res.end(
            worker
                .replace(shell, phase ? shell + '-fixture-' + phase : shell)
                .replace(
                    `const CHAT_EMOJI_CACHE = '${artwork}'`,
                    `const CHAT_EMOJI_CACHE = '${phase === 2 ? 'yap-chat-emoji-next-fixture' : artwork}'`,
                ),
        );
        return;
    }
    const file = path.resolve(root, '.' + pathname);
    if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const bytes = fs.readFileSync(file);
        res.end(
            pathname.endsWith('.svg') && phase === 2
                ? Buffer.concat([bytes, Buffer.from('<!-- new artwork fixture -->')])
                : bytes,
        );
    } else res.end(''); // The dynamic component stylesheet is irrelevant to worker lifecycle.
});
async function poll(fn) {
    const until = Date.now() + 30000;
    while (!(await fn())) {
        if (Date.now() > until) throw Error('Cache lifecycle condition timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await (process.env.YAP_BROWSER === 'firefox' ? firefox : chromium).launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port + '/probe');
        await page.evaluate(
            async ({ image, custom }) => {
                const old = await caches.open('yap-chat-shell-v35');
                await old.addAll([image, custom]);
                await (
                    await caches.open('yap-chat-emoji-obsolete-fixture')
                ).put(image, new Response('obsolete'));
                await navigator.serviceWorker.register('/service-worker.js', {
                    updateViaCache: 'none',
                });
                await navigator.serviceWorker.ready;
            },
            { image: images[0], custom },
        );
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        await poll(() =>
            page.evaluate(async () => !(await caches.keys()).includes('yap-chat-shell-v35')),
        );
        assert(
            await page.evaluate(
                async ({ artwork, image }) => !!(await (await caches.open(artwork)).match(image)),
                { artwork, image: images[0] },
            ),
        );
        assert(
            !(await page.evaluate(() => caches.keys())).includes('yap-chat-emoji-obsolete-fixture'),
        );
        await page.evaluate(
            async ({ direct, warm, custom }) => {
                await fetch(direct);
                await fetch(custom);
                navigator.serviceWorker.controller.postMessage({
                    type: 'chat-warm-emoji',
                    paths: [warm],
                });
            },
            { direct: images[1], warm: images[2], custom },
        );
        await poll(() =>
            page.evaluate(
                async ({ artwork, warm }) => !!(await (await caches.open(artwork)).match(warm)),
                { artwork, warm: images[2] },
            ),
        );
        assert(
            await page.evaluate(
                async ({ artwork, custom, shell }) =>
                    !(await (await caches.open(artwork)).match(custom)) &&
                    !!(await (await caches.open(shell)).match(custom)),
                { artwork, custom, shell },
            ),
        );
        const before = [...requests].filter(
            ([name]) => name.startsWith('/chat-client/emoji/') && name.endsWith('.svg'),
        );
        phase = 1;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await poll(() =>
            page.evaluate(async (shell) => {
                const keys = await caches.keys();
                return !keys.includes(shell) && keys.includes(shell + '-fixture-1');
            }, shell),
        );
        // A new document still uses the same origin's persisted artwork cache.
        await page.reload();
        await context.setOffline(true);
        const bodies = await page.evaluate(
            async (images) =>
                Promise.all(
                    images.map(async (url) => {
                        const response = await fetch(url);
                        return { ok: response.ok, body: await response.text() };
                    }),
                ),
            images,
        );
        assert(bodies.every((r) => r.ok && r.body.includes('<svg')));
        assert.deepEqual(
            [...requests].filter(
                ([name]) => name.startsWith('/chat-client/emoji/') && name.endsWith('.svg'),
            ),
            before,
        );
        console.log(
            'PASS v35 artwork migration, direct/warmed SVG cache, root-worker retention, shell update with zero SVG requests, offline reuse; custom images stay separate',
        );
        await context.setOffline(false);
        // A leftover v35 cache must never be imported into a different artwork pin.
        await page.evaluate(async (image) => {
            await (
                await caches.open('yap-chat-shell-v35')
            ).put(image, new Response('<svg>old pin</svg>'));
        }, images[0]);
        phase = 2;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await poll(() =>
            page.evaluate(async (artwork) => {
                const keys = await caches.keys();
                return !keys.includes(artwork) && keys.includes('yap-chat-emoji-next-fixture');
            }, artwork),
        );
        const changed = await page.evaluate(async (url) => (await fetch(url)).text(), images[0]);
        assert(changed.includes('new artwork fixture'));
        assert.equal(requests.get(images[0]), new Map(before).get(images[0]) + 1);
        console.log(
            'PASS changed artwork version discards old pin and bypasses immutable HTTP cache; ' +
                browser.version(),
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
