// E08 phone probe: the send journey of perf.mjs on a slow phone (390x800, 3 device pixels per CSS pixel, touch, the CPU
// four times slower through CDP), no proxy (`lan`), A (main) against B (perf/08-send-confirm-path).
//
// Why a probe and not the harness: the harness's `send` runs on a desktop only, and its file is being edited by
// another agent. This script imports the harness's building blocks (startServer, instruments, warmUp, the seed
// helpers) by absolute path and copies the observation of `send` (the own row, the confirmation).
//
// Per side: 3 pages, 10 sends each, the sides alternating per page (A B B A A B). Per send:
// - the tap on Send to the own row and the tap to the confirmation, as `send` measures them from Enter (MutationObserver
//   watches). A phone sends with the button only: on a touch device Enter is a new line (IB-11, composer.js);
// - the long tasks and the main thread's busy time (CDP Performance.getMetrics) from the tap to 300 ms after both
//   copies of the message arrived (the POST answer and the hub's 'message' event);
// - the proof of mechanism: the pending row's node and the confirmed row's node are kept; after both copies arrived
//   the probe asks whether each is still in the document. The pending node leaves on both sides (the timeline draws
//   the confirmed row as a new node, onPending removes the pending ones). The confirmed node is the one the change is
//   about: on A the second copy replaces it (replaceMessage -> redraw), on B it stays. The store's 'messages' events
//   of type 'replace' for the message's id are counted too.
// The gap between sends is 1.5 s, so the conversation snapshot (stored 800 ms after the last change) runs between
// the measured windows, not inside them.
//
// Run: node phone-probe.mjs [--out=<dir>] [--pages=3] [--sends=10]. Servers on 5313 (A) and 5314 (B); stopped by PID.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, watchContext, watchPage, logs, waitTrue, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';
import { instruments, warmUp } from '/home/agent/yap-perf/harness/tests/browser/perf-journeys.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '/home/agent/yap-perf/results/E08-send-confirm-path/phone-probe'));
const PAGES = Number(arg('pages', 3));
const SENDS = Number(arg('sends', 10));
const seedDir = '/home/agent/yap-perf/seed';
const runsDir = '/home/agent/yap-perf/runs';
fs.mkdirSync(outDir, { recursive: true });

const PHONE = { viewport: { width: 390, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };   // perf.mjs
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const sides = [
  { key: 'A', label: 'main', dir: '/home/agent/yap-perf/harness', port: 5313 },
  { key: 'B', label: 'E08-send-confirm', dir: '/home/agent/yap-perf/exp/08-send-confirm-path', port: 5314 },
];
for (const s of sides) { s.dll = path.join(s.dir, 'Yap/bin/Debug/net10.0/Yap.dll'); s.wwwroot = path.join(s.dir, 'Yap/wwwroot'); }

// The server's PID, found by its own --urls argument: the probe kills only what it started, never by name.
function serverPid(port) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (cmd.includes(`http://127.0.0.1:${port}`) && cmd.some(c => c.endsWith('Yap.dll'))) return Number(d);
    } catch { /* the process ended meanwhile */ }
  }
  return null;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const seed = readSeed(seedDir);
