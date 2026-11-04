// E02 lazy-tus, the proof of mechanism. Two short-lived servers on a copy of the perf seed: A (main, the harness
// worktree) on 5323 and B (perf/02-lazy-tus) on 5324, each behind the harness's proxy 100 ports above.
//
// Part 1, the shell: curl `/` with the measured person's cookie from each server and list its <script src> tags.
// Part 2, the cost: on the `far` link (900 ms round trip, 1 Mbit/s) a fresh context opens `/`, waits for the `rows`
// mark and sends one small PNG through the composer; then the page reloads (the worker now controls it) and sends
// one again. Each attach is timed in the page's clock from the Send click to the start of the first request to the
// tus route (/api/tus), to that POST's response, and to the row confirmed (its pending mark gone). The tus script's
// own resource entry and the proxy's request lines say whether /lib/tus.min.js crossed the link during the attach.
// Three repetitions per side, in the order A B, B A, A B.
//
// Run: node probe-tus.mjs <results dir>   (from anywhere; the imports are absolute)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, waitTrue, sendFiles, makePng, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { startProxy } from '/home/agent/yap-perf/harness/tests/browser/proxy.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';
import { instruments } from '/home/agent/yap-perf/harness/tests/browser/perf-journeys.mjs';

const OUT = process.argv[2] ?? path.dirname(new URL(import.meta.url).pathname);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNS = path.join(HERE, 'runs');
const SEED = '/home/agent/yap-perf/seed';
const FAR = { oneWayMs: 450, bytesPerSec: 125_000 };   // perf.mjs PROFILES.far
const REPS = 3;
// --no-worker: the bound. Service workers blocked, so no precache fills the HTTP cache before the attach and the lazy
// load must cross the link (a browser without a worker, or an attach before the precache reached the file). The first
// page only; the shell check is skipped.
const NOWORKER = process.argv.includes('--no-worker');
const SUFFIX = NOWORKER ? '-noworker' : '';
const WHENS = NOWORKER ? ['first'] : ['first', 'warm'];

const seed = readSeed(SEED);
const png = makePng(path.join(HERE, 'probe.png'), [220, 30, 30]);
const sides = [
  { key: 'A', dir: '/home/agent/yap-perf/harness', port: 5323 },
  { key: 'B', dir: '/home/agent/yap-perf/exp/02-lazy-tus', port: 5324 },
];

// The PID of the dotnet process that listens on `port` (startServer keeps its child to itself): logged, and killed
// by number if stop() left it behind. Never a kill by name: other agents run Yap.dll servers on this machine.
function pidOn(port) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').includes(`http://127.0.0.1:${port}`)) return Number(d); } catch { /* gone */ }
  }
  return null;
}

const log = [];
const say = s => { console.log(s); log.push(s); };

