// E10 (direct-websocket-retry): the resume of a page that lived through a server outage, build A against build B.
//
// Why a probe and not a perf.mjs journey: the journey needs its server stopped and started again in the middle, and
// perf.mjs owns its servers for the whole run. This script starts the servers the way perf.mjs does (startServer from
// lib.mjs, a fresh copy of the seed, SERVER_ARGS, persistence on) and stops them by their own child process (PID).
//
// What it measures. On main, hub.js sets its negotiate flag when the direct WebSocket fails, and keeps it for the life
// of the page; a server outage fails the direct and the negotiated attempt, so every later connect of that page sends
// POST /hub/negotiate first. On the branch a double failure sets the flag back. Per profile and repetition, both sides
// at once (each on its own server and proxy):
//   1. a prepared page (perf.mjs prepared(): loaded at full speed, the worker in control, the snapshot stored) opens
//      the quiet room, not the lobby: after the outage the person's own join line can show in the lobby in italics
//      and pull the 380 KB italic font over the link, which would hide the effect;
//   2. the outage: the server stops; once the page made a direct and a negotiated attempt that both failed (logged),
//      the server starts again on the same port from a fresh copy of the seed (the seed's token is the account's);
//   3. `server back to connected`, and whether the reconnect sent POST /hub/negotiate;
//   4. two resumes as resumeAll of perf-journeys.mjs does them (hidden, debugger pause 35 s, the proxy's blackhole,
//      a message from someone else, thaw, the time to that message in the rows), with the /hub/negotiate count and
//      every request line that crossed the proxy during the resume.
// A control per side and profile does steps 1 and 4 without the outage: both sides should match there.
//
// Run: node probe-ws-retry.mjs [--profiles=far,near] [--n=5] [--control=2] [--out=<dir>] [--port-a=5361] [--port-b=5362]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, watchContext, watchPage, logs, waitTrue, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { startProxy } from '/home/agent/yap-perf/harness/tests/browser/proxy.mjs';
import { SERVER_ARGS, readSeed, copySeed } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';
import { instruments, warmUp } from '/home/agent/yap-perf/harness/tests/browser/perf-journeys.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

// perf.mjs PROFILES (not exported there).
const PROFILES = {
  far: { oneWayMs: 450, bytesPerSec: 125_000 },
  near: { oneWayMs: 30, bytesPerSec: 2_500_000 },
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };

const profiles = arg('profiles', 'far,near').split(',');
const n = Number(arg('n', 5));
const controlN = Number(arg('control', 2));
const outDir = path.resolve(arg('out', '/home/agent/yap-perf/results/E10-direct-websocket-retry'));
const seedDir = '/home/agent/yap-perf/seed';
const runsDir = arg('runs-dir', '/home/agent/yap-perf/runs/E10');   // the server roots of this probe only
fs.mkdirSync(outDir, { recursive: true });
process.setMaxListeners(100);   // startServer adds an exit and a SIGINT listener per start; this probe starts many

const seed = readSeed(seedDir);
const token = seed.people.find(p => p.username === seed.measured).token;
const other = seed.people.find(p => p.username !== seed.measured && seed.dms.some(d => d.partner === p.username));
const ROOM = `/room/${seed.quiet.id}`;

