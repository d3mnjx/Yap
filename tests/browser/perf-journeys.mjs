// The journeys of perf.mjs: what one person does, timed inside the page. Each journey run returns samples, pairs of
// [metric, value]. A run gets a `site`: one build (side A or B) on one network profile, with its origin, its proxy, its
// warm page and a way to open new pages (perf.mjs). Times come from the page's own clock (performance.now), so the
// round trips between this process and the browser do not count.

import { sleep } from './lib.mjs';

// ---- the instruments in the page ----

// Installed before any script of the page (addInitScript):
// - the long tasks (over 50 ms) from the start of the document;
// - the time of the last click and of the last key, from the event's own time stamp: it includes the wait before a
//   busy main thread runs the handler, which is part of what a person feels;
// - watch(name, test): resolves with the time the DOM first passes the test (a MutationObserver checks after every
//   change, so the time is the change itself, not a poll interval), or with the first animation frame that passes
//   it for tests the DOM does not announce (an image that finished loading);
// - a resource timing buffer for the emoji picker's hundreds of images (the default keeps 250 entries).
export function instruments() {
  const perf = window.__perf = { longTasks: [], input: {}, watches: {} };
  try { performance.setResourceTimingBufferSize(100000); } catch { /* an old engine: counts stop at 250 */ }
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) perf.longTasks.push([e.startTime, e.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* no Long Tasks API: the counts stay 0 */ }
  for (const type of ['click', 'keydown']) {
    addEventListener(type, e => { perf.input[type] = e.timeStamp > 0 ? e.timeStamp : performance.now(); }, { capture: true });
  }
  perf.watch = (name, test, { frames = false, timeout = 60000 } = {}) => {
    perf.watches[name] = new Promise(resolve => {
      const end = performance.now() + timeout;
      const passes = () => { try { return !!test(); } catch { return false; } };
      if (passes()) { resolve(performance.now()); return; }
      if (frames) {
        const tick = () => { if (passes()) resolve(performance.now()); else if (performance.now() > end) resolve(null); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        return;
      }
      const observer = new MutationObserver(() => { if (passes()) { observer.disconnect(); resolve(performance.now()); } });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
  };
}

const PHASES = ['html', 'scripts', 'bootstrap', 'paint', 'socket', 'rows'];

// ---- the page load (cold-open, warm-open) ----

// Navigates (go) and waits for the server's rows of the first conversation, the last phase of the boot report (AD-41).
// The phases are the boot report's marks, read from the page; the files are the report's facts (same-origin resource
// entries and the page, up to the rows); the wire is the proxy's view (every byte, the worker's and the socket's too).
async function load({ page, cdp }, go, proxy) {
  proxy?.reset();
  await go();
  await page.waitForFunction(() => performance.getEntriesByName('rows', 'mark').length > 0, null, { timeout: 120_000, polling: 50 });
  const wire = proxy?.counters();
  // The server's bootstrap may land a moment after the rows (hub.reportLoad waits for it too).
  await page.waitForFunction(() => ['bootstrap', 'socket'].every(n => performance.getEntriesByName(n, 'mark').length), null, { timeout: 10_000, polling: 50 }).catch(() => {});
  const facts = await page.evaluate(phases => {
    const mark = name => performance.getEntriesByName(name, 'mark')[0]?.startTime ?? null;
    const [nav] = performance.getEntriesByType('navigation');
    const rows = mark('rows');
    const files = performance.getEntriesByType('resource').filter(r => r.name.startsWith(location.origin) && r.startTime <= rows);
    if (nav) files.push(nav);
    const long = window.__perf.longTasks.filter(([start]) => start <= rows);
    return {
      phases: Object.fromEntries(phases.map(p => [p, p === 'html' ? nav?.responseEnd ?? null : mark(p)])),
      requests: files.length, cached: files.filter(f => f.transferSize === 0).length,
      kb: files.reduce((s, f) => s + (f.transferSize || 0), 0) / 1024,
      longTasks: long.length, longMs: long.reduce((s, [, d]) => s + d, 0),
    };
  }, PHASES);
  const samples = PHASES.map(p => [`${p} ms`, facts.phases[p]]);
  samples.push(['requests', facts.requests], ['cached', facts.cached], ['KB', facts.kb]);
  if (wire) samples.push(['wire requests', wire.requests], ['wire KB', (wire.up + wire.down) / 1024]);
  samples.push(['long tasks', facts.longTasks], ['long task ms', facts.longMs], ['heap MB', await heapMB(cdp)]);
  return samples;
}

// The live heap after a collection: what the page keeps, not what it has not collected yet.
async function heapMB(cdp) {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    return usedSize / 1048576;
  } catch { return null; }
}

// A fresh context: no HTTP cache, no worker, no IndexedDB. Landing on `/` opens the lobby, the busiest room.
async function coldOpen(site, kind) {
  const p = await site.newPage(kind);
  try { return await load(p, () => p.page.goto(site.origin + '/', { waitUntil: 'commit' }), site.proxy); }
  finally { await p.ctx.close(); }
}

// The warm page of the site (loaded once, the worker installed and the snapshot stored), reloaded.
async function warmOpen(site) {
  const p = await site.warmPage();
  return load(p, () => p.page.reload({ waitUntil: 'commit' }), site.proxy);
}

// ---- in the open conversation ----

// The test of "the server's rows are on screen" after a room change: a new list (the old one is marked before the
// tap), with rows, without the loading line of a conversation never shown here, and without the "Catching up…" pill
// that marks the device's copy until the server answers (TL-39).
function serverRowsTest() {
  const list = document.querySelector('.messages:not([data-perf-old])');
  return !!list && !!list.querySelector('.message-group') && !list.querySelector('.loading-tail') && !document.querySelector('.catching-up');
}

// A tap on a room in the sidebar; the time from the click to the server's rows of that room.
async function tapRoom(page, name) {
  await page.evaluate(test => {
    document.querySelector('.messages')?.setAttribute('data-perf-old', '');
    // A function cannot cross into the page as a value, so the test travels as its source text.
    window.__perf.watch('room', new Function(`return (${test})()`));
  }, serverRowsTest.toString());
  await page.locator('.users-sidebar .rooms-list .room-item:not(.add-room)')
    .filter({ has: page.locator('.room-name', { hasText: new RegExp(`^${name}$`) }) }).click();
  return page.evaluate(async () => { const t = await window.__perf.watches.room; return t == null ? null : t - window.__perf.input.click; });
}

// The warm page in the busiest room with the server's rows, at the bottom: the start of send, room changes and older.
async function inLobby(site) {
  const p = await site.warmPage();
  const here = await p.page.evaluate(() => location.pathname === '/lobby' && !!document.querySelector('.messages .message-group') && !document.querySelector('.catching-up'));
  if (!here) await tapRoom(p.page, site.seed.lobby.name);
  return p;
}

// Ten texts, each typed and sent with Enter. The own row is the pending row of the outbox (IB-24, sender.js); the
// confirmation is the server's row that replaces it, the same moment the client reports the `send` wait (AD-26).
async function send(site, rep) {
  const { page } = await inLobby(site);
  const samples = [];
  for (let i = 1; i <= 10; i++) {
    const text = `perf ${site.side.key}${rep}.${i} ${Math.random().toString(36).slice(2, 8)}`;
    await page.fill('.message-input', text);
    await page.evaluate(text => {
      const has = selector => [...document.querySelectorAll(selector)].some(g => g.querySelector('.message-content')?.textContent.includes(text));
      window.__perf.watch('row', () => has('.messages .message-group'));
      window.__perf.watch('confirmed', () => has('.messages .message-group:not(.pending):not(.failed)'));
    }, text);
    await page.press('.message-input', 'Enter');
    const t = await page.evaluate(async () => {
      const [row, confirmed] = await Promise.all([window.__perf.watches.row, window.__perf.watches.confirmed]);
      const t0 = window.__perf.input.keydown;
      return { row: row == null ? null : row - t0, confirmed: confirmed == null ? null : confirmed - t0 };
    });
    samples.push(['own row ms', t.row], ['confirmed ms', t.confirmed]);
    await sleep(200);
  }
  await deleteOwn(page, `perf ${site.side.key}${rep}.`);
  return samples;
}

// The sent texts go again (through the hub, as the row's Delete does), so the lobby's newest rows stay the seed's:
// every later journey and profile opens the same tail.
async function deleteOwn(page, prefix) {
  await page.evaluate(async prefix => {
    const { state } = await import('/js/store.js');
    const hub = await import('/js/hub.js');
    const own = (state.open?.messages ?? []).filter(m => m.text?.startsWith(prefix));
    await Promise.all(own.map(m => hub.invoke('delete', m.id)));   // at once: one round trip on `far`, not ten
  }, prefix);
}

// The quiet room, then the busiest one again.
async function switchRoom(site) {
  const { page } = await inLobby(site);
  const quiet = await tapRoom(page, site.seed.quiet.name);
  await sleep(300);
  const busy = await tapRoom(page, site.seed.lobby.name);
  await sleep(300);
  const size = name => site.seed.rooms.find(r => r.name === name)?.messages;
  return [[`to ${site.seed.quiet.name} (${size(site.seed.quiet.name)}) ms`, quiet], [`to ${site.seed.lobby.name} (${size(site.seed.lobby.name)}) ms`, busy]];
}

// Three older pages in the busiest room: the list jumps to the top, the timeline asks for the page before its oldest
// row, and the page lands when the view is still (TL-06: 200 ms without a scroll event). The time runs from the jump
// to the rows in the DOM, so it includes that hold. The long tasks count from the first jump to a second after the
// last page.
async function older(site, rep, kind = 'desktop') {
  const p = kind === 'phone' ? await site.warmPage('phone') : await inLobby(site);
  // A fresh timeline of the newest rows: another room and back (the phone has no sidebar on screen: a reload).
  if (kind === 'phone') await load(p, () => p.page.reload({ waitUntil: 'commit' }), null);
  else { await tapRoom(p.page, site.seed.quiet.name); await tapRoom(p.page, site.seed.lobby.name); }
  await sleep(500);
  const samples = [];
  const start = await p.page.evaluate(() => performance.now());
  for (let i = 0; i < 3; i++) {
    const ms = await p.page.evaluate(async () => {
      const list = document.querySelector('.messages');
      const before = list.querySelectorAll('.message-group').length;
      window.__perf.watch('older', () => list.querySelectorAll('.message-group').length > before, { timeout: 30000 });
      const t0 = performance.now();
      list.scrollTop = 0;
      const t = await window.__perf.watches.older;
      return t == null ? null : t - t0;
    });
    samples.push(['page landed ms', ms]);
    await sleep(300);
  }
  await sleep(700);
  const long = await p.page.evaluate(start => window.__perf.longTasks.filter(([s]) => s >= start), start);
  samples.push(['long tasks', long.length], ['long task ms', long.reduce((s, [, d]) => s + d, 0)]);
  return samples;
}

// ---- the pickers ----

// Two opens of a picker on a new device, each the first open of a page load (a warm open on the profile's link, then
// a settled page, then the click): `first` meets image caches that hold only what the lobby's rows asked for, as on a
// device that never opened the picker; `again` meets the caches the first open filled. Repetitions on one device
// would mix the two cases.
async function picker(site, measure) {
  const p = await site.prepared();
  try {
    const samples = [];
    for (const when of ['first', 'again']) {
      await load(p, () => p.page.reload({ waitUntil: 'commit' }), null);
      await p.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await sleep(300);
      for (const [metric, value] of await measure(p.page)) samples.push([`${when}: ${metric}`, value]);
      await p.page.keyboard.press('Escape');
    }
    return samples;
  } finally { await p.ctx.close(); }
}

// Every image inside `selector` that shows on screen has loaded (or failed: `complete` is true for both).
function imagesTest(selector) {
  return `() => {
    const pane = document.querySelector(${JSON.stringify(selector)});
    if (!pane) return false;
    const box = pane.getBoundingClientRect();
    const shown = [...pane.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right; });
    return shown.length > 0 && shown.every(i => i.complete);
  }`;
}

// The emoji picker: the click to the grid, the click to the first screen of images complete, and the requests the
// page issued in the first 2 s (every <img> is a request of its own; on the iPhone each costs, 2026-10-31).
async function measureEmoji(page) {
  await page.evaluate(images => {
    window.__perf.watch('grid', () => document.querySelector('.message-input-container[data-picker="emoji"] [data-picker-pane="emoji"] .emoji-btn'));
    window.__perf.watch('images', new Function(`return (${images})()`), { frames: true, timeout: 20000 });
  }, imagesTest('[data-picker-pane="emoji"] .emoji-content'));
  await page.click('.emoji-toggle-button');
  const t = await page.evaluate(async () => {
    const perf = window.__perf, t0 = perf.input.click;
    const [grid, images] = await Promise.all([perf.watches.grid, perf.watches.images]);
    await new Promise(r => setTimeout(r, Math.max(0, t0 + 2000 - performance.now())));
    const requests = performance.getEntriesByType('resource').filter(e => e.startTime >= t0 && e.startTime <= t0 + 2000).length;
    return { grid: grid == null ? null : grid - t0, images: images == null ? null : images - t0, requests };
  });
  return [['grid ms', t.grid], ['images ms', t.images], ['requests in 2 s', t.requests]];
}

// The GIF picker: the click to its first content, the Recent grid (the seed's GIFs) or an empty state, and the click
// to the first screen of its images complete when it shows a grid.
async function measureGif(page) {
  await page.evaluate(images => {
    window.__perf.watch('shown', () => { const r = document.querySelector('.gif-results'); return !!r && r.children.length > 0 && !/Loading/.test(r.textContent); });
    window.__perf.watch('images', new Function(`return (${images})()`), { frames: true, timeout: 20000 });
  }, imagesTest('.gif-results'));
  await page.click('.gif-toggle-button');
  const t = await page.evaluate(async () => {
    const perf = window.__perf, t0 = perf.input.click;
    const shown = await perf.watches.shown;
    const grid = !!document.querySelector('.gif-results .gif-card');
    const images = grid ? await perf.watches.images : null;
    return { shown: shown == null ? null : shown - t0, images: images == null ? null : images - t0, grid };
  });
  return [[t.grid ? 'grid ms' : 'empty state ms', t.shown], ['images ms', t.images]];
}


// ---- the resume (load.mjs, step 4), all repetitions at once ----

// A resume needs 35 s of a frozen page, so the repetitions share that wait: every page of both sides loads, hides,
// freezes and loses its socket together; after 35 s someone else posts in the lobby, and the pages thaw one at a
// time, the sides alternating, each timed from its return to that message on screen. Each page was frozen longer than
// the server's 30 s timeout, so each takes the restart path of hub.js. The pages load through the proxy without
// delay (the load is not measured); the link applies from the freeze on. On `lan` the proxy only forwards: the dead
// socket needs it.
//
// The freeze is a paused debugger, not load.mjs's Page.setWebLifecycleState: in this Chromium (Playwright 1.47,
// headless) that call returns ok and the page's timers keep running, so SignalR's own 30 s timeout fired while the
// page was "frozen", the page reconnected, and the return found the rows already there (measured 2026-11-04: ticks
// every second through the freeze, connected again 33.7 s after the dead socket). A paused page runs no script at
// all, as a suspended app on a phone; its overdue timers fire at the return.
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

async function resumeAll(sites, n) {
  const runs = [];
  for (const site of sites) {
    for (let rep = 1; rep <= n; rep++) runs.push({ site, rep, ...await site.prepared('desktop', site.side.proxy.origin) });
  }
  for (const r of runs) {
    await r.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  await sleep(1500);
  for (const r of runs) await freeze(r);
  for (const site of sites) site.side.proxy.blackhole();
  await sleep(35_000);
  for (const site of sites) site.napText = await site.postInLobby(`after the nap ${site.side.key} ${Date.now()}`);

  const results = [];
  for (let rep = 1; rep <= n; rep++) {
    for (const site of rep % 2 ? sites : [...sites].reverse()) {
      const r = runs.find(x => x.site === site && x.rep === rep);
      try {
        await thaw(r);
        const ms = await r.page.evaluate(async text => {
          window.__perf.watch('back', () => [...document.querySelectorAll('.messages .message-group .message-content')].some(c => c.textContent.includes(text)), { timeout: 90000 });
          const t0 = performance.now();
          delete document.visibilityState; delete document.hidden;
          document.dispatchEvent(new Event('visibilitychange'));
          const t = await window.__perf.watches.back;
          return t == null ? null : t - t0;
        }, site.napText);
        results.push({ site, rep, samples: [['return to rows ms', ms]] });
      } catch (e) {
        results.push({ site, rep, error: e.message.split('\n')[0] });
      } finally { await r.ctx.close(); }
    }
  }
  return results;
}

// One untimed walk per server before the first measurement: a load, two room changes, an older page and a send. The
// first call of each path pays for the server's JIT and its cold caches, and that cost belongs to neither side.
export async function warmUp(site) {
  const p = await site.newPage('desktop');
  try {
    await load(p, () => p.page.goto(site.origin + '/', { waitUntil: 'commit' }), null);
    await tapRoom(p.page, site.seed.quiet.name);
    await tapRoom(p.page, site.seed.lobby.name);
    await p.page.evaluate(() => { document.querySelector('.messages').scrollTop = 0; });
    await sleep(1500);
    await p.page.fill('.message-input', 'perf warm-up');
    await p.page.press('.message-input', 'Enter');
    await sleep(1000);
    await deleteOwn(p.page, 'perf warm-up');
  } finally { await p.ctx.close(); }
}

// name -> { run(site, rep) } or { all(sites, n) }. The phone rows are the cold open and the older pages at
// 390x800, three device pixels per CSS pixel, the CPU four times slower (CDP), touch on.
export const JOURNEYS = {
  'cold-open': { run: site => coldOpen(site, 'desktop') },
  'warm-open': { run: site => warmOpen(site) },
  'resume': { all: resumeAll },
  'send': { run: send },
  'switch-room': { run: switchRoom },
  'older': { run: (site, rep) => older(site, rep) },
  'picker-emoji': { run: site => picker(site, measureEmoji) },
  'picker-gif': { run: site => picker(site, measureGif) },
  'phone-cold-open': { run: site => coldOpen(site, 'phone') },
  'phone-older': { run: (site, rep) => older(site, rep, 'phone') },
};
