// E04 proof of mechanism: does the shell page and the worker script answer 304 on a device that has them?
//
// Two short-lived servers (A = main, B = the ETag branch), each on a copy of the perf seed, started as perf.mjs starts
// them plus the ASP.NET Core hosting log ("Request finished ... <status>"), each behind the harness proxy on `far`.
// Per side, one fresh context with the seed's cookie:
//   open   : goto / , wait for the rows, wait for the worker to control the page (its precache is done), pause 2 s;
//   reload : three reloads of the current URL, as the warm-open journey does, each waits for the rows, then 2 s;
//   goto / : three navigations to / (extra): the root is a SERVER_FIRST path of the worker, so the worker fetches the
//            page from the network there, while a reload of /lobby is answered from the worker's cache.
// For every step: the status of each GET of a shell route and of /service-worker.js from the server's log, and the
// proxy's bytes and request lines. The servers are stopped by their PID at the end.
//
// Run from anywhere (the harness's own modules and its Playwright are imported by absolute path):
//   node probe-etag.mjs [--harness=<dir>] [--a=<worktree>] [--b=<worktree>] [--port-a=5313] [--port-b=5314] [--out=<file.json>]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const HARNESS = arg('harness', '/home/agent/yap-perf/harness');
const BROWSER_DIR = path.join(HARNESS, 'tests', 'browser');
const { chromium } = createRequire(path.join(BROWSER_DIR, 'package.json'))('playwright');
const { startServer, sleep } = await import(path.join(BROWSER_DIR, 'lib.mjs'));
const { startProxy } = await import(path.join(BROWSER_DIR, 'proxy.mjs'));
const { SERVER_ARGS, readSeed, copySeed, signInToken } = await import(path.join(BROWSER_DIR, 'perf-seed.mjs'));

const FAR = { oneWayMs: 450, bytesPerSec: 125_000 };   // perf.mjs PROFILES.far
const HOSTING_LOG = '--Logging:LogLevel:Microsoft.AspNetCore.Hosting.Diagnostics=Information';
const seedDir = '/home/agent/yap-perf/seed';
const runsDir = '/home/agent/yap-perf/runs';
const outFile = arg('out', path.join(process.cwd(), 'probe-etag.json'));
const seed = readSeed(seedDir);

const sides = [
  { key: 'A', dir: arg('a', HARNESS), port: Number(arg('port-a', 5313)) },
  { key: 'B', dir: arg('b', '/home/agent/yap-perf/exp/04-etag-page-worker'), port: Number(arg('port-b', 5314)) },
];

// "Request finished HTTP/1.1 GET http://127.0.0.1:5314/service-worker.js?v=... - 304 - - 1.2ms"
const FINISHED = /Request finished HTTP\/[\d.]+ (\w+) (\S+) - (\d{3}) (\S+) (\S+) ([\d.]+)ms/;
const SHELL = /^\/(?:|lobby|login|settings|admin|room\/[^/]+|dm\/[^/]+|verify\/[^/]+|invite\/[^/]+|channel\/.*)$/;

function newRequests(s) {
  const text = fs.readFileSync(s.log, 'utf8');
  const fresh = text.slice(s.logAt);
  s.logAt = text.length;
  return fresh.split('\n').map(l => FINISHED.exec(l)).filter(Boolean)
    .map(([, method, url, status, length, type]) => ({ method, path: new URL(url).pathname + new URL(url).search, status: Number(status), length, type }));
}

const pidOn = port => Number(execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const s of sides) {
  s.dll = path.join(s.dir, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll');
  s.server = await startServer({ dll: s.dll, wwwroot: path.join(s.dir, 'Yap', 'wwwroot'), port: s.port, scratch: runsDir,
    prepare: copySeed(seedDir), args: [...SERVER_ARGS, HOSTING_LOG] });
  s.pid = pidOn(s.port);
  s.log = path.join(s.server.root, 'server.log');
  s.proxy = startProxy({ port: s.port + 100, upstream: s.port });
  s.token = await signInToken(s.server.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
  console.log(`${s.key}: ${s.dir} on ${s.port} (pid ${s.pid}), proxy ${s.proxy.origin}`);
}

// One GET with these headers; the body's bytes as they crossed (still compressed), not decoded.
function raw(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'] ?? 'identity', etag: res.headers.etag ?? null, bytes }));
    }).on('error', reject);
  });
}

