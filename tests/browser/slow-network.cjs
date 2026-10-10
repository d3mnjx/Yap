// Run against disposable, seeded publish copies; see tests/browser/README.md.
// The proxy shapes ALL same-origin bytes, including Blazor and chat WebSockets.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { shapedProxy } = require('./helpers/shaped-proxy.cjs');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = process.env.YAP_NETWORK_FIXTURE || '/tmp/yap-network-benchmark';
if (!path.resolve(root).startsWith('/tmp/yap-network-'))
    throw new Error('Disposable network fixture required');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json')));
const output = process.env.YAP_TEST_ARTIFACTS || path.join(root, 'results');
fs.mkdirSync(output, { recursive: true });
const tlsOrigin = process.env.YAP_NETWORK_TLS === '1';
const scheme = tlsOrigin ? 'https' : 'http';
const trials = Number(process.env.YAP_STARTUP_TRIALS || 3);
const samples = Number(process.env.YAP_MESSAGE_SAMPLES || 5);
const profiles = {
    local: { rtt: 0, down: Infinity, up: Infinity },
    latency900: { rtt: 900, down: Infinity, up: Infinity },
    slow900: { rtt: 900, down: 1000000 / 8, up: 256000 / 8 },
};
const cacheStages = (process.env.YAP_CACHE_STAGES || 'cold,warm').split(',');
const startupOnly = process.env.YAP_STARTUP_ONLY === '1';
const selected = (process.env.YAP_NETWORK_PROFILES || Object.keys(profiles).join(',')).split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const diff = (end, start) =>
    Object.fromEntries(Object.keys(end).map((k) => [k, end[k] - (start[k] || 0)]));
let report = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    packages: Object.fromEntries(
        ['reference', 'rewrite'].map((label) => [
            label,
            createHash('sha256')
                .update(fs.readFileSync(path.join(root, label, 'Yap.dll')))
                .digest('hex'),
        ]),
    ),
    method: tlsOrigin
        ? 'Shared encrypted-byte proxy; HTTPS/WS and TLS handshakes equally shaped; excludes TCP handshake/loss'
        : 'Shared application-byte proxy; HTTP/WS equally shaped; excludes TCP/TLS/loss',
    profiles,
    trials,
    samples,
    cacheStages,
    startupOnly,
    calibration: {},
    cases: [],
};
if (process.env.YAP_NETWORK_RESUME === '1')
    report = JSON.parse(fs.readFileSync(path.join(output, 'results.json')));