for (const s of sides) {
  s.server = await startServer({ dll: path.join(s.dir, 'Yap/bin/Debug/net10.0/Yap.dll'), wwwroot: path.join(s.dir, 'Yap/wwwroot'),
    port: s.port, scratch: RUNS, prepare: copySeed(SEED), args: SERVER_ARGS });
  s.base = s.server.base;
  s.pid = pidOn(s.port);
  s.proxy = startProxy({ port: s.port + 100, upstream: s.port });
  s.token = await signInToken(s.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
  say(`${s.key}: ${s.dir} on ${s.base} (PID ${s.pid}), proxy ${s.proxy.origin}`);
}

try {
  // ---- part 1: the signed-in shell ----
  say('\n## Part 1: the signed-in shell, curl');
  for (const s of NOWORKER ? [] : sides) {
    const file = path.join(HERE, `shell-${s.key}.html`);
    const meta = execFileSync('curl', ['-s', '-o', file, '-w', '%{http_code} %{size_download}', '-b', `yap_auth=${s.token}`, `${s.base}/`], { encoding: 'utf8' });
    const html = fs.readFileSync(file, 'utf8');
    const build = /data-build="([^"]*)"/.exec(html)?.[1];
    const tags = html.match(/<script\b[^>]*\bsrc="[^"]*"[^>]*>/g) ?? [];
    say(`${s.key}: GET / -> ${meta} bytes; data-build ${build}; <script src> tags: ${tags.length}`);
    for (const t of tags) say(`  ${t}`);
    say(`  tus.min.js tag present: ${tags.some(t => /tus\.min\.js/.test(t))}`);
    // Chromium asks for br only over HTTPS: over the harness's plain HTTP the page gets gzip, production gets br.
    const size = enc => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', ...(enc ? ['-H', `Accept-Encoding: ${enc}`] : []),
      `${s.base}/lib/tus.min.js?v=${encodeURIComponent(build)}`], { encoding: 'utf8' });
    say(`  /lib/tus.min.js?v=<stamp>: br ${size('br')}, gzip ${size('gzip')}, raw ${size(null)} (status bytes)`);
    fs.rmSync(file);
  }

  // ---- part 2: the cost of the first upload ----
  say('\n## Part 2: the attach, far (900 ms round trip, 1 Mbit/s)');
  const browser = await chromium.launch();
  const auth = s => [{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];
  // The person stays online through a page off the proxy, as in perf.mjs: otherwise the own join line (italic font,
  // 380 KB) depends on the order of the runs and loads on the link during the attach.
  for (const s of sides) {
    const ctx = await browser.newContext();
    await ctx.addCookies(auth(s));
    const page = await ctx.newPage();
    await page.goto(s.base + '/settings');
    if (!await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error(`keeper ${s.key} did not connect`);
  }
  for (const s of sides) s.proxy.set(FAR);

  const isTus = url => /\/api\/tus(\/|$|\?)/.test(new URL(url).pathname + '/');
  const isScript = url => /\/lib\/tus\.min\.js/.test(url);

  // One attach on a page that shows the rows: the timings in the page's clock, and what crossed the link.
  async function attach(page, s, reqs) {
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    const tusBefore = await page.evaluate(() => typeof window.tus !== 'undefined');
    await page.evaluate(() => {
      let seen = false;
      window.__perf.watch('confirmed', () => { const p = document.querySelector('.message-group.pending'); if (p) seen = true; return seen && !p; }, { timeout: 120_000 });
    });
    const from = reqs.length;
    s.proxy.reset();
    await sendFiles(page, png);   // the pick, the tray, Send
    if (!await waitTrue(() => reqs.slice(from).some(r => isTus(r.url)), 60_000, 20)) throw new Error('no request to /api/tus within 60 s');
    const lines = s.proxy.counters().lines;   // up to the first tus request
    const t = await page.evaluate(async () => {
      const click = window.__perf.input.click;
      const entry = test => performance.getEntriesByType('resource').filter(e => test(e.name) && e.startTime >= click - 1);
      // The POST's entry lands when its response ends.
      const end = performance.now() + 60_000;
      while (!entry(n => /\/api\/tus$/.test(new URL(n).pathname)).length && performance.now() < end) await new Promise(r => setTimeout(r, 20));
      const confirmed = await window.__perf.watches.confirmed;
      const post = entry(n => /\/api\/tus$/.test(new URL(n).pathname))[0];
      const script = entry(n => /\/lib\/tus\.min\.js/.test(n))[0];
      return {
        postStart: post ? post.startTime - click : null, postEnd: post ? post.responseEnd - click : null,
        confirmed: confirmed == null ? null : confirmed - click,
        scriptStart: script ? script.startTime - click : null, scriptEnd: script ? script.responseEnd - click : null,
        scriptTransfer: script ? script.transferSize : null, scriptWorker: script ? script.workerStart > 0 : null,
        failed: !!document.querySelector('.message-group.failed'),
      };
    });
    const pageScript = reqs.slice(from).find(r => isScript(r.url));
    const resp = pageScript ? await pageScript.req.response().catch(() => null) : null;
    return { controlled, tusBefore, ...t,
      scriptRequested: !!pageScript, scriptFromWorker: resp ? resp.fromServiceWorker() : null,
      scriptCrossed: lines.some(l => /tus\.min\.js/.test(l)), linesBeforePost: lines.length,
      lines: lines.map(l => l.replace(/ HTTP\/1\.1$/, '')).slice(0, 60) };
  }

  const results = [];
  for (let rep = 1; rep <= REPS; rep++) {
    for (const s of rep % 2 ? sides : [...sides].reverse()) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: NOWORKER ? 'block' : 'allow' });
      await ctx.addCookies(auth(s));
      await ctx.addInitScript(instruments);
      const page = await ctx.newPage();
      const reqs = [];
      page.on('request', r => reqs.push({ url: r.url(), req: r }));
      try {
        s.proxy.reset();
        await page.goto(s.proxy.origin + '/', { waitUntil: 'commit' });
        await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
        const rows = await page.evaluate(() => performance.getEntriesByName('rows', 'mark')[0].startTime);
        // The cold open up to the attach: does tus.min.js cross the link without the tag (the worker's precache)?
        const open = s.proxy.counters();
        const openTus = open.lines.filter(l => /tus\.min\.js/.test(l)).length;
        const pageTusAtOpen = reqs.filter(r => isScript(r.url)).length;
        const first = await attach(page, s, reqs);
        const brief = r => `click->POST ${r.postStart?.toFixed(0)} ms, ->POST end ${r.postEnd?.toFixed(0)}, ->confirmed ${r.confirmed?.toFixed(0)}; ` +
          `controlled ${r.controlled}, tus before ${r.tusBefore}; script entry ${r.scriptStart == null ? 'none' : `${r.scriptStart.toFixed(0)}..${r.scriptEnd.toFixed(0)} ms, transfer ${r.scriptTransfer} B`}` +
          `, from worker ${r.scriptFromWorker}; crossed the proxy ${r.scriptCrossed}; proxy lines before the POST ${r.linesBeforePost}${r.failed ? '; FAILED ROW' : ''}`;
        say(`${s.key}#${rep} open up to the attach: ${open.requests} requests crossed, tus.min.js crossed ${openTus}x, page requested it ${pageTusAtOpen}x`);
        const openFacts = { requests: open.requests, kb: (open.up + open.down) / 1024, tusLines: openTus, pageTusRequests: pageTusAtOpen };
        if (NOWORKER) {
          results.push({ side: s.key, rep, rows, open: openFacts, first });
          say(`${s.key}#${rep} rows ${rows.toFixed(0)} ms\n  first page: ${brief(first)}`);
          continue;   // the finally below closes the context
        }
        // The reload must meet an installed worker with the shell stored: wait for it and for a quiet link.
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
        await sleep(1000);
        await page.reload({ waitUntil: 'commit' });
        await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
        const warm = await attach(page, s, reqs);
        results.push({ side: s.key, rep, rows, open: openFacts, first, warm });
        say(`${s.key}#${rep} rows ${rows.toFixed(0)} ms\n  first page: ${brief(first)}\n  warm page:  ${brief(warm)}`);
      } catch (e) {
        say(`${s.key}#${rep} FAILED: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: path.join(OUT, `probe-fail-${s.key}${rep}.png`) }).catch(() => {});
      } finally { await ctx.close(); }
    }
  }
  await browser.close();

  const median = v => { const x = v.filter(Number.isFinite).sort((a, b) => a - b); return x.length ? (x.length % 2 ? x[x.length >> 1] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null; };
  say('\n## Medians (ms, page clock, from the Send click)');
  say('| attach | metric | A | B | B - A |');
  say('| --- | --- | --: | --: | --: |');
  for (const when of WHENS) {
    for (const m of ['postStart', 'postEnd', 'confirmed']) {
      const a = median(results.filter(r => r.side === 'A').map(r => r[when][m]));
      const b = median(results.filter(r => r.side === 'B').map(r => r[when][m]));
      say(`| ${when} | ${m} | ${a?.toFixed(0)} | ${b?.toFixed(0)} | ${a != null && b != null ? (b - a).toFixed(0) : '-'} |`);
    }
  }
  for (const when of WHENS) {
    for (const k of ['A', 'B']) {
      const rs = results.filter(r => r.side === k).map(r => r[when]);
      say(`${when} ${k}: tus.min.js crossed the proxy in ${rs.filter(r => r.scriptCrossed).length}/${rs.length}; page requested it in ${rs.filter(r => r.scriptRequested).length}/${rs.length}; from the worker in ${rs.filter(r => r.scriptFromWorker).length}/${rs.length}; page controlled at attach in ${rs.filter(r => r.controlled).length}/${rs.length}`);
    }
  }
  fs.writeFileSync(path.join(OUT, `probe-tus${SUFFIX}.json`), JSON.stringify(results, null, 1));
} finally {
  for (const s of sides) {
    s.proxy.close();
    const issues = await s.server.stop();
    if (issues.length) say(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
    if (s.pid && fs.existsSync(`/proc/${s.pid}`)) { process.kill(s.pid, 'SIGKILL'); say(`server ${s.key}: PID ${s.pid} killed by number`); }
    else say(`server ${s.key}: PID ${s.pid} stopped`);
  }
  fs.writeFileSync(path.join(OUT, `probe-tus${SUFFIX}.log`), log.join('\n') + '\n');
}
process.exit(0);
