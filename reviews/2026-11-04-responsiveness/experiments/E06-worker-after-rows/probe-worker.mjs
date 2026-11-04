// E06 proof of mechanism: when does the service worker's install start its fetches, against the `rows` mark of a
// first visit on the `far` link? One cold open per side, A (main) then B (perf/06-worker-after-rows).
//
// Each side: its own server on a copy of the seed (lib.mjs startServer, as perf.mjs starts it), the harness's proxy
// (proxy.mjs) at 100 above on the far settings, a keeper page on /settings (as perf.mjs: the person stays online, so
// no join line and no italic font), one untimed warm-up load off the proxy (the server's JIT). Then a fresh context
// with only the seed's cookie navigates to `/` through the proxy, waits for the `rows` mark, waits 20 s more, and reads:
//   - the page's marks and its resource entries;
//   - the worker's own resource entries (cache.add() in the install is a fetch of the worker, never an entry of the
//     page), turned into the page's clock through the two timeOrigins;
//   - every HTTP request line the proxy saw, time-stamped here when the browser's bytes reached the proxy (before the
//     link's delay), also in the page's clock;
//   - the proxy's byte counters at the rows mark and at the end: what the harness's "wire KB" window holds.
//   - navigator.serviceWorker.controller.
// The worker's network events are not switched on (PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS): the harness runs
// without them, and the probe must load the page the same way.
//
// Run: node probe-worker.mjs --a=<worktree> --b=<worktree> --port-a=5333 --port-b=5334 --out=<json file>

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, waitTrue, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { startProxy } from '/home/agent/yap-perf/harness/tests/browser/proxy.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const FAR = { oneWayMs: 450, bytesPerSec: 125_000 };
const seedDir = '/home/agent/yap-perf/seed';
const runsDir = '/home/agent/yap-perf/runs';
const seed = readSeed(seedDir);
const sides = [
  { key: 'A', dir: arg('a'), port: Number(arg('port-a', 5333)) },
  { key: 'B', dir: arg('b'), port: Number(arg('port-b', 5334)) },
];
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const cookie = token => [{ name: 'yap_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];

const browser = await chromium.launch();
const results = {};
try {
  for (const s of sides) results[s.key] = await probe(s);
} finally {
  await browser.close();
}
fs.writeFileSync(arg('out'), JSON.stringify(results, null, 1));
for (const [key, r] of Object.entries(results)) printSummary(key, r);
process.exit(0);

async function probe(s) {
  const server = await startServer({ dll: path.join(s.dir, 'Yap/bin/Debug/net10.0/Yap.dll'), wwwroot: path.join(s.dir, 'Yap/wwwroot'),
    port: s.port, scratch: runsDir, prepare: copySeed(seedDir), args: SERVER_ARGS });
  const proxy = startProxy({ port: s.port + 100, upstream: s.port });
  const contexts = [];
  try {
    const token = await signInToken(server.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);

    // The warm-up load (off the proxy), then the same page idles on Settings for the rest of the probe.
    const keeper = await browser.newContext(DESKTOP);
    contexts.push(keeper);
    await keeper.addCookies(cookie(token));
    const kp = await keeper.newPage();
    await kp.goto(server.base + '/', { waitUntil: 'commit' });
    await kp.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 60_000, polling: 100 });
    await kp.goto(server.base + '/settings');
    if (!await waitTrue(() => kp.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error(`keeper of ${s.key} did not connect`);
    await sleep(2000);

    // The measured first visit.
    proxy.set(FAR);
    const ctx = await browser.newContext(DESKTOP);
    contexts.push(ctx);
    await ctx.addCookies(cookie(token));
    const page = await ctx.newPage();

    // The proxy's request lines, time-stamped as they arrive (the proxy keeps no times of its own).
    proxy.reset();
    const lines = [];
    let seen = 0;
    const tick = setInterval(() => {
      const c = proxy.counters();
      for (; seen < c.lines.length; seen++) lines.push({ at: Date.now(), line: c.lines[seen] });
    }, 5);

    // The worker's entries, read every second while it lives: a worker that stops and starts again loses them.
    let worker = null;
    const workerReads = [];
    ctx.on('serviceworker', w => { worker = w; });
    const readWorker = async () => {
      const w = worker ?? ctx.serviceWorkers()[0];
      if (!w) return;
      try {
        const r = await w.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin,
          entries: performance.getEntriesByType('resource').map(e => ({ name: e.name, start: e.startTime, end: e.responseEnd, initiator: e.initiatorType, transfer: e.transferSize, body: e.encodedBodySize })) }));
        if (!workerReads.length || r.entries.length >= workerReads.at(-1).entries.length) workerReads.push({ at: Date.now(), ...r });
      } catch { /* the worker is between states */ }
    };
    const workerTick = setInterval(readWorker, 1000);

    await page.goto(proxy.origin + '/', { waitUntil: 'commit' });
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  ${s.key} console.${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', e => console.log(`  ${s.key} pageerror: ${e.message}`));
    try {
      await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
    } catch (e) {
      // What the page shows and what crossed the link, for a page that never reached its rows.
      const dir = path.dirname(arg('out'));
      await page.screenshot({ path: path.join(dir, `probe-fail-${s.key}.png`) }).catch(() => {});
      const marks = await page.evaluate(() => performance.getEntriesByType('mark').map(m => `${m.name} ${Math.round(m.startTime)}`)).catch(() => []);
      console.log(`${s.key}: no rows mark. url ${page.url()}; marks ${marks.join(', ')}; ${lines.length} request lines, last: ${lines.slice(-5).map(l => l.line).join(' | ')}`);
      throw e;
    }
    const atRows = proxy.counters();
    const rowsWallClock = Date.now();
    await sleep(20_000);
    await readWorker();
    clearInterval(workerTick);
    clearInterval(tick);
    const atEnd = proxy.counters();

    const pageFacts = await page.evaluate(async () => {
      const mark = n => performance.getEntriesByName(n, 'mark')[0]?.startTime ?? null;
      const [nav] = performance.getEntriesByType('navigation');
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        timeOrigin: performance.timeOrigin,
        marks: { html: nav?.responseEnd ?? null, scripts: mark('scripts'), bootstrap: mark('bootstrap'), paint: mark('paint'), socket: mark('socket'), rows: mark('rows') },
        resources: performance.getEntriesByType('resource').map(e => ({ name: e.name, start: e.startTime, end: e.responseEnd, initiator: e.initiatorType, transfer: e.transferSize })),
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
        registration: reg ? { active: reg.active?.state ?? null, installing: !!reg.installing, waiting: !!reg.waiting } : null,
      };
    });
    const toPage = t => Math.round((t - pageFacts.timeOrigin) * 10) / 10;
    const w = workerReads.at(-1) ?? null;
    return {
      side: s.key, dir: s.dir, port: s.port,
      marks: pageFacts.marks,
      controller: pageFacts.controller, registration: pageFacts.registration,
      rowsWallClockInPage: toPage(rowsWallClock),
      wireAtRowsKB: Math.round((atRows.up + atRows.down) / 102.4) / 10, wireRequestsAtRows: atRows.requests,
      wireAtEndKB: Math.round((atEnd.up + atEnd.down) / 102.4) / 10, wireRequestsAtEnd: atEnd.requests,
      proxyLines: lines.map(l => ({ at: toPage(l.at), line: l.line })),
      pageResources: pageFacts.resources,
      worker: w && { url: w.url, timeOriginInPage: toPage(w.timeOrigin),
        entries: w.entries.map(e => ({ ...e, startInPage: toPage(w.timeOrigin + e.start), endInPage: toPage(w.timeOrigin + e.end) })) },
    };
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    proxy.close();
    const issues = await server.stop();   // kills its own child process, by its handle
    if (issues.length) console.log(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
  }
}