const cookie = s => [{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];
let browser;
const samples = [];   // one per send

async function newPage(s, kind, name) {
  const ctx = await browser.newContext(kind === 'phone' ? PHONE : DESKTOP);
  await ctx.addCookies(cookie(s));
  await ctx.addInitScript(instruments);
  watchContext(ctx, name);
  const page = await ctx.newPage();
  watchPage(page, name);
  const cdp = await ctx.newCDPSession(page);
  if (kind === 'phone') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return { ctx, page, cdp };
}

async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

// perf-journeys.mjs deleteOwn, copied (not exported): the lobby's newest rows stay the seed's.
async function deleteOwn(page, prefix) {
  await page.evaluate(async prefix => {
    const { state } = await import('/js/store.js');
    const hub = await import('/js/hub.js');
    const own = (state.open?.messages ?? []).filter(m => m.text?.startsWith(prefix));
    await Promise.all(own.map(m => hub.invoke('delete', m.id)));
  }, prefix);
}

async function phonePage(s, pageNo) {
  const name = `${s.key}/lan/phone`;
  const { ctx, page, cdp } = await newPage(s, 'phone', name);
  try {
    await cdp.send('Performance.enable');
    await page.goto(s.base + '/', { waitUntil: 'commit' });
    await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 100 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const inLobby = await waitTrue(() => page.evaluate(() => location.pathname === '/lobby' && !!document.querySelector('.messages .message-group') && !document.querySelector('.catching-up')), 30_000, 200);
    if (!inLobby) throw new Error(`${name}: not in the lobby with the server's rows`);
    await sleep(2500);   // the snapshot store (800 ms, 2 s after the last change) runs before the first send
    await page.evaluate(async () => {
      const store = await import('/js/store.js');
      const probe = window.__probe = { events: [] };
      store.on('incoming', m => probe.events.push({ t: performance.now(), kind: 'incoming', id: m.id, text: m.text ?? '' }));
      store.on('messages', d => probe.events.push({ t: performance.now(), kind: d?.type ?? 'none', id: d?.message?.id ?? d?.id ?? null }));
    });
    const prefix = `perf ${s.key}${pageNo}.`;
    for (let i = 1; i <= SENDS; i++) {
      const text = `${prefix}${i} ${Math.random().toString(36).slice(2, 8)}`;
      await page.fill('.message-input', text);
      // The observation of perf-journeys.mjs `send`, with the node kept at the moment each watch passes.
      await page.evaluate(text => {
        const probe = window.__probe;
        probe.from = probe.events.length; probe.pendingNode = null; probe.pendingClass = null; probe.confirmedNode = null;
        const find = selector => [...document.querySelectorAll(selector)].find(g => g.querySelector('.message-content')?.textContent.includes(text));
        window.__perf.watch('row', () => { const g = find('.messages .message-group'); if (g && !probe.pendingNode) { probe.pendingNode = g; probe.pendingClass = g.className; } return !!g; });
        window.__perf.watch('confirmed', () => { const g = find('.messages .message-group:not(.pending):not(.failed)'); if (g && !probe.confirmedNode) probe.confirmedNode = g; return !!g; });
      }, text);
      const before = await metrics(cdp);
      await page.tap('.send-button');   // the click's own time stamp is t0, as the harness takes the key's
      const r = await page.evaluate(async text => {
        const perf = window.__perf, probe = window.__probe;
        const [row, confirmed] = await Promise.all([perf.watches.row, perf.watches.confirmed]);
        const t0 = perf.input.click;
        const mine = () => probe.events.slice(probe.from);
        const incoming = () => mine().find(e => e.kind === 'incoming' && e.text.includes(text));
        const post = () => performance.getEntriesByType('resource').find(e => e.startTime >= t0 && /\/api\/channels\/[^/]+\/messages$/.test(new URL(e.name).pathname));
        const deadline = performance.now() + 10_000;
        while (!(incoming() && post()) && performance.now() < deadline) await new Promise(r => setTimeout(r, 20));
        await new Promise(r => setTimeout(r, 300));   // the work behind the copies: A's outbox commit before the add, the replace
        const end = performance.now();
        const hub = incoming(), answer = post();
        const id = hub?.id ?? null;
        const events = mine();
        const add = events.find(e => e.kind === 'add' && e.id === id);
        const replaces = events.filter(e => e.kind === 'replace' && e.id === id);
        const current = [...document.querySelectorAll('.messages .message-group:not(.pending)')].find(g => g.querySelector('.message-content')?.textContent.includes(text));
        const long = perf.longTasks.filter(([s]) => s >= t0 && s <= end);
        return {
          row: row == null ? null : row - t0, confirmed: confirmed == null ? null : confirmed - t0,
          hubAt: hub ? hub.t - t0 : null, postAt: answer ? answer.responseEnd - t0 : null, addAt: add ? add.t - t0 : null,
          replaceAt: replaces[0] ? replaces[0].t - t0 : null, replaces: replaces.length,
          hubFirst: !!(hub && add && hub.t <= add.t),
          pendingWasPending: /\bpending\b/.test(probe.pendingClass ?? ''),
          pendingConnected: probe.pendingNode?.isConnected ?? null, confirmedConnected: probe.confirmedNode?.isConnected ?? null,
          confirmedIsCurrent: !!current && current === probe.confirmedNode,
          longTasks: long.length, longMs: long.reduce((s, [, d]) => s + d, 0), windowMs: end - t0,
        };
      }, text);
      const after = await metrics(cdp);
      const d = k => (after[k] - before[k]) * 1000;
      samples.push({ side: s.key, page: pageNo, send: i, ...r, taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutStyleMs: d('LayoutDuration') + d('RecalcStyleDuration') });
      const last = samples.at(-1);
      console.log(`  ${s.key} page ${pageNo} send ${i}: row ${last.row?.toFixed(1)} confirmed ${last.confirmed?.toFixed(1)} task ${last.taskMs.toFixed(1)} long ${last.longTasks}/${last.longMs.toFixed(0)} replaces ${last.replaces} confirmedConnected ${last.confirmedConnected} hubFirst ${last.hubFirst}`);
      await sleep(1500);
    }
    await deleteOwn(page, prefix);
    await sleep(500);
  } finally { await ctx.close().catch(() => {}); }
}

const median = v => { if (!v.length) return null; const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const f = x => x == null ? '—' : Math.abs(x) >= 100 || Number.isInteger(x) ? String(Math.round(x)) : x.toFixed(1);

function report() {
  const lines = [`# E08 phone probe: send on a phone (390x800, dpr 3, touch, CPU x4), no proxy`, '',
    `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ${PAGES} pages x ${SENDS} sends per side, sides alternating per page. Times in ms from the tap on Send (the click's time stamp), in the page's clock.`, '',
    ...sides.map(s => `- ${s.key} (${s.label}): ${s.dir}, port ${s.port}, PID ${s.pid}`), '',
    '| metric | A median | A min | A max | B median | B min | B max | Δ median | Δ % |', '| --- | --: | --: | --: | --: | --: | --: | --: | --: |'];
  const metricsShown = [['own row ms', 'row'], ['confirmed ms', 'confirmed'], ['hub copy at ms', 'hubAt'], ['POST answer at ms', 'postAt'],
    ['store add at ms', 'addAt'], ['main thread busy ms (CDP TaskDuration)', 'taskMs'], ['script ms (CDP)', 'scriptMs'], ['layout+style ms (CDP)', 'layoutStyleMs'],
    ['long tasks per send', 'longTasks'], ['long task ms per send', 'longMs']];
  for (const [label, key] of metricsShown) {
    const v = side => samples.filter(x => x.side === side && x[key] != null).map(x => x[key]);
    const a = v('A'), b = v('B'), ma = median(a), mb = median(b);
    const dl = ma != null && mb != null ? mb - ma : null;
    lines.push(`| ${label} | ${f(ma)} | ${f(Math.min(...a))} | ${f(Math.max(...a))} | ${f(mb)} | ${f(Math.min(...b))} | ${f(Math.max(...b))} | ${dl != null && dl >= 0 ? '+' : ''}${f(dl)} | ${ma ? `${dl >= 0 ? '+' : ''}${(dl / ma * 100).toFixed(1)}%` : '—'} |`);
  }
  lines.push('', '| proof (count over the sends) | A | B |', '| --- | --: | --: |');
  const count = (side, test) => `${samples.filter(x => x.side === side && test(x)).length} of ${samples.filter(x => x.side === side).length}`;
  lines.push(`| confirmed row's node detached after both copies (replaced) | ${count('A', x => x.confirmedConnected === false)} | ${count('B', x => x.confirmedConnected === false)} |`);
  lines.push(`| pending row's node detached after the confirmation | ${count('A', x => x.pendingConnected === false)} | ${count('B', x => x.pendingConnected === false)} |`);
  lines.push(`| first watched node was the pending row | ${count('A', x => x.pendingWasPending)} | ${count('B', x => x.pendingWasPending)} |`);
  lines.push(`| store 'replace' events for the own message (sends with at least one) | ${count('A', x => x.replaces > 0)} | ${count('B', x => x.replaces > 0)} |`);
  lines.push(`| hub copy came before the POST answer's add | ${count('A', x => x.hubFirst)} | ${count('B', x => x.hubFirst)} |`);
  return lines.join('\n');
}

const servers = [];
try {
  for (const s of sides) {
    s.server = await startServer({ dll: s.dll, wwwroot: s.wwwroot, port: s.port, scratch: runsDir, prepare: copySeed(seedDir), args: SERVER_ARGS });
    servers.push(s);
    s.base = s.server.base;
    s.pid = serverPid(s.port);
    console.log(`${s.key}: PID ${s.pid}`);
    s.token = await signInToken(s.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
  }
  browser = await chromium.launch();
  // perf.mjs: the person stays online through a page that idles on Settings, so no page gets the person's join line.
  for (const s of sides) {
    const { page } = await newPage(s, 'desktop', `${s.key}/keeper`);
    await page.goto(s.base + '/settings');
    if (!await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200)) throw new Error(`the keeper page of ${s.key} did not connect`);
  }
  // The harness's untimed walk per server: the first call of each path pays the server's JIT, for neither side.
  for (const s of sides) {
    await warmUp({ origin: s.base, seed, newPage: kind => newPage(s, kind, `${s.key}/warm-up`) })
      .catch(e => console.log(`warm-up of ${s.key} failed: ${e.message.split('\n')[0]}`));
  }
  for (let p = 1; p <= PAGES; p++) {
    for (const s of p % 2 ? sides : [...sides].reverse()) await phonePage(s, p);
  }
  const text = report();
  console.log('\n' + text);
  fs.writeFileSync(path.join(outDir, 'phone-probe.md'), text + '\n');
  fs.writeFileSync(path.join(outDir, 'phone-probe.json'), JSON.stringify({ sides: sides.map(({ key, label, dir, port, pid }) => ({ key, label, dir, port, pid })), samples }, null, 1));
  const seen = new Map();
  for (const l of logs) { const k = `${l.page} ${l.kind}: ${l.text}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  fs.writeFileSync(path.join(outDir, 'browser-log.txt'), [...seen].map(([k, c]) => `${c}x ${k}`).join('\n') + '\n');
  console.log(`browser log: ${seen.size} distinct lines`);
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) {
    const issues = await s.server.stop();
    if (issues.length) console.log(`server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
    if (s.pid && alive(s.pid)) { process.kill(s.pid, 'SIGKILL'); console.log(`${s.key}: PID ${s.pid} killed`); }
    console.log(`${s.key}: PID ${s.pid} ${alive(s.pid) ? 'STILL ALIVE' : 'gone'}`);
  }
}
