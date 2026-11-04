// How responsive Yap feels for one person on a real-sized server, build A against build B. The instrument for the
// performance experiments: each one is a worktree with a change, measured against the worktree without it.
//
// The server: a copy of a seed (perf-seed.mjs: 30 people, 10 rooms, 50,000 messages over 180 days) with the database
// on, one copy per build, on two ports. The person: the seed's admin, signed in through the API, so a journey times
// the page and not the login form. The journeys (perf-journeys.mjs): a cold open, a warm open, a resume after a frozen
// background, sends, room changes, older pages, the two pickers; a cold open and older pages again on a slow phone.
//
// The networks are a TCP proxy in this process (proxy.mjs), not a CDP throttle: a CDP throttle shapes the page's
// requests only, never the service worker's fetches or the WebSocket frames, and the shell caching is the worker's
// work. `far` is the target user of docs/performance-notes.md (900 ms round trip, 1 Mbit/s); `near` a good mobile or
// home link; `lan` has no proxy, so it shows the server's and the page's own cost.
//
// The runs alternate A, B, B, A, A, B ... for every journey and profile, so drift of the machine hits both sides
// alike. The report gives the median, min and max of every metric per side, and the delta of the medians.
//
// Run from tests/browser (Node and Playwright only; build each worktree first with dotnet build):
//   node perf.mjs --seed                        build the seed once (about 1.5 minutes), into --seed-dir
//   node perf.mjs --a=<worktree>:<label> --b=<worktree>:<label>
// Options: --profiles=far,near,lan  --journeys=cold-open,...  --full (every journey)  --n=5
//   --out=<dir> (report.md, runs.json, browser-log.txt, a screenshot per failed run)  --seed-dir=<dir>
//   --runs-dir=<dir> (the servers' content roots)  --port-a=5301  --port-b=5302 (each proxy listens 100 above)
// DEFAULT_PLAN below says which journeys run on which profile by default, and why.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { REPO, startServer, watchContext, watchPage, logs, waitTrue } from './lib.mjs';
import { startProxy } from './proxy.mjs';
import { SERVER_ARGS, buildSeed, readSeed, copySeed, signInToken } from './perf-seed.mjs';
import { JOURNEYS, instruments, warmUp } from './perf-journeys.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = name => process.argv.includes(`--${name}`);

const PROFILES = {
  far: { oneWayMs: 450, bytesPerSec: 125_000 },     // 900 ms round trip, 1 Mbit/s each way (load.mjs, production 2026-08-11)
  near: { oneWayMs: 30, bytesPerSec: 2_500_000 },   // 60 ms round trip, 20 Mbit/s
  lan: null,                                        // no proxy
};
const DESCRIBE = { far: '900 ms round trip, 1 Mbit/s', near: '60 ms round trip, 20 Mbit/s', lan: 'no proxy: the server and the page' };
const ALL_JOURNEYS = Object.keys(JOURNEYS);
// The default plan keeps one A/B experiment at n=5 near 20 minutes (19.5 measured); --full runs every journey (28.5
// minutes A/B at n=5). Timed on 2026-11-04, one side at n=3, then A/A. What stays out, and why it costs little:
// - the phone rows on `far` (31 s a run): the link hides the slow CPU there (cold open 18.3 s desktop, 18.3 s phone);
//   `near` keeps them, a phone on a good link.
// - send on `far` (12 s a run): its confirmation is the link's round trip plus the server (922 ms against 7 ms on
//   `lan`); `near` and `lan` show the client's and the server's part.
// - the resume on `near` and `lan` (a fixed 37 s wait each): a resume is round trips, which `far` shows best.
// - the phone rows on `lan`: `near` has them with a link.
const DEFAULT_PLAN = {
  far: ['cold-open', 'warm-open', 'resume', 'switch-room', 'older', 'picker-emoji', 'picker-gif'],
  near: ['cold-open', 'warm-open', 'send', 'switch-room', 'older', 'picker-emoji', 'picker-gif', 'phone-cold-open', 'phone-older'],
  lan: ['cold-open', 'warm-open', 'send', 'switch-room', 'older', 'picker-emoji', 'picker-gif'],
};

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const RUN_TIMEOUT = 240_000;   // one run of one journey; far cold opens take about 20 s