function printSummary(key, r) {
  const origin = `http://127.0.0.1:${r.port + 100}`;
  const short = u => u.replace(origin, '');
  const swLine = r.proxyLines.find(l => /GET \/service-worker\.js/.test(l.line));
  const pagePaths = new Set(r.pageResources.map(e => short(e.name).split('#')[0]));
  pagePaths.add('/');
  // A request line after the worker script whose path the page never asked for: the install's own network fetch.
  // The hub (its WebSocket upgrade is never a resource entry of the page) and non-GET calls are the page's.
  const installLines = swLine ? r.proxyLines.filter(l => l.at >= swLine.at && /^GET /.test(l.line) && !/service-worker\.js|^GET \/hub/.test(l.line)
    && !pagePaths.has(l.line.split(' ')[1])) : [];
  const we = r.worker?.entries ?? [];
  const firstWorker = we.length ? we.reduce((a, b) => (a.startInPage <= b.startInPage ? a : b)) : null;
  const net = we.filter(e => e.transfer > 0);
  console.log(`\n== ${key} (${r.dir})`);
  console.log(`marks: ${Object.entries(r.marks).map(([k, v]) => `${k} ${v == null ? '-' : Math.round(v)}`).join(', ')}`);
  console.log(`worker script request (proxy): ${swLine ? `${Math.round(swLine.at)} ms` : 'none'}`);
  console.log(`first install fetch (worker's own entries): ${firstWorker ? `${Math.round(firstWorker.startInPage)} ms ${short(firstWorker.name)}` : 'none'}; worker entries ${we.length}, ${net.length} over the network, ${Math.round(net.reduce((s, e) => s + e.transfer, 0) / 1024)} KB`);
  console.log(`first install request on the wire (proxy, a path the page never asked for): ${installLines[0] ? `${Math.round(installLines[0].at)} ms ${installLines[0].line}` : 'none'}; ${installLines.length} such lines`);
  console.log(`wire at rows: ${r.wireAtRowsKB} KB, ${r.wireRequestsAtRows} requests; at rows + 20 s: ${r.wireAtEndKB} KB, ${r.wireRequestsAtEnd} requests`);
  console.log(`controller at the end: ${r.controller ?? 'none'}; registration ${JSON.stringify(r.registration)}`);
}
