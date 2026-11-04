// E05 probe: where do the emoji-toggle sprites (emoji_selection_*) and notif.mp3 load, on A (main) and on B (WebP
// sprites, mp3 without cover art)? One cold open per side through the harness proxy on `far`, then 20 s of idle, then
// a click on the emoji toggle and 5 s more. Every request for those files is listed with its time from the navigation
// start, whether it came before the `rows` mark, its size, and who asked: the page, or the service worker (its
// install fetches the whole precache list). Three views, so one can check the other:
//   - Playwright's context events (with PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 they include the worker's
//     fetches, marked by request.serviceWorker());
//   - the page's and the worker's own resource timing (transferSize 0 = the HTTP cache or the worker's cache);
//   - the proxy's request lines, time-stamped by a 20 ms poll: what really crossed the link.
// Servers: startServer() of lib.mjs on a copy of the seed (as perf.mjs starts them), stopped by stop() and then, if
// the PID still listens, killed by that PID. Never by name: other agents run Yap.dll servers on this machine.
//
// Run: node probe-sprites.mjs   (from anywhere; the harness modules are imported by absolute path)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const H = '/home/agent/yap-perf/harness/tests/browser';
const { chromium } = await import(`${H}/node_modules/playwright/index.mjs`);
const { startServer, waitTrue, sleep } = await import(`${H}/lib.mjs`);
const { startProxy } = await import(`${H}/proxy.mjs`);
const { SERVER_ARGS, readSeed, copySeed, signInToken } = await import(`${H}/perf-seed.mjs`);

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';   // read at launch: the context then sees the worker's fetches

const FAR = { oneWayMs: 450, bytesPerSec: 125_000 };   // perf.mjs PROFILES.far
const SEED = '/home/agent/yap-perf/seed', RUNS = '/home/agent/yap-perf/runs';
const SIDES = [
  { key: 'A', dir: '/home/agent/yap-perf/harness', port: 5343 },
  { key: 'B', dir: '/home/agent/yap-perf/exp/05-sprites-webp-mp3', port: 5344 },
];
const WATCH = /emoji_selection|notif\.mp3/;
const seed = readSeed(SEED);
const out = { sides: {} };

const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
const listener = port => { try { return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return ''; } };