function side(key, spec, port) {
  const at = spec.lastIndexOf(':');
  const dir = spec.slice(0, at);
  const commit = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim();
  return { key, label: spec.slice(at + 1), dir, port, commit, starts: [],
    dll: path.join(dir, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll'), wwwroot: path.join(dir, 'Yap', 'wwwroot') };
}
const sides = [
  side('A', arg('a', '/home/agent/yap-perf/harness:main'), Number(arg('port-a', 5361))),
  side('B', arg('b', '/home/agent/yap-perf/exp/10-direct-websocket-retry:E10-ws-retry'), Number(arg('port-b', 5362))),
];

const started = Date.now();
const out = [];   // the detail log, also printed
const say = line => { console.log(line); out.push(line); };

async function boot(s) {
  s.server = await startServer({ dll: s.dll, wwwroot: s.wwwroot, port: s.port, scratch: runsDir, prepare: copySeed(seedDir), args: SERVER_ARGS });
  s.base = s.server.base;
  s.starts.push(s.server.startMs);
}

for (const s of sides) { await boot(s); s.proxy = startProxy({ port: s.port + 100, upstream: s.port }); }
const browser = await chromium.launch();

// The keeper of perf.mjs: a page on Settings, off the proxy, keeps the person online, so a measured page that
// reconnects does not bring the person's join line. After a restart it reconnects on its own.
for (const s of sides) {
  const ctx = await browser.newContext(DESKTOP);
  await ctx.addCookies([{ name: 'yap_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  await page.goto(s.base + '/settings');
  if (!await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error(`the keeper page of ${s.key} did not connect`);
  s.keeper = page;
}

// A fresh context with the seed's cookie and the harness's instruments. `events`: the hub's attempts (POST
// /hub/negotiate and every WebSocket, with their outcome); `requests`: every request of the page.
async function newPage(s, name) {
  const ctx = await browser.newContext(DESKTOP);
  await ctx.addCookies([{ name: 'yap_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await ctx.addInitScript(instruments);
  watchContext(ctx, name);
  const page = await ctx.newPage();
  watchPage(page, name);
  const cdp = await ctx.newCDPSession(page);
  const events = [], requests = [];
  page.on('request', r => {
    requests.push({ t: Date.now(), line: `${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}` });
    if (/\/hub\/negotiate/.test(r.url())) events.push({ t: Date.now(), kind: 'negotiate', req: r });
  });
  page.on('requestfailed', r => { const e = events.find(x => x.req === r); if (e) { e.failed = r.failure()?.errorText ?? 'failed'; e.end = Date.now(); } });
  page.on('response', r => { const e = events.find(x => x.req === r.request()); if (e) { e.status = r.status(); e.end = Date.now(); } });
  // The sockets through CDP, not Playwright's 'websocket' event: Playwright reports a socket at its handshake request,
  // and a direct attempt whose TCP connection the proxy drops at once (the server is down) never sends one, so the
  // shake-out saw no direct attempt on main at all. webSocketCreated fires at `new WebSocket()`.
  await cdp.send('Network.enable');
  const sockets = new Map();
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    // A negotiated socket carries the connection token (id=); the direct one (skipNegotiation) does not.
    const e = { t: Date.now(), kind: /[?&]id=/.test(url) ? 'ws negotiated' : 'ws direct' };
    sockets.set(requestId, e);
    events.push(e);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    const e = sockets.get(requestId);
    if (e) { e.status = response.status; if (response.status === 101) e.open ??= Date.now(); }
  });
  cdp.on('Network.webSocketFrameError', ({ requestId, errorMessage }) => { const e = sockets.get(requestId); if (e) { e.failed ??= errorMessage; e.end ??= Date.now(); } });
  cdp.on('Network.webSocketClosed', ({ requestId }) => { const e = sockets.get(requestId); if (e) e.end ??= Date.now(); });
  return { ctx, page, cdp, events, requests, side: s };
}

// perf.mjs prepared(), on the quiet room: loaded through the proxy without delay (the load is not measured), the
// worker in control, the room's tail and the bootstrap stored; the profile's link applies from the end of it on.
async function prepared(s, profile, name) {
  const p = await newPage(s, name);
  s.proxy.set(null);
  try {
    await p.page.goto(s.proxy.origin + ROOM, { waitUntil: 'commit' });
    await p.page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 60_000, polling: 100 });
    await p.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(() => {});
    const stored = await waitTrue(() => p.page.evaluate(async () => {
      const snapshot = await import('/js/offline/snapshot.js');
      const { state } = await import('/js/store.js');
      return !!state.open && !!await snapshot.loadTail(snapshot.keyOf(state.open)) && !!await snapshot.loadBootstrap();
    }), 15_000, 250);
    if (!stored) throw new Error('the tail and the bootstrap were not stored within 15 s');
    await p.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const where = await p.page.evaluate(() => location.pathname);
    if (where !== ROOM) throw new Error(`the page shows ${where}, not ${ROOM}`);
  } catch (e) { await p.ctx.close(); throw e; }
  finally { s.proxy.set(PROFILES[profile]); }
  return p;
}

const attemptText = (e, t0) => `${e.t - t0} ms ${e.kind}: ${e.status ?? e.failed ?? (e.open ? 'open' : e.end ? 'closed' : 'pending')}`;

// Steps 2 and 3 on one side: stop, two failed attempts, start, connected again.
async function outage(p) {
  const s = p.side, ev = p.events;
  const tStop = Date.now();
  const issues = await s.server.stop();   // the server's own child process, by its PID; stop() waits for the exit
  const tDown = Date.now();
  const failedNeg = e => e.kind === 'negotiate' && e.t >= tStop && (e.failed || (e.status && e.status !== 200));
  const both = await waitTrue(() => ev.some(e => e.kind === 'ws direct' && e.t >= tStop) && ev.some(failedNeg), 30_000, 50);
  if (!both) throw new Error(`${s.key}: no direct and failed negotiated attempt within 30 s of the stop; seen: ${ev.filter(e => e.t >= tStop).map(e => attemptText(e, tStop)).join('; ')}`);
  const tRestart = Date.now();
  await boot(s);
  const tBack = Date.now();
  if (!await waitTrue(() => p.page.evaluate(async () => (await import('/js/hub.js')).connected()), 120_000, 100)) throw new Error(`${s.key}: not connected 120 s after the server's return`);
  const tConn = Date.now();
  const during = ev.filter(e => e.t >= tStop && e.t <= tConn);
  return {
    stopMs: tDown - tStop, stopToBack: tBack - tStop, restartMs: tBack - tRestart, backToConnected: tConn - tBack,
    reconnectNegotiate: ev.filter(e => e.kind === 'negotiate' && e.t >= tRestart && e.t <= tConn && e.status === 200).length,
    transport: ev.filter(e => e.kind.startsWith('ws') && e.t >= tRestart && e.open).map(e => e.kind).at(-1) ?? '?',
    attempts: during.map(e => attemptText(e, tStop)), issues: issues.length,
  };
}

// The pause and the thaw of perf-journeys.mjs resumeAll, copied (they are not exported there).
async function freeze({ page, cdp }) {
  await page.evaluate(() => { window.__perfPoke = setInterval(() => {}, 100); });   // the pause lands at the next statement: this one, at once
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
}
async function thaw({ page, cdp }) {
  await cdp.send('Debugger.resume');
  await cdp.send('Debugger.disable');   // a page with an attached debugger may run slower
  await page.evaluate(() => clearInterval(window.__perfPoke));
}

async function postInQuiet(s, text) {
  const res = await fetch(`${s.base}/api/channels/${seed.quiet.id}/messages`, { method: 'POST',
    headers: { cookie: `yap_auth=${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: crypto.randomUUID(), text }) });
  if (!res.ok) throw new Error(`post in ${seed.quiet.name}: ${res.status}`);
  return text;
}

// Step 4 for the pages of both sides at once: they hide, freeze and lose their sockets together, share the 35 s, and
// thaw one at a time (the side that goes first alternates), each timed from its return to the new message on screen.
async function resumeAll(pages, profile, kind, rep, k) {
  for (const p of pages) {
    await p.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  await sleep(1500);
  for (const p of pages) await freeze(p);
  for (const p of pages) p.side.proxy.blackhole();
  await sleep(35_000);
  for (const p of pages) p.napText = await postInQuiet(p.side, `after the nap ${p.side.key} ${profile} ${kind}${rep}.${k} ${Date.now()}`);
  const results = [];
  for (const p of (rep + k) % 2 ? pages : [...pages].reverse()) {
    p.side.proxy.reset();
    const tThaw = Date.now();
    await thaw(p);
    const ms = await p.page.evaluate(async text => {
      window.__perf.watch('back', () => [...document.querySelectorAll('.messages .message-group .message-content')].some(c => c.textContent.includes(text)), { timeout: 90000 });
      const t0 = performance.now();
      delete document.visibilityState; delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      const t = await window.__perf.watches.back;
      return t == null ? null : t - t0;
    }, p.napText);
    const tRows = Date.now();
    const crossed = p.side.proxy.counters().lines;
    await sleep(1500);   // what crosses right after the rows too: a font for a row painted at the end would show here
    const later = p.side.proxy.counters().lines.slice(crossed.length);
    const negotiate = p.events.filter(e => e.kind === 'negotiate' && e.t >= tThaw && e.t <= tRows).length;
    const sockets = p.events.filter(e => e.kind.startsWith('ws') && e.t >= tThaw && e.t <= tRows).map(e => e.kind);
    const asked = p.requests.filter(r => r.t >= tThaw && r.t <= tRows).map(r => r.line);
    results.push({ p, ms, negotiate, sockets });
    const short = l => l.replace(/device=[0-9a-f-]+/, 'device=…').replace(/id=[^& ]+/, 'id=…').slice(0, 110);
    say(`  ${profile} ${kind} ${p.side.key}#${rep} resume ${k}: rows ${ms == null ? 'none' : Math.round(ms)} ms, negotiate ${negotiate}, sockets [${sockets.join(', ')}]`);
    say(`    crossed until the rows (${crossed.length}): ${crossed.map(short).join(' | ')}`);
    if (later.length) say(`    crossed in the 1.5 s after (${later.length}): ${later.map(short).join(' | ')}`);
    say(`    the page asked: ${asked.map(short).join(' | ')}`);
  }
  return results;
}

const records = [];   // { profile, kind, side, label, rep, resume, metric, value, negotiate }
const details = [];   // the outage facts per run
const errors = [];
const rec = (profile, kind, p, rep, resume, metric, value, negotiate) => records.push({ profile, kind, side: p.side.key, label: p.side.label, rep, resume, metric, value: value == null ? null : Math.round(value * 10) / 10, negotiate });

for (const s of sides) await warmUp({ origin: s.base, seed, newPage: () => newPage(s, `${s.key}/warm-up`) }).catch(e => say(`warm-up of ${s.key} failed: ${e.message.split('\n')[0]}`));

async function oneRun(profile, kind, rep) {
  const pages = [];
  try {
    pages.push(...await Promise.all(sides.map(s => prepared(s, profile, `${s.key}/${profile}/${kind}${rep}`))));
    if (kind === 'outage') {
      // allSettled: a side that fails must not leave the other side's stop and start running behind the catch below,
      // which starts any server that does not answer.
      const settled = await Promise.allSettled(pages.map(outage));
      const failure = settled.find(x => x.status === 'rejected');
      if (failure) throw failure.reason;
      const facts = settled.map(x => x.value);
      pages.forEach((p, i) => {
        const f = facts[i];
        details.push({ profile, side: p.side.key, rep, ...f });
        rec(profile, kind, p, rep, null, 'server back to connected ms', f.backToConnected, f.reconnectNegotiate);
        say(`  ${profile} outage ${p.side.key}#${rep}: stop ${f.stopMs} ms, down to back ${f.stopToBack} ms (start ${f.restartMs} ms), back to connected ${f.backToConnected} ms, reconnect by ${f.transport}, negotiate ${f.reconnectNegotiate}`);
        say(`    attempts from the stop: ${f.attempts.join('; ')}`);
      });
    }
    for (const k of [1, 2]) {
      // A settled page before each hide: the reconnect or the last thaw may still have the bootstrap on the link, and
      // the blackhole would cut it (the harness's resume starts from a page that reached network idle).
      await sleep(3000);
      for (const r of await resumeAll(pages, profile, kind, rep, k)) {
        rec(profile, kind, r.p, rep, k, kind === 'outage' ? 'resume after outage: rows ms' : 'control resume: rows ms', r.ms, r.negotiate);
      }
    }
  } catch (e) {
    const text = `${profile} ${kind}#${rep}: ${String(e?.message ?? e).split('\n')[0]}`;
    errors.push(text);
    say(`  !! ${text}`);
    for (const p of pages) await p.page.screenshot({ path: path.join(outDir, `fail-${profile}-${kind}${rep}-${p.side.key}.png`) }).catch(() => {});
    // A server that a failed outage left down comes back, so the next run has one.
    for (const s of sides) { if (!await fetch(`${s.base}/login`).then(r => r.ok, () => false)) await boot(s).catch(err => say(`  !! restart of ${s.key}: ${err.message}`)); }
  } finally {
    for (const p of pages) await p.ctx.close().catch(() => {});
  }
}

for (const profile of profiles) {
  for (const s of sides) s.proxy.set(PROFILES[profile]);
  say(`\n== ${profile}`);
  for (let rep = 1; rep <= controlN; rep++) await oneRun(profile, 'control', rep);
  for (let rep = 1; rep <= n; rep++) await oneRun(profile, 'outage', rep);
}
const wall = Date.now() - started;

// ---- the report ----

function median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const fmt = x => x == null || !Number.isFinite(x) ? '—' : String(Math.round(x));
const minutes = ms => `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;

const rows = [
  ['resume after outage: rows ms (both resumes)', r => r.metric === 'resume after outage: rows ms'],
  ['resume after outage: rows ms, resume 1', r => r.metric === 'resume after outage: rows ms' && r.resume === 1],
  ['resume after outage: rows ms, resume 2', r => r.metric === 'resume after outage: rows ms' && r.resume === 2],
  ['control resume: rows ms (both resumes)', r => r.metric === 'control resume: rows ms'],
  ['server back to connected ms (secondary)', r => r.metric === 'server back to connected ms'],
];
const table = [];
for (const profile of profiles) {
  table.push(`## ${profile}`, '', '| metric | A median | B median | A min–max | B min–max | n A/B | Δ ms | Δ % | negotiate A | negotiate B |', '| --- | --: | --: | --: | --: | --: | --: | --: | --- | --- |');
  for (const [name, test] of rows) {
    const of = key => records.filter(r => r.profile === profile && r.side === key && test(r));
    const a = of('A'), b = of('B');
    const va = a.map(r => r.value).filter(v => v != null), vb = b.map(r => r.value).filter(v => v != null);
    const ma = median(va), mb = median(vb);
    const d = ma != null && mb != null ? mb - ma : null;
    const counts = list => list.map(r => r.negotiate).join(' ');
    table.push(`| ${name} | ${fmt(ma)} | ${fmt(mb)} | ${fmt(Math.min(...va))}–${fmt(Math.max(...va))} | ${fmt(Math.min(...vb))}–${fmt(Math.max(...vb))} | ${va.length}/${vb.length} | ${d == null ? '—' : (d >= 0 ? '+' : '') + fmt(d)} | ${d == null ? '—' : (d >= 0 ? '+' : '') + (d / ma * 100).toFixed(1) + '%'} | ${counts(a)} | ${counts(b)} |`);
  }
  table.push('');
}
const header = [
  `# E10 probe: resume after a server outage, A = ${sides[0].label}, B = ${sides[1].label}`, '',
  `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Wall time ${minutes(wall)}. ${n} outage runs and ${controlN} control runs per profile, two resumes per run.`, '',
  ...sides.map(s => `- ${s.key} (${s.label}): ${s.dir}, ${s.commit}; server starts ${s.starts.join(', ')} ms.`),
  `- The page: ${seed.measured}, ${ROOM} (${seed.quiet.name}, ${seed.rooms.find(r => r.name === seed.quiet.name)?.messages} messages); the poster: ${other.username}.`,
  '- negotiate: POST /hub/negotiate requests per sample, in run order (for the reconnect: the ones that got a 200).', '',
];
const report = [...header, ...table, errors.length ? `## Runs that failed\n\n${errors.map(e => `- ${e}`).join('\n')}\n` : 'All runs ended.\n'].join('\n');
console.log('\n' + report);
fs.writeFileSync(path.join(outDir, 'probe-report.md'), report);
fs.writeFileSync(path.join(outDir, 'probe-log.txt'), out.join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify({ sides: sides.map(({ key, label, dir, commit, port, starts }) => ({ key, label, dir, commit, port, starts })), n, controlN, profiles, wallMs: wall, records, details }, null, 1));
const seen = new Map();
for (const l of logs) { const k = `${l.page} ${l.kind}: ${l.text}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
fs.writeFileSync(path.join(outDir, 'browser-log.txt'), [...seen].map(([k, c]) => `${c}x ${k}`).join('\n') + '\n');

await browser.close();
for (const s of sides) {
  s.proxy.close();
  const issues = await s.server.stop();
  if (issues.length) console.log(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
}
console.log(`wall time ${minutes(wall)}`);
process.exit(errors.length ? 1 : 0);
