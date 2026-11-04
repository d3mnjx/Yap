// The dev-loop check of docs/performance-notes.md: the load and the resume of one user on a slow link, printed
// for a comparison before and after a change. Nothing asserts on the numbers; the link makes them noisy, and the
// reader compares two runs. The plumbing is checked: the boot report (AD-41) must arrive, the resume must end.
//
// The slow link is a TCP proxy in this process (proxy.mjs), not a CDP throttle: a CDP throttle shapes the page's
// requests only, never the service worker's fetches or the WebSocket frames, and the shell caching is the worker's
// work. The proxy can also kill the server side of a socket while the client side stays open and silent: a socket
// dead without a close, as after a long sleep. perf.mjs measures more journeys through the same proxy, A/B.
//
// Run from tests/browser: npm run load  (-- --port=<n> to move the server; the proxy takes the next port)

import { chromium } from 'playwright';
import { BASE, PORT, row, sleep, waitTrue, step, finish, startServer, signIn, watchContext, watchPage } from './lib.mjs';
import { startProxy } from './proxy.mjs';

const LINK = { oneWayMs: 450, bytesPerSec: 125_000 };   // 900 ms round trip, 1 Mbit/s each way; production reports replace these later
const PROXY_PORT = PORT + 1;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

const proxy = startProxy({ port: PROXY_PORT, upstream: PORT });
const server = await startServer();
const browser = await chromium.launch();

// The boot report of the newest live connection with one (AD-41), through the admin diagnostics of the page itself.
const diagnostics = page => page.evaluate(() => fetch('/api/admin/diagnostics').then(r => r.json()));
async function loadReport(page, after) {
  let found = null;
  await waitTrue(async () => {
    const d = await diagnostics(page);
    found = d.sessions.filter(s => s.connected && s.load && new Date(s.connectedAt) > after).sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt))[0] ?? null;
    return !!found;
  }, 120_000, 1500);
  return found;
}
const PHASES = ['html', 'scripts', 'bootstrap', 'paint', 'socket', 'rows'];
const line = (title, s) => s
  ? `${title.padEnd(14)} ${PHASES.map(p => `${p} ${String(s.load[p] ?? '—').padStart(5)}`).join('  ')}   files ${s.load.requests}, cached ${s.load.cached}, ${Math.round(s.load.bytes / 1024)} KB, ${s.load.protocol}, ${s.browser} ${s.os}${s.pwa ? ' app' : ''}${s.load.build ? `, build ${s.load.build}` : ''}${s.load.hidden ? ' (hidden)' : ''}`
  : `${title.padEnd(14)} no report arrived`;

let cookies;
await step(1, 'Sign in and seed 120 messages (no link yet)', async (check) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); watchContext(ctx, 'seed');
  const A = await ctx.newPage(); watchPage(A, 'seed');
  await signIn(A, 'boss');
  await A.goto(BASE + '/admin');
  const debugTab = A.locator('.page-admin .nav-item[data-tab="debug"]');
  check(await waitTrue(async () => (await debugTab.count()) > 0, 10000, 100), 'admin page up');
  await debugTab.click();
  await A.fill('.page-admin .debug-form input[type=number]', '120');
  await A.locator('.page-admin .generate-btn').click();
  check(await waitTrue(async () => ((await A.locator('.page-admin .debug-result').textContent()) ?? '').startsWith('Generated'), 10000, 100), 'messages generated');
  cookies = await ctx.cookies();   // the cookie is per host, not per port: it works at the proxy's origin too
  await ctx.close();
});

// A fresh context at the proxy's origin: no HTTP cache, no worker, no stored snapshot. Cold.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); watchContext(ctx, 'P');
await ctx.addCookies(cookies);
const P = await ctx.newPage(); watchPage(P, 'P');
proxy.set(LINK);

await step(2, `Load 1, cold: ${LINK.oneWayMs * 2} ms round trip, ${LINK.bytesPerSec * 8 / 1000} kbit/s`, async (check, notes) => {
  const since = new Date();
  await P.goto(PROXY + '/lobby', { waitUntil: 'commit' });
  const s = await loadReport(P, since);
  check(!!s, 'the boot report reached the server');
  notes.push(line('load 1 (cold)', s));
});

await step(3, 'Load 2, warm: the same link, the worker installed', async (check, notes) => {
  await P.evaluate(() => navigator.serviceWorker.ready.then(() => true)).catch(() => {});   // the precache is part of the install
  await P.waitForLoadState('networkidle').catch(() => {});
  const since = new Date();
  await P.goto(PROXY + '/lobby', { waitUntil: 'commit' });
  const s = await loadReport(P, since);
  check(!!s, 'the boot report reached the server');
  notes.push(line('load 2 (warm)', s));
  if (s) notes.push(`cached ${s.load.cached} of ${s.load.requests} files: with the shell cache-first this is close to all of them`);
});

await step(4, 'Resume: hidden and frozen 35 s with a dead socket, then back', async (check, notes) => {
  await P.waitForLoadState('networkidle').catch(() => {});
  const cdp = await ctx.newCDPSession(P);
  // The order of a real background: the tab hides (its heartbeat says so), the system freezes the page, the
  // socket dies without a close. Then the server drops the connection after its 30 s timeout.
  await P.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500);
  const frozen = await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).then(() => true, () => false);
  notes.push(frozen ? 'page frozen (timers stop, as in a background app)' : 'freeze not available: timers kept running while hidden');
  proxy.blackhole();
  await sleep(35_000);

  // A message from someone else while the page is away: it shows only with the server's rows after the return.
  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 800 } }); watchContext(ctxB, 'B');
  const B = await ctxB.newPage(); watchPage(B, 'B');
  await signIn(B, 'buddy');
  const text = `after the nap ${Date.now()}`;
  await B.fill('.message-input', text);
  await B.press('.message-input', 'Enter');
  await waitTrue(async () => (await row(B, text).count()) > 0, 5000, 100);

  const t0 = Date.now();
  if (frozen) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await P.evaluate(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  // The connection states on the way, as the dot shows them, for a reading of where the time goes.
  const seen = new Map();
  const back = await waitTrue(async () => {
    const cls = await P.evaluate(() => document.querySelector('.connection-dot')?.className ?? '').catch(() => '');
    for (const c of cls.split(/\s+/)) if (c && c !== 'connection-dot' && !seen.has(c)) seen.set(c, Date.now() - t0);
    return (await row(P, text).count()) > 0;
  }, 90_000, 100);
  const took = Date.now() - t0;
  notes.push(`dot states after the return: ${[...seen].map(([c, ms]) => `${c} at ${ms} ms`).join(', ') || 'none seen'}`);
  check(back, `the return to the server's rows: ${back ? took : '> 90000'} ms`);
  notes.push(`resume         return → rows ${took} ms (three round trips on this link: upgrade, handshake, openRoom; the frozen page's overdue timer fires at the thaw, so the 30 s wait does not show here)`);
  await ctxB.close();
});

proxy.close();
await finish(browser, server);
process.exit();   // the proxy's sockets and timers would keep the process alive
