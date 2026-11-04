// A check of the picker-reaction instrument for E07 (desktop, lan, no proxy), run after the A/B measurement:
// - `counter`: the journey as committed (a MutationObserver keeps every added node until the count after open 5, so
//   main's four discarded pickers stay alive);
// - `plain`: the same five opens without that observer, so main's pickers can be collected as on a real page;
// - `no-cdn`: plain, with the emoji CDN's requests aborted in the browser, to see how much of each open is the cells'
//   images (main makes ~1,000 new <img> per open; E07 moves the same ones).
// Pages alternate A, B per variant; each page is a prepared page reloaded once, as the journey does.
// Run: node probe-counter-cdn.mjs [--pages=3] [--port-a=5353] [--port-b=5354]
import { chromium } from '/home/agent/yap-perf/harness/tests/browser/node_modules/playwright/index.mjs';
import { startServer, waitTrue, sleep } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';
import { instruments } from '/home/agent/yap-perf/harness/tests/browser/perf-journeys.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const pages = Number(arg('pages', 3));
const HOME = '/home/agent/yap-perf';
const seedDir = `${HOME}/seed`;
const seed = readSeed(seedDir);
const sides = [
  { key: 'A', dir: `${HOME}/harness`, port: Number(arg('port-a', 5353)) },
  { key: 'B', dir: `${HOME}/exp/07-reaction-picker-once`, port: Number(arg('port-b', 5354)) },
];

const median = v => { const s = v.filter(x => x != null).sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

for (const s of sides) {
  s.server = await startServer({ dll: `${s.dir}/Yap/bin/Debug/net10.0/Yap.dll`, wwwroot: `${s.dir}/Yap/wwwroot`, port: s.port, scratch: `${HOME}/runs`, prepare: copySeed(seedDir), args: SERVER_ARGS });
  s.token = await signInToken(s.server.base, seed.measured).catch(() => seed.people.find(p => p.username === seed.measured).token);
}
const browser = await chromium.launch();
const cookie = s => [{ name: 'yap_auth', value: s.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }];

// The keeper page of perf.mjs: the person stays online, so no join line appears in the lobby.
for (const s of sides) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookie(s));
  const page = await ctx.newPage();
  await page.goto(s.server.base + '/settings');
  await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20_000, 200);
}

async function run(s, variant) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await ctx.addCookies(cookie(s));
    await ctx.addInitScript(instruments);
    const page = await ctx.newPage();
    const rowsMark = () => page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 60_000, polling: 50 });
    await page.goto(s.server.base + '/', { waitUntil: 'commit' });
    await rowsMark();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(2500);   // the snapshot is stored 2 s after the last change
    if (variant === 'no-cdn') await ctx.route(url => !url.href.startsWith(s.server.base), route => route.abort());
    await page.reload({ waitUntil: 'commit' });
    await rowsMark();
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(300);
    const marked = await page.evaluate(() => {
      const list = document.querySelector('.messages');
      const box = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll('.message-group:not(.system-message):not(.pending)')].filter(r => {
        const b = r.getBoundingClientRect();
        return b.top >= box.top + 40 && b.bottom <= box.bottom && !!r.querySelector('.message-actions .action-picker')
          && !!r.querySelector('.message-content')?.textContent.trim()
          && !r.querySelector('.message-content a, .image-gallery, .gif-message, .video-container, .voice-message, .reply-preview:not([hidden])');
      }).slice(-5);
      rows.forEach((r, i) => { r.dataset.perfRow = String(i + 1); });
      return rows.length;
    });
    if (marked < 5) throw new Error(`only ${marked} rows`);
    if (variant === 'counter') {
      await page.evaluate(() => {
        const added = window.__perfAdded = [];
        new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) added.push(n); })
          .observe(document, { childList: true, subtree: true });
      });
    }
    const grid = [];
    for (let i = 1; i <= 5; i++) {
      const row = page.locator(`.messages .message-group[data-perf-row="${i}"]`);
      await row.hover();
      await page.evaluate(() => window.__perf.watch('reaction', () => {
        const cell = document.querySelector('.emoji-picker-wrapper [data-section="smileys"] .emoji-btn');
        return !!cell && cell.offsetParent !== null;
      }));
      await row.locator('.message-actions .action-picker').click();
      grid.push(await page.evaluate(async () => { const t = await window.__perf.watches.reaction; return t == null ? null : t - window.__perf.input.click; }));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.emoji-picker-wrapper'), null, { timeout: 30_000, polling: 50 });
      await sleep(1000);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    return grid;
  } finally { await ctx.close(); }
}

const results = {};
for (const variant of ['counter', 'plain', 'no-cdn']) {
  for (let rep = 1; rep <= pages; rep++) {
    for (const s of rep % 2 ? sides : [...sides].reverse()) {
      const grid = await run(s, variant);
      (results[`${variant} ${s.key}`] ??= []).push(grid);
      console.log(`${variant} ${s.key}#${rep}: ${grid.map(v => v?.toFixed(1)).join(', ')}`);
    }
  }
}

console.log('\nvariant side: median of open 1 | median of open 2 | median of opens 3-5 | median of opens 2-5 (per page, then over pages)');
for (const [k, runs] of Object.entries(results)) {
  const per = f => median(runs.map(f));
  console.log(`${k}: ${per(g => g[0])?.toFixed(1)} | ${per(g => g[1])?.toFixed(1)} | ${per(g => median(g.slice(2)))?.toFixed(1)} | ${per(g => median(g.slice(1)))?.toFixed(1)}`);
}

await browser.close();
for (const s of sides) await s.server.stop();