function save() {
    fs.writeFileSync(
        path.join(output, 'results.json'),
        JSON.stringify(report, (_, v) => (v === Infinity ? 'unlimited' : v), 2),
    );
}
async function context(browser, person) {
    const c = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: tlsOrigin,
    });
    await c.addCookies([
        {
            name: 'yap_auth',
            value: person.token,
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            expires: Date.now() / 1000 + 365 * 86400,
        },
    ]);
    return c;
}
async function instrumentation(context, page) {
    const cdp = await context.newCDPSession(page);
    const tally = {
        httpRequests: 0,
        http2Responses: 0,
        http11Responses: 0,
        compressedWsConnections: 0,
        wsUpFrames: 0,
        wsDownFrames: 0,
        wsUpPayload: 0,
        wsDownPayload: 0,
        sessionRequests: 0,
        bootstrapRequests: 0,
        messagePosts: 0,
    };
    await cdp.send('Network.enable');
    cdp.on('Network.responseReceived', ({ response }) => {
        if (response.protocol === 'h2') tally.http2Responses++;
        if (response.protocol === 'http/1.1') tally.http11Responses++;
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', ({ response }) => {
        if (
            Object.entries(response.headers).some(
                ([k, v]) =>
                    k.toLowerCase() === 'sec-websocket-extensions' &&
                    v.includes('permessage-deflate'),
            )
        )
            tally.compressedWsConnections++;
    });
    cdp.on('Network.requestWillBeSent', ({ request }) => {
        const u = new URL(request.url);
        if (u.hostname !== '127.0.0.1') return;
        tally.httpRequests++;
        if (u.pathname === '/api/chat/session') tally.sessionRequests++;
        if (u.pathname === '/api/chat/bootstrap') tally.bootstrapRequests++;
        if (request.method === 'POST' && u.pathname.endsWith('/messages')) tally.messagePosts++;
    });
    for (const [event, direction] of [
        ['Network.webSocketFrameSent', 'Up'],
        ['Network.webSocketFrameReceived', 'Down'],
    ])
        cdp.on(event, ({ response }) => {
            tally['ws' + direction + 'Frames']++;
            tally['ws' + direction + 'Payload'] += Buffer.byteLength(
                response.payloadData,
                response.opcode === 2 ? 'base64' : 'utf8',
            );
        });
    return () => ({ ...tally });
}
async function ready(page) {
    await page.locator('.message-input:enabled').waitFor({ timeout: 180000 });
    await page.waitForFunction(
        () => document.querySelector('.messages')?.textContent.includes('Fixture 0:28'),
        null,
        { timeout: 180000 },
    );
}
async function observe(page, text) {
    await page.evaluate((text) => {
        window.benchResult = { text };
        window.benchObserver?.disconnect();
        const check = () => {
            const result = window.benchResult;
            if (!result.visible && document.querySelector('.messages')?.textContent.includes(text))
                result.visible = Date.now();
            const timeline =
                document.querySelector('#timeline') || document.querySelector('.messages');
            if (
                !result.accepted &&
                [...(timeline?.querySelectorAll('.message-group[id^="msg-"]') || [])].some((n) =>
                    n.textContent.includes(text),
                )
            )
                result.accepted = Date.now();
            if (result.visible && result.accepted) window.benchObserver.disconnect();
        };
        window.benchObserver = new MutationObserver(check);
        window.benchObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        check();
    }, text);
}
async function clickSend(page, text) {
    await page.locator('.message-input').fill(text);
    return page.evaluate(() => {
        const start = Date.now();
        document.querySelector('.send-button').click();
        return start;
    });
}
async function rendered(page) {
    await page.waitForFunction(() => !!window.benchResult?.accepted, null, { timeout: 60000 });
    return page.evaluate(() => window.benchResult);
}
async function calibration(profile) {
    const server = net.createServer((socket) => {
        socket.once('data', (data) =>
            socket.end(
                Buffer.from(
                    Array.from({ length: Number(data.toString().trim()) }, (_, i) => i % 251),
                ),
            ),
        );
    });
    await new Promise((r) => server.listen(8059, '127.0.0.1', r));
    const proxy = await shapedProxy(8159, 8059);
    proxy.configure(profile);
    try {
        const measurements = [];
        for (const size of [64, 64, 64, 128 * 1024]) {
            const start = performance.now();
            await new Promise((resolve, reject) => {
                const s = net.connect(8159, '127.0.0.1', () => s.write(size + '\n'));
                let received = 0;
                const chunks = [];
                s.on('data', (d) => {
                    received += d.length;
                    chunks.push(d);
                    if (received === size) {
                        assert(
                            Buffer.concat(chunks).every((value, i) => value === i % 251),
                            'Proxy changed byte ordering',
                        );
                        s.destroy();
                        resolve();
                    }
                });
                s.on('error', reject);
            });
            measurements.push({
                bytes: size,
                ms: performance.now() - start,
                expectedMs:
                    profile.rtt +
                    (size / profile.down) * 1000 +
                    (String(size).length / profile.up) * 1000,
            });
        }
        return measurements;
    } finally {
        await proxy.close();
        await new Promise((r) => server.close(r));
    }
}
(async () => {
    const browser = await chromium.launch({
        args: [
            ...(tlsOrigin ? ['--ignore-certificate-errors'] : []),
            ...(process.env.YAP_BROWSER_DEBUG_PORT
                ? ['--remote-debugging-port=' + process.env.YAP_BROWSER_DEBUG_PORT]
                : []),
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
    });
    report.browser = browser.version();
    try {
        for (const key of selected) {
            report.calibration[key] = await calibration(profiles[key]);
            for (const m of report.calibration[key])
                assert(
                    Math.abs(m.ms - m.expectedMs) < Math.max(80, m.expectedMs * 0.12),
                    'Link calibration outside tolerance',
                );
            save();
            console.log(
                'CALIBRATED',
                key,
                report.calibration[key].map((v) => Math.round(v.ms)),
            );
            // Alternate order to reduce bias from one version always running first.
            const labels =
                key === 'latency900' ? ['rewrite', 'reference'] : ['reference', 'rewrite'];
            for (const label of labels) {
                if (
                    report.cases.some(
                        (c) =>
                            c.profile === key &&
                            c.label === label &&
                            (c.inactive.length || c.startupOnly) &&
                            !c.error,
                    )
                )
                    continue;
                report.cases = report.cases.filter((c) => c.profile !== key || c.label !== label);
                console.log('BEGIN', key, label);
                const backendPort = label === 'reference' ? 8051 : 8052;
                const proxy = await shapedProxy(8151, backendPort, tlsOrigin);
                proxy.configure(profiles[key]);
                const people = fixture[key].people;
                const row = {
                    profile: key,
                    label,
                    startup: [],
                    sends: [],
                    receives: [],
                    inactive: [],
                };
                report.cases.push(row);
                save();
                let retained, lastPage;
                try {
                    for (let trial = 0; trial < trials; trial++) {
                        const c = await context(browser, people[0]);
                        const page = await c.newPage();
                        lastPage = page;
                        page.setDefaultTimeout(60000);
                        const counters = await instrumentation(c, page);
                        for (const cache of cacheStages) {
                            const before = proxy.totals(),
                                traffic = counters(),
                                start = performance.now();
                            await page.goto(proxy.origin + '/dm/' + people[1].username, {
                                waitUntil: 'commit',
                                timeout: 180000,
                            });
                            await ready(page);
                            const readyMs = performance.now() - start,
                                atReady = diff(proxy.totals(), before);
                            // Same observation horizon; includes optional downloads after UI readiness.
                            await sleep(15000);
                            const measurement = {
                                trial,
                                cache,
                                readyMs,
                                atReady,
                                after15s: diff(proxy.totals(), before),
                                pageTraffic: diff(counters(), traffic),
                            };
                            row.startup.push(measurement);
                            save();
                            console.log(
                                'STARTUP',
                                key,
                                label,
                                cache,
                                trial,
                                Math.round(readyMs),
                                measurement.after15s,
                            );
                            if (cache === 'cold' && label === 'rewrite') {
                                await page.evaluate(() => navigator.serviceWorker.ready);
                                await page.waitForFunction(
                                    () => !!navigator.serviceWorker.controller,
                                );
                                measurement.preparedByMs = performance.now() - start;
                                measurement.beforeNextReload = diff(proxy.totals(), before);
                                save();
                            }
                        }
                        if (trial === trials - 1) retained = { c, page, counters };
                        else {
                            await c.close();
                            await sleep(1200);
                        }
                    }
                    if (startupOnly) {
                        row.startupOnly = true;
                        await retained.c.close();
                        retained = null;
                        save();
                        console.log('DONE startup', key, label);
                        continue;
                    }
                    const { c, page, counters } = retained;
                    const receiverContext = await context(browser, people[1]);
                    const receiver = await receiverContext.newPage();
                    await receiver.goto(
                        `${scheme}://127.0.0.1:${backendPort}/dm/${people[0].username}`,
                    );
                    await ready(receiver);
                    await sleep(3000);
                    const idle = proxy.totals(),
                        idleTraffic = counters();
                    await sleep(10000);
                    row.idle10s = {
                        ...diff(proxy.totals(), idle),
                        ...diff(counters(), idleTraffic),
                    };
                    save();
                    for (let i = 0; i < samples; i++) {
                        const text = `Measured outgoing ${key} ${label} ${i} ${Date.now()}`;
                        await observe(page, text);
                        await observe(receiver, text);
                        const before = proxy.totals(),
                            traffic = counters();
                        const start = await clickSend(page, text);
                        const [own, other] = await Promise.all([
                            rendered(page),
                            rendered(receiver),
                        ]);
                        await sleep(3000);
                        row.sends.push({
                            localVisibleMs: own.visible - start,
                            ownAcceptedMs: own.accepted - start,
                            recipientMs: other.accepted - start,
                            ...diff(proxy.totals(), before),
                            ...diff(counters(), traffic),
                        });
                        save();
                    }
                    console.log('SENDS', key, label, row.sends);
                    for (let i = 0; i < samples; i++) {
                        const text = `Measured incoming ${key} ${label} ${i} ${Date.now()}`;
                        await observe(page, text);
                        const before = proxy.totals(),
                            traffic = counters();
                        const start = await clickSend(receiver, text);
                        const result = await rendered(page);
                        await sleep(3000);
                        row.receives.push({
                            visibleMs: result.accepted - start,
                            ...diff(proxy.totals(), before),
                            ...diff(counters(), traffic),
                        });
                        save();
                    }
                    const otherContext = await context(browser, people[2]);
                    const other = await otherContext.newPage();
                    await other.goto(
                        `${scheme}://127.0.0.1:${backendPort}/dm/${people[0].username}`,
                    );
                    await other.locator('.message-input:enabled').waitFor();
                    await sleep(3000);
                    const inactiveText = `Measured inactive ${key} ${label} ${Date.now()}`;
                    const before = proxy.totals(),
                        traffic = counters();
                    const badgeBefore = await page.evaluate(
                        (name) =>
                            Number(
                                [...document.querySelectorAll('.user-item')]
                                    .find(
                                        (n) =>
                                            n.querySelector('.user-name')?.textContent.trim() ===
                                            name,
                                    )
                                    ?.querySelector('.unread-badge')?.textContent || 0,
                            ),
                        people[2].username,
                    );
                    const start = await clickSend(other, inactiveText);
                    await page.waitForFunction(
                        ({ name, before }) =>
                            [...document.querySelectorAll('.user-item')].some(
                                (n) =>
                                    n.querySelector('.user-name')?.textContent.trim() === name &&
                                    Number(n.querySelector('.unread-badge')?.textContent) > before,
                            ),
                        { name: people[2].username, before: badgeBefore },
                        { timeout: 60000 },
                    );
                    const inactiveMs = Date.now() - start;
                    await sleep(2000);
                    row.inactive.push({
                        visibleMs: inactiveMs,
                        ...diff(proxy.totals(), before),
                        ...diff(counters(), traffic),
                    });
                    save();
                    await otherContext.close();
                    await receiverContext.close();
                    await c.close();
                    retained = null;
                    console.log('DONE', key, label);
                } catch (error) {
                    row.error = error.message;
                    if (lastPage && !lastPage.isClosed()) {
                        row.failureView = await lastPage
                            .evaluate(() => ({
                                url: location.pathname,
                                text: document.body.innerText.slice(0, 1200),
                            }))
                            .catch(() => null);
                        await lastPage
                            .screenshot({ path: path.join(output, `${key}-${label}-failure.png`) })
                            .catch(() => {});
                    }
                    save();
                    throw error;
                } finally {
                    if (retained) await retained.c.close();
                    await proxy.close();
                }
            }
        }
        save();
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