const HOME = path.join(os.homedir(), 'yap-perf');   // the seed, the servers' roots and the results live outside the worktrees
const seedDir = path.resolve(arg('seed-dir', path.join(HOME, 'seed')));
const runsDir = path.resolve(arg('runs-dir', path.join(HOME, 'runs')));
const n = Number(arg('n', 5));
// profile -> its journeys: --full every one on every chosen profile; --journeys the same list on every chosen profile;
// otherwise the default plan, cut to --profiles when given.
const profiles = arg('profiles')?.split(',') ?? (flag('full') ? Object.keys(PROFILES) : Object.keys(DEFAULT_PLAN));
const plan = Object.fromEntries(profiles.map(p => [p, flag('full') ? ALL_JOURNEYS : arg('journeys')?.split(',') ?? DEFAULT_PLAN[p] ?? ALL_JOURNEYS]));
for (const p of profiles) if (!(p in PROFILES)) throw new Error(`unknown profile ${p}; known: ${Object.keys(PROFILES).join(', ')}`);
for (const j of Object.values(plan).flat()) if (!JOURNEYS[j]) throw new Error(`unknown journey ${j}; known: ${ALL_JOURNEYS.join(', ')}`);

// A side is one build: a worktree with Yap/bin/Debug/net10.0/Yap.dll and its own Yap/wwwroot.
function side(key, spec, port) {
  const at = spec.lastIndexOf(':');
  const dir = path.resolve(at > 0 ? spec.slice(0, at) : spec);
  let commit = '';
  try { commit = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim(); } catch { /* not a git folder */ }
  return { key, label: at > 0 ? spec.slice(at + 1) : key, dir, port, commit,
    dll: path.join(dir, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll'), wwwroot: path.join(dir, 'Yap', 'wwwroot') };
}
const sides = [side('A', arg('a', REPO), Number(arg('port-a', 5301)))];
if (arg('b')) sides.push(side('B', arg('b'), Number(arg('port-b', 5302))));

const started = Date.now();

if (flag('seed')) {
  await buildSeed({ dll: sides[0].dll, wwwroot: sides[0].wwwroot, seedDir, runsDir, port: sides[0].port });
  console.log(`wall time ${minutes(Date.now() - started)}`);
  process.exit(0);
}

const seed = readSeed(seedDir);
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const outDir = path.resolve(arg('out', path.join(path.dirname(seedDir), 'results', stamp)));
fs.mkdirSync(outDir, { recursive: true });

// ---- the servers and the browser ----

const other = seed.people.find(p => p.username !== seed.measured && seed.dms.some(d => d.partner === p.username)) ?? seed.people[1];
for (const s of sides) {
  s.server = await startServer({ dll: s.dll, wwwroot: s.wwwroot, port: s.port, scratch: runsDir, prepare: copySeed(seedDir), args: SERVER_ARGS });
  s.base = s.server.base;
  s.proxy = startProxy({ port: s.port + 100, upstream: s.port });
  // The sign-in route, as the login page uses it; smart login knows this address from the seed. The seed's token
  // stands in when that memory expired (14 days): the account and its token are the same.
  s.token = await signInToken(s.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
}
const browser = await chromium.launch();

// The person stays online on each server through a page that idles on Settings, off the proxies. Without it the
// person's presence depended on the order of the runs: a page that connects after the server saw the person go
// offline gets the person's own join line in the lobby, in italics, and the italic font (380 KB) loads before the
// rows. On 2026-11-04 every first run after the other side's run carried 1,386 KB on the wire instead of 1,006.
for (const s of sides) {
  const ctx = await browser.newContext(DESKTOP);
  await ctx.addCookies([{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  await page.goto(s.base + '/settings');
  if (!await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error(`the keeper page of ${s.key} did not connect`);
}

// A site is one side on one profile: where the page goes, the proxy that shapes it, and its warm pages.
function site(s, profile) {
  const link = PROFILES[profile];
  return {
    side: s, profile, seed, link,
    proxy: link ? s.proxy : null,
    origin: link ? s.proxy.origin : s.base,
    pages: {},
    async newPage(kind = 'desktop') {
      const ctx = await browser.newContext(kind === 'phone' ? PHONE : DESKTOP);
      // A cookie belongs to the host, not the port: the same one serves the server and its proxy.
      await ctx.addCookies([{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
      await ctx.addInitScript(instruments);
      const name = `${s.key}/${profile}/${kind}`;
      watchContext(ctx, name);
      const page = await ctx.newPage();
      watchPage(page, name);
      const cdp = await ctx.newCDPSession(page);
      if (kind === 'phone') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      return { ctx, page, cdp };
    },
    // A new device that has loaded the app once at full speed (that load is not measured): the worker installed and
    // in control, the conversation's tail and the bootstrap in IndexedDB. The client stores them 800 ms and 2 s
    // after the last change (offline/snapshot.js); a reload before that paints nothing from the device.
    async prepared(kind = 'desktop', origin = this.origin) {
      const p = await this.newPage(kind);
      s.proxy.set(null);
      try {
        await p.page.goto(origin + '/', { waitUntil: 'commit' });
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
      } catch (e) { await p.ctx.close(); throw e; }
      finally { s.proxy.set(this.link); }
      return p;
    },
    // The prepared page that send, room changes, older pages and warm opens share.
    async warmPage(kind = 'desktop') { return (this.pages[kind] ??= await this.prepared(kind)); },
    // Someone else's message in the lobby, through the send route (the resume waits for it).
    async postInLobby(text) {
      const res = await fetch(`${s.base}/api/channels/${seed.lobby.id}/messages`, { method: 'POST',
        headers: { cookie: `yap_auth=${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: crypto.randomUUID(), text }) });
      if (!res.ok) throw new Error(`post in the lobby: ${res.status}`);
      return text;
    },
    // `shots`: a file name prefix; the pages are photographed first (the state a failed run left behind).
    async close(shots) {
      for (const [kind, p] of Object.entries(this.pages)) {
        if (shots) await p.page.screenshot({ path: path.join(outDir, `${shots}-${kind}.png`) }).catch(() => {});
        await p.ctx.close().catch(() => {});
      }
      this.pages = {};
    },
  };
}

// ---- the runs ----

const records = [];   // { profile, journey, side, label, rep, metric, value }
const errors = [];

function record(profile, journey, s, rep, samples) {
  for (const [metric, value] of samples) {
    if (value == null || !Number.isFinite(value)) continue;
    records.push({ profile, journey, side: s.key, label: s.label, rep, metric, value: Math.round(value * 10) / 10 });
  }
  const summary = [...new Set(samples.map(([m]) => m))].slice(0, 4)
    .map(m => `${m} ${fmt(median(samples.filter(([x, v]) => x === m && v != null).map(([, v]) => v)))}`).join(', ');
  console.log(`  ${profile} ${journey} ${s.key}#${rep}: ${summary}`);
}

function failed(profile, journey, s, rep, e) {
  const text = `${profile} ${journey} ${s.key}#${rep}: ${String(e?.message ?? e).split('\n')[0]}`;
  errors.push(text);
  console.log(`  !! ${text}`);
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no end after ${ms / 1000} s`)), ms))]);

for (const s of sides) await warmUp(site(s, 'lan')).catch(e => console.log(`warm-up of ${s.key} failed: ${e.message.split('\n')[0]}`));

for (const profile of profiles) {
  const sites = sides.map(s => site(s, profile));
  for (const s of sides) s.proxy.set(PROFILES[profile]);
  console.log(`\n== ${profile} (${DESCRIBE[profile]})`);
  for (const journey of plan[profile]) {
    const j = JOURNEYS[journey];
    const t0 = Date.now();
    if (j.all) {
      try {
        for (const r of await j.all(sites, n)) {
          if (r.error) failed(profile, journey, r.site.side, r.rep, r.error); else record(profile, journey, r.site.side, r.rep, r.samples);
        }
      } catch (e) { failed(profile, journey, sides[0], 0, e); }
    } else {
      for (let rep = 1; rep <= n; rep++) {
        for (const st of rep % 2 ? sites : [...sites].reverse()) {
          try { record(profile, journey, st.side, rep, await withTimeout(j.run(st, rep), RUN_TIMEOUT)); }
          catch (e) { failed(profile, journey, st.side, rep, e); await st.close(`fail-${profile}-${journey}-${st.side.key}${rep}`); }   // a page in an unknown state is not reused
        }
      }
    }
    console.log(`  (${journey}: ${minutes(Date.now() - t0)})`);
  }
  for (const st of sites) await st.close();
}

const wall = Date.now() - started;

// ---- the report ----

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b), mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function fmt(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return Math.abs(x) >= 100 || Number.isInteger(x) ? String(Math.round(x)) : x.toFixed(1);
}
function minutes(ms) { return `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`; }

function profileTables(profile) {
  const rows = [];
  for (const r of records.filter(r => r.profile === profile)) {
    if (!rows.some(x => x.journey === r.journey && x.metric === r.metric)) rows.push({ journey: r.journey, metric: r.metric });
  }
  const stats = (row, key) => {
    const v = records.filter(r => r.profile === profile && r.journey === row.journey && r.metric === row.metric && r.side === key).map(r => r.value);
    return { median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, count: v.length };
  };
  const [A, B] = sides;
  const lines = [`## ${profile} (${DESCRIBE[profile]})`, '', `Journeys: ${plan[profile].join(', ')}.`, ''];
  if (!B) {
    lines.push('| journey | metric | median | min | max | n |', '| --- | --- | --: | --: | --: | --: |');
    for (const row of rows) { const a = stats(row, 'A'); lines.push(`| ${row.journey} | ${row.metric} | ${fmt(a.median)} | ${fmt(a.min)} | ${fmt(a.max)} | ${a.count} |`); }
    return lines.join('\n');
  }
  lines.push(`| journey | metric | A: ${A.label} | B: ${B.label} | Δ | Δ % |`, '| --- | --- | --: | --: | --: | --: |');
  for (const row of rows) {
    const a = stats(row, 'A'), b = stats(row, 'B');
    const delta = a.median != null && b.median != null ? b.median - a.median : null;
    const pct = delta != null && a.median ? `${delta >= 0 ? '+' : ''}${(delta / a.median * 100).toFixed(1)}%` : '—';
    lines.push(`| ${row.journey} | ${row.metric} | ${fmt(a.median)} | ${fmt(b.median)} | ${delta != null && delta >= 0 ? '+' : ''}${fmt(delta)} | ${pct} |`);
  }
  lines.push('', `Spread (${profile}): min and max of every sample, n samples per side.`, '',
    `| journey | metric | A min | A max | B min | B max | n |`, '| --- | --- | --: | --: | --: | --: | --: |');
  for (const row of rows) {
    const a = stats(row, 'A'), b = stats(row, 'B');
    lines.push(`| ${row.journey} | ${row.metric} | ${fmt(a.min)} | ${fmt(a.max)} | ${fmt(b.min)} | ${fmt(b.max)} | ${a.count}/${b.count} |`);
  }
  return lines.join('\n');
}

const header = [
  `# Yap responsiveness: ${sides.map(s => `${s.key} = ${s.label}`).join(', ')}`, '',
  `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Wall time ${minutes(wall)}. ${n} repetitions${flag('full') ? ', every journey (--full)' : ''}.`, '',
  ...sides.map(s => `- ${s.key} (${s.label}): ${s.dir}, ${s.commit || 'no git'}; the server answered ${s.server.startMs} ms after its start (the seed loads into memory first).`),
  `- Seed: ${seed.messages} messages, ${seed.reactions} reactions, ${seed.images} pictures, ${seed.gifs} GIFs (${seedDir}, built ${seed.createdAt}). The person: ${seed.measured}.`,
  '- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page\'s clock.',
  '',
];
const report = [...header, ...profiles.map(profileTables).flatMap(t => [t, '']),
  errors.length ? `## Runs that failed\n\n${errors.map(e => `- ${e}`).join('\n')}\n` : 'All runs ended.\n'].join('\n');
console.log('\n' + report);
fs.writeFileSync(path.join(outDir, 'report.md'), report);
fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify({ sides: sides.map(({ key, label, dir, commit }) => ({ key, label, dir, commit })), n, plan, wallMs: wall, records }, null, 1));

// The browser's complaints, deduplicated: a page error during a run says more than any number.
const seen = new Map();
for (const l of logs) { const k = `${l.page} ${l.kind}: ${l.text}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
fs.writeFileSync(path.join(outDir, 'browser-log.txt'), [...seen].map(([k, c]) => `${c}x ${k}`).join('\n') + '\n');
const pageErrors = [...seen].filter(([k]) => / pageerror: /.test(k));
console.log(`browser log: ${seen.size} distinct lines (${pageErrors.length} page errors) in ${path.join(outDir, 'browser-log.txt')}`);
for (const [k, c] of pageErrors.slice(0, 10)) console.log(`  ${c}x ${k}`);

await browser.close();
for (const s of sides) {
  s.proxy.close();
  const issues = await s.server.stop();
  if (issues.length) console.log(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
}
console.log(`report: ${path.join(outDir, 'report.md')}\nwall time ${minutes(wall)}`);
process.exit(errors.length ? 1 : 0);