const browser = await chromium.launch();
const results = [];
const rawChecks = [];
try {
  for (const s of sides) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    s.proxy.set(FAR);
    newRequests(s);   // skip the start and the sign-in
    const rows = () => page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
    const rowsAt = () => page.evaluate(() => Math.round(performance.getEntriesByName('rows', 'mark')[0].startTime));

    async function stepOf(name, go, settle = () => {}) {
      const from = await page.evaluate(() => location.pathname).catch(() => '(none)');
      s.proxy.reset();
      await go();
      await rows();
      const rowsMs = await rowsAt();
      await settle();
      await sleep(2000);   // the pause; the worker's update check of /service-worker.js lands in it
      const wire = s.proxy.counters();
      const requests = newRequests(s);
      const watched = requests.filter(r => r.method === 'GET' && (SHELL.test(r.path) || r.path.startsWith('/service-worker.js')));
      const step = {
        side: s.key, step: name, from, rowsMs, wireKB: +((wire.up + wire.down) / 1024).toFixed(1), downKB: +(wire.down / 1024).toFixed(1),
        wireRequests: wire.requests, wireLines: wire.lines, serverRequests: requests.length,
        watched: watched.map(r => `${r.path.replace(/\?v=.*/, '?v=…')} ${r.status}${r.status === 200 ? ` (${r.length} B)` : ''}`),
      };
      results.push(step);
      console.log(`${s.key} ${name.padEnd(9)} from ${from.padEnd(7)} rows ${String(rowsMs).padStart(5)} ms, wire ${String(step.wireKB).padStart(6)} KB in ${String(wire.requests).padStart(2)} requests; ${step.watched.join(', ') || '(no shell or worker GET)'}`);
    }

    // What the browser asks for and gets on the first navigation: the Accept-Encoding of Chromium on plain http
    // decides which compression the server uses, and so the page's size on the wire.
    page.once('request', async r => { s.navAcceptEncoding = (await r.allHeaders())['accept-encoding']; });
    page.once('response', async r => { const h = await r.allHeaders(); s.navResponse = { status: r.status(), encoding: h['content-encoding'] ?? 'identity', etag: h.etag ?? null }; });
    await stepOf('open /', () => page.goto(s.proxy.origin + '/', { waitUntil: 'commit' }),
      () => page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 120_000, polling: 100 }));
    console.log(`${s.key} first navigation: Accept-Encoding "${s.navAcceptEncoding}", answer ${JSON.stringify(s.navResponse)}`);
    for (let i = 1; i <= 3; i++) await stepOf(`reload ${i}`, () => page.reload({ waitUntil: 'commit' }));
    for (let i = 1; i <= 3; i++) await stepOf(`goto / ${i}`, () => page.goto(s.proxy.origin + '/', { waitUntil: 'commit' }));
    await ctx.close();
  }

  // The same answers without a browser (curl's role): the raw bytes of the body per encoding, then a second request
  // with If-None-Match set to the first answer's ETag. Straight to the server, no proxy.
  for (const s of sides) {
    for (const p of ['/', '/login', '/service-worker.js']) {
      for (const accept of ['gzip, deflate', 'gzip, deflate, br']) {
        const first = await raw(s.server.base + p, { cookie: `yap_auth=${s.token}`, 'accept-encoding': accept });
        const again = first.etag ? await raw(s.server.base + p, { cookie: `yap_auth=${s.token}`, 'accept-encoding': accept, 'if-none-match': first.etag }) : null;
        const line = { side: s.key, path: p, accept, first, again };
        rawChecks.push(line);
        console.log(`${s.key} ${p.padEnd(18)} ${accept.padEnd(17)} ${first.status} ${first.encoding.padEnd(8)} ${String(first.bytes).padStart(6)} B, ETag ${first.etag ?? '(none)'}`
          + (again ? `; with If-None-Match: ${again.status}, ${again.bytes} B` : ''));
      }
    }
  }
} finally {
  await browser.close();
  for (const s of sides) {
    s.proxy.close();
    await s.server.stop();   // SIGTERM to the child it spawned; the database flushes before the exit
    if (alive(s.pid)) process.kill(s.pid, 'SIGKILL');
    console.log(`${s.key}: pid ${s.pid} ${alive(s.pid) ? 'STILL RUNNING' : 'stopped'}`);
  }
}

fs.writeFileSync(outFile, JSON.stringify({ steps: results, raw: rawChecks,
  navigation: sides.map(s => ({ side: s.key, acceptEncoding: s.navAcceptEncoding, response: s.navResponse })) }, null, 1));
console.log(`\nwritten ${outFile}`);
