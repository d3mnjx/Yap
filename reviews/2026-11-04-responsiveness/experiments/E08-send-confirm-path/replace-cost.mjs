// E08: the cost of the one thing B removes from every send, measured alone on the phone of phone-probe.mjs (390x800,
// dpr 3, touch, CPU x4, no proxy). The send journey cannot show it: on that phone the hub's copy confirms the row
// first and the POST's copy replaces it about 20 ms later, after the `confirmed` moment, and a few ms hide in the
// 150 to 350 ms of main-thread work around each send.
//
// On build A (main) only: the timeline code is the same on both sides, B only stops calling replaceMessage for an
// identical copy. One own message is sent and confirmed, then replaceMessage(an identical copy) runs 20 times, 400 ms
// apart. Each time: the synchronous redraw (the store's listeners, the timeline's renderRow and replaceWith), then a
// forced style and layout (scrollHeight). The baseline is the same forced layout without a replace.
//
// Run: node replace-cost.mjs [--out=<dir>]. One server on 5313, stopped by PID.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, waitTrue, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';
import { instruments } from '/home/agent/yap-perf/harness/tests/browser/perf-journeys.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const outDir = path.resolve(arg('out', '/home/agent/yap-perf/results/E08-send-confirm-path/phone-probe'));
const seedDir = '/home/agent/yap-perf/seed';
const PHONE = { viewport: { width: 390, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const dir = '/home/agent/yap-perf/harness', port = 5313;

function serverPid(port) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (cmd.includes(`http://127.0.0.1:${port}`) && cmd.some(c => c.endsWith('Yap.dll'))) return Number(d);
    } catch { /* ended meanwhile */ }
  }
  return null;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const median = v => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

const seed = readSeed(seedDir);
let server, pid, browser;
try {
  server = await startServer({ dll: path.join(dir, 'Yap/bin/Debug/net10.0/Yap.dll'), wwwroot: path.join(dir, 'Yap/wwwroot'), port,
    scratch: '/home/agent/yap-perf/runs', prepare: copySeed(seedDir), args: SERVER_ARGS });
  pid = serverPid(port);
  const token = await signInToken(server.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
  const cookie = [{ name: 'yap_auth', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];
  browser = await chromium.launch();
  const keeper = await browser.newContext(DESKTOP);   // the person stays online (perf.mjs)
  await keeper.addCookies(cookie);
  const kp = await keeper.newPage();
  await kp.goto(server.base + '/settings');
  await waitTrue(() => kp.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200);

  const ctx = await browser.newContext(PHONE);
  await ctx.addCookies(cookie);
  await ctx.addInitScript(instruments);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(server.base + '/', { waitUntil: 'commit' });
  await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 100 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await sleep(2500);
  const text = `perf replace-cost ${Math.random().toString(36).slice(2, 8)}`;
  await page.fill('.message-input', text);
  await page.tap('.send-button');
  await page.waitForFunction(text => [...document.querySelectorAll('.messages .message-group:not(.pending)')].some(g => g.querySelector('.message-content')?.textContent.includes(text)), text, { timeout: 10_000 });
  await sleep(2000);
  const runs = [];
  for (let i = 0; i < 20; i++) {
    runs.push(await page.evaluate(async text => {
      const store = await import('/js/store.js');
      const list = document.querySelector('.messages');
      const m = store.state.open.messages.find(x => x.text?.includes(text));
      const copy = JSON.parse(JSON.stringify(m));   // what the second copy is: equal JSON, a new object
      const b0 = performance.now(); void list.scrollHeight; const b1 = performance.now();   // baseline: a clean layout
      const t0 = performance.now();
      store.replaceMessage(copy);
      const t1 = performance.now();
      void list.scrollHeight;
      const t2 = performance.now();
      const still = [...document.querySelectorAll('.messages .message-group')].filter(g => g.querySelector('.message-content')?.textContent.includes(text)).length;
      return { redrawMs: t1 - t0, layoutMs: t2 - t1, baselineMs: b1 - b0, rows: still };
    }, text));
    await sleep(400);
  }
  await page.evaluate(async text => {
    const { state } = await import('/js/store.js');
    const hub = await import('/js/hub.js');
    await Promise.all(state.open.messages.filter(m => m.text?.includes(text)).map(m => hub.invoke('delete', m.id)));
  }, text);
  const pick = k => runs.map(r => r[k]);
  const line = k => `median ${median(pick(k)).toFixed(2)} ms, min ${Math.min(...pick(k)).toFixed(2)}, max ${Math.max(...pick(k)).toFixed(2)}`;
  const total = runs.map(r => r.redrawMs + r.layoutMs);
  const report = [`# E08: one replaceMessage of the own row on the phone (CPU x4), build A, 20 times`, '',
    `- synchronous redraw (listeners, renderRow, replaceWith): ${line('redrawMs')}`,
    `- forced style and layout after it: ${line('layoutMs')}`,
    `- redraw plus layout: median ${median(total).toFixed(2)} ms, min ${Math.min(...total).toFixed(2)}, max ${Math.max(...total).toFixed(2)}`,
    `- baseline forced layout without a replace: ${line('baselineMs')}`,
    `- rows with the text after each replace: ${[...new Set(pick('rows'))].join(', ')} (one row, redrawn in place)`,
    `- server PID ${pid}`].join('\n');
  console.log(report);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'replace-cost.md'), report + '\n');
  fs.writeFileSync(path.join(outDir, 'replace-cost.json'), JSON.stringify(runs, null, 1));
} finally {
  await browser?.close().catch(() => {});
  if (server) await server.stop();
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  console.log(`server PID ${pid} ${pid && alive(pid) ? 'STILL ALIVE' : 'gone'}`);
}