for (const s of SIDES) {
  const dll = path.join(s.dir, 'Yap/bin/Debug/net10.0/Yap.dll'), wwwroot = path.join(s.dir, 'Yap/wwwroot');
  const server = await startServer({ dll, wwwroot, port: s.port, scratch: RUNS, prepare: copySeed(SEED), args: SERVER_ARGS });
  const pid = listener(s.port);
  console.log(`\n== ${s.key}: server pid ${pid} on ${server.base}`);
  const proxy = startProxy({ port: s.port + 100, upstream: s.port });
  const token = await signInToken(server.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
  const browser = await chromium.launch();
  const cookie = [{ name: 'yap_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];
  const result = { pid };
  try {
    // The keeper page of perf.mjs: the person stays online, so the cold open draws no italic join line.
    const keeperCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await keeperCtx.addCookies(cookie);
    const keeper = await keeperCtx.newPage();
    await keeper.goto(server.base + '/settings');
    if (!await waitTrue(() => keeper.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error('keeper did not connect');

    // The worker's precache list as the server writes it.
    const swText = await (await fetch(server.base + '/service-worker.js')).text();
    const shell = JSON.parse(/const SHELL_URLS = (\[.*?\]);/s.exec(swText)[1]);
    result.precache = { count: shell.length, watched: shell.filter(u => WATCH.test(u)),
      has: Object.fromEntries(['/emoji_selection_color.png', '/emoji_selection_greys.png', '/emoji_selection_color.webp', '/emoji_selection_greys.webp', '/notif.mp3'].map(u => [u, shell.includes(u)])) };

    proxy.set(FAR);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookie);
    const reqs = [];
    ctx.on('request', r => {
      if (!WATCH.test(r.url())) return;
      reqs.push({ r, at: Date.now(), url: new URL(r.url()).pathname, by: r.serviceWorker() ? 'worker' : 'page', range: r.headers().range ?? null });
    });
    const page = await ctx.newPage();
    // The proxy's request lines, time-stamped as they arrive from the browser.
    proxy.reset();
    const wire = [];
    let seen = 0;
    const poll = setInterval(() => { const c = proxy.counters(); for (; seen < c.lines.length; seen++) wire.push({ at: Date.now(), line: c.lines[seen] }); }, 20);
    const t0 = Date.now();
    await page.goto(proxy.origin + '/', { waitUntil: 'commit' });
    await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
    const { origin0, rows } = await page.evaluate(() => ({ origin0: performance.timeOrigin, rows: performance.getEntriesByName('rows', 'mark')[0].startTime }));
    const wireAtRows = proxy.counters();
    await sleep(20_000);
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    const clickAt = Date.now();
    await page.click('.emoji-toggle-button');
    await sleep(5_000);
    clearInterval(poll);

    const pageEntries = await page.evaluate(re => performance.getEntriesByType('resource').filter(e => new RegExp(re).test(e.name))
      .map(e => ({ url: new URL(e.name).pathname, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, body: e.encodedBodySize, initiator: e.initiatorType, viaWorker: e.workerStart > 0 })), WATCH.source);
    let workerEntries = [];
    const sw = ctx.serviceWorkers()[0];
    if (sw) {
      workerEntries = await sw.evaluate(re => performance.getEntriesByType('resource').filter(e => new RegExp(re).test(e.name))
        .map(e => ({ url: new URL(e.name).pathname, start: performance.timeOrigin + e.startTime, end: performance.timeOrigin + e.responseEnd, transfer: e.transferSize, body: e.encodedBodySize })), WATCH.source).catch(() => []);
      workerEntries = workerEntries.map(e => ({ ...e, start: e.start - origin0, end: e.end - origin0 }));
    }
    const allWorker = sw ? await sw.evaluate(() => performance.getEntriesByType('resource').map(e => [performance.timeOrigin + e.startTime, performance.timeOrigin + e.responseEnd, e.transferSize])).catch(() => []) : [];

    const events = [];
    for (const q of reqs) {
      const res = await within(q.r.response(), 3000).catch(() => null);
      let sizes = null;
      try { sizes = await within(q.r.sizes(), 3000); } catch { /* not finished */ }
      events.push({ url: q.url, by: q.by, at: Math.round(q.at - origin0), beforeRows: q.at - origin0 < rows, range: q.range,
        status: res?.status() ?? null, fromWorker: res?.fromServiceWorker() ?? null, contentLength: res ? Number(res.headers()['content-length'] ?? NaN) : null,
        responseBody: sizes?.responseBodySize ?? null });
    }
    const crossed = wire.filter(w => WATCH.test(w.line)).map(w => ({ at: Math.round(w.at - origin0), beforeRows: w.at - origin0 < rows, line: w.line }));
    Object.assign(result, {
      navToNodeStartMs: Math.round(origin0 - t0), rowsMs: Math.round(rows), controlledAtClick: controlled, clickMs: Math.round(clickAt - origin0),
      wireAtRowsKB: Math.round((wireAtRows.up + wireAtRows.down) / 1024), wireAtRowsRequests: wireAtRows.requests,
      wireTotalKB: Math.round((proxy.counters().up + proxy.counters().down) / 1024), wireTotalRequests: proxy.counters().requests,
      workerFetches: allWorker.length,
      workerFirstMs: allWorker.length ? Math.round(Math.min(...allWorker.map(e => e[0])) - origin0) : null,
      workerLastEndMs: allWorker.length ? Math.round(Math.max(...allWorker.map(e => e[1])) - origin0) : null,
      workerTransferKB: Math.round(allWorker.reduce((sum, e) => sum + (e[2] || 0), 0) / 1024),
      events, pageEntries: pageEntries.map(e => ({ ...e, start: Math.round(e.start), end: Math.round(e.end), beforeRows: e.start < rows })),
      workerEntries: workerEntries.map(e => ({ ...e, start: Math.round(e.start), end: Math.round(e.end), beforeRows: e.start < rows })),
      crossed,
    });
    await ctx.close();
    await keeperCtx.close();
  } finally {
    await browser.close();
    proxy.close();
    const issues = await server.stop();
    if (issues.length) console.log(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
    // stop() kills the child it spawned; if that PID still listens, kill it by number.
    if (pid && listener(s.port) === pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    console.log(`${s.key}: port ${s.port} listener after stop: '${listener(s.port)}'`);
  }
  out.sides[s.key] = result;

  console.log(`precache: ${result.precache.count} URLs; watched: ${result.precache.watched.join(', ')}`);
  console.log(`rows ${result.rowsMs} ms; click ${result.clickMs} ms; controlled at click: ${result.controlledAtClick}`);
  console.log(`wire at rows: ${result.wireAtRowsKB} KB, ${result.wireAtRowsRequests} requests; total to the end: ${result.wireTotalKB} KB, ${result.wireTotalRequests} requests`);
  console.log(`worker fetches: ${result.workerFetches}, first at ${result.workerFirstMs} ms, last end ${result.workerLastEndMs} ms, ${result.workerTransferKB} KB transferred`);
  console.log('Playwright requests (at = ms from navigation start):');
  for (const e of result.events) console.log(`  ${e.at.toString().padStart(6)} ${e.beforeRows ? 'before' : 'after '} rows  ${e.by.padEnd(6)} ${e.url}  status ${e.status} fromWorker ${e.fromWorker} content-length ${e.contentLength} body ${e.responseBody}${e.range ? ' range ' + e.range : ''}`);
  console.log('page resource timing:');
  for (const e of result.pageEntries) console.log(`  ${String(e.start).padStart(6)}..${e.end} ${e.beforeRows ? 'before' : 'after '} rows  ${e.url}  transfer ${e.transfer} body ${e.body} ${e.initiator}${e.viaWorker ? ' via worker' : ''}`);
  console.log('worker resource timing:');
  for (const e of result.workerEntries) console.log(`  ${String(e.start).padStart(6)}..${e.end} ${e.beforeRows ? 'before' : 'after '} rows  ${e.url}  transfer ${e.transfer} body ${e.body}`);
  console.log('crossed the proxy:');
  for (const w of result.crossed) console.log(`  ${String(w.at).padStart(6)} ${w.beforeRows ? 'before' : 'after '} rows  ${w.line}`);
}

const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'probe-sprites.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\njson: ${file}`);
process.exit(0);
