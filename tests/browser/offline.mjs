// The offline run (offline.md): the service worker, the dot, the outbox, a reload without a network from the
// shell cache and the IndexedDB snapshots, the return of the network, a repeated POST, a file sent offline,
// the new-version strip, and the sign-out that empties IndexedDB. Run: npm run offline (see README.md).

import { chromium } from 'playwright';
import { acceptDialogs, SHOTS, sleep, waitTrue, short, row, step, stepLogs, fmt, finish, startServer, signIn, watchContext, watchPage, fixture, makePng, sendFiles } from './lib.mjs';

// Playwright applies setOffline to the service worker only with this variable, and reads it when a worker
// appears, so setting it here (after the hoisted imports, before the launch) is in time. Without it the worker
// still reaches the server and the offline reload proves nothing. It is not in package.json because
// `VAR=1 node ...` does not work in the Windows shell that npm uses.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const PNG = makePng(fixture('tiny.png'), [200, 120, 40], 1);   // step 10 looks for this file name on the thumbnail of the pending row
const dotState = async p => p.locator('.connection-dot').evaluate(e => ({ hidden: e.hidden, display: getComputedStyle(e).display, cls: e.className }));
// A plain summary of the client's store, for checks that the DOM cannot show (the open conversation's identity, hasMore, the counts).
const st = p => p.evaluate(async () => {
  const s = (await import('/js/store.js')).state;
  return { connection: s.connection, user: s.user?.username ?? null, pending: s.pending.length, unread: s.unread,
    open: s.open ? { channelId: s.open.channelId, partner: s.open.partner ?? null, hasMore: s.open.hasMore, texts: s.open.messages.map(m => m.text) } : null };
});
const go = (p, path) => p.evaluate(async path => (await import('/js/router.js')).navigate(path), path);

const server = await startServer();
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxA, 'A');
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxB, 'B');
const A = await ctxA.newPage(); watchPage(A, 'A');
const B = await ctxB.newPage(); watchPage(B, 'B');

await step(1, 'Service worker', async (check) => {
  await signIn(A, 'boss');
  await waitTrue(async () => new URL(A.url()).pathname === '/lobby', 3000);
  check(new URL(A.url()).pathname === '/lobby', `path ${new URL(A.url()).pathname}`);
  await sleep(2000);
  const before = await A.evaluate(() => !!navigator.serviceWorker.controller);
  const t0 = Date.now();
  const ready = await A.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => r.active?.scriptURL ?? 'no active'), new Promise(r => setTimeout(() => r('timeout'), 8000))]));
  check(ready !== 'timeout', `controller before reload: ${before}; ready -> ${short(ready)} (${Date.now() - t0} ms)`);
  await A.reload();
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const ctl = await A.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
  check(!!ctl, `controller after one reload: ${ctl ? short(ctl) : null}`);
  const keys = await A.evaluate(() => caches.keys());
  const shell = keys.find(k => k.startsWith('yap-shell-'));
  const n = shell ? await A.evaluate(k => caches.open(k).then(c => c.keys()).then(r => r.length), shell) : 0;
  check(!!shell, `caches.keys(): ${JSON.stringify(keys)}; ${shell} holds ${n} entries`);
  const errs = stepLogs(1);
  check(true, `log entries in step 1: ${errs.length}${errs.length ? ' — ' + fmt(errs) : ''}`);
});

await step(2, 'Online send, B receives', async (check) => {
  await A.fill('.message-input', 'first online');
  await A.press('.message-input', 'Enter');
  const ok = await waitTrue(async () => (await row(A, 'first online').count()) === 1 && !(await row(A, 'first online').getAttribute('class')).includes('pending'), 5000, 50);
  check(ok, `A row normal: ${ok} (class "${await row(A, 'first online').getAttribute('class').catch(() => null)}")`);
  await signIn(B, 'guest');
  await waitTrue(async () => new URL(B.url()).pathname === '/lobby', 3000);
  const okB = await waitTrue(async () => (await row(B, 'first online').count()) === 1, 5000);
  check(okB, `B path ${new URL(B.url()).pathname}, sees "first online": ${okB}`);
});

await step(3, 'Go offline: dot, bubble, status menu', async (check) => {
  await sleep(3000);   // let the snapshot of the lobby and the people catch up (~2 s) before the network goes
  const t0 = Date.now();
  await ctxA.setOffline(true);
  const shown = await waitTrue(async () => { const s = await dotState(A); return !s.hidden && s.display !== 'none'; }, 45000, 50);
  const dt = Date.now() - t0;
  const s = await dotState(A);
  check(shown && dt <= 3000 && s.cls.includes('offline'), `dot shown: ${shown} after ${dt} ms (limit 3 s); class "${s.cls}", display ${s.display}; navigator.onLine=${await A.evaluate(() => navigator.onLine)}`);
  await A.locator('.connection-dot').hover();
  const hoverTxt = await A.locator('.connection-bubble').innerText().catch(() => null);
  await A.locator('.connection-dot').click();
  await sleep(200);
  const clickTxt = await A.locator('.connection-bubble').innerText().catch(() => null);
  check(!!clickTxt, `bubble on hover: "${hoverTxt}"; after click: ${clickTxt === null ? 'no bubble' : `"${clickTxt}"`}`);
  await A.mouse.click(400, 300);
  await A.click('.status-button');
  await A.locator('.status-dropdown').waitFor({ state: 'visible', timeout: 3000 });
  const dis = await A.locator('.status-dropdown [data-status]').evaluateAll(els => els.map(e => `${e.dataset.status}:${e.disabled}`));
  check(dis.length === 3 && dis.every(d => d.endsWith(':true')), `status items ${dis.join(', ')}`);
  await A.keyboard.press('Escape');
  const closed = await waitTrue(async () => (await A.locator('.status-dropdown').count()) === 0, 2000);
  check(closed, `Escape closes the menu: ${closed}`);
});

await step(4, 'Offline send stays pending', async (check) => {
  await A.fill('.message-input', 'sent offline');
  await A.press('.message-input', 'Enter');
  const ok = await waitTrue(async () => (await A.locator('.message-group.pending', { hasText: 'sent offline' }).count()) === 1, 3000);
  await sleep(3000);
  const still = (await A.locator('.message-group.pending', { hasText: 'sent offline' }).count()) === 1;
  const st = (await A.locator('.message-group', { hasText: 'sent offline' }).locator('.pending-status').innerText().catch(() => '')).trim();
  check(ok && still, `pending row: ${ok}, still pending after 3 s: ${still}, pending-status "${st}"`);
  await A.screenshot({ path: SHOTS + '10-offline-pending.png' });
});

await step(5, 'Offline send into a direct message never opened here (OF-08)', async (check) => {
  await go(A, '/dm/guest');
  const opened = await waitTrue(async () => new URL(A.url()).pathname === '/dm/guest' && (await A.locator('.message-input').count()) === 1, 3000);
  await sleep(300);
  await A.fill('.message-input', 'dm while offline');
  await A.press('.message-input', 'Enter');
  const pending = await waitTrue(async () => (await A.locator('.message-group.pending', { hasText: 'dm while offline' }).count()) === 1, 3000);
  const s = await st(A);
  const draft = await A.inputValue('.message-input');
  check(opened && pending && s.pending === 1 && draft === '', `DM opened offline ${opened}; pending row ${pending}; store open ${JSON.stringify(s.open && { channelId: s.open.channelId, partner: s.open.partner })}, pending ${s.pending}, draft "${draft}"`);
  await go(A, '/lobby');
  const back = await waitTrue(async () => new URL(A.url()).pathname === '/lobby' && (await row(A, 'first online').count()) === 1, 3000);
  check(back, `back on /lobby from the stored tail: ${back}; pending rows shown here ${await A.locator('.message-group.pending').count()} (the lobby's own)`);
});

await step(6, 'Offline reload', async (check) => {
  let resp = null;
  try { resp = await A.reload({ timeout: 15000 }); } catch (e) { check(false, 'reload threw: ' + e.message.split('\n')[0]); }
  check(!!resp, `document status ${resp?.status()}, fromServiceWorker ${resp?.fromServiceWorker()}`);
  const frame = await waitTrue(async () => (await A.locator('.chat-container').count()) > 0, 10000);
  check(frame, `frame shown: ${frame}, path ${new URL(A.url()).pathname}`);
  await sleep(1500);
  const first = (await row(A, 'first online').count()) === 1;
  const pend = await A.locator('.message-group', { hasText: 'sent offline' }).getAttribute('class').catch(() => null);
  check(first, `"first online" from snapshot: ${first}`);
  const guestRow = await A.locator('.users-list .user-item', { hasText: 'guest' }).count();
  check(guestRow > 0, `guest row in people list: ${guestRow > 0} (${(await A.locator('.users-list .user-item').allInnerTexts()).map(t => t.trim()).join(' | ')})`);
  check(!!pend && pend.includes('pending'), `"sent offline" row class: ${pend}`);
  const top = await A.locator('.messages-container .history-start, .messages-container .load-earlier, .messages-container .loading-older').allInnerTexts().catch(() => []);
  const s = await dotState(A).catch(() => null);
  check(!!s && !s.hidden && s.cls.includes('offline'), `top note(s): ${JSON.stringify(top.map(t => t.trim()))}; dot ${s ? `hidden=${s.hidden} display=${s.display} class "${s.cls}"` : 'missing'}`);
  await A.screenshot({ path: SHOTS + '11-offline-reload.png' });
  const fails = stepLogs(6, 'A').filter(l => l.kind === 'requestfailed' || l.kind === 'http');
  const nonApi = fails.filter(l => !/\/api\/|\/hub/.test(l.text) && !l.page.endsWith('/sw'));
 check(nonApi.length === 0, `page-level non-API failures ${nonApi.length}; all failed requests during offline reload (${fails.length}; /sw = the worker's network try before its cache): ${fails.map(l => `${l.page} ${l.text}`).join(' ; ') || 'none'}`);
  const other = stepLogs(6, 'A').filter(l => l.kind !== 'requestfailed' && l.kind !== 'http');
  check(other.filter(l => l.kind === 'pageerror').length === 0, `console/page entries: ${other.length ? fmt(other) : 'none'}`);
});

await step(7, 'Back online: outbox posts', async (check) => {
  const t0 = Date.now();
  await ctxA.setOffline(false);
  const ok = await waitTrue(async () => { const c = await A.locator('.message-group', { hasText: 'sent offline' }).getAttribute('class'); return c && !c.includes('pending'); }, 15000, 100);
  const tA = Date.now() - t0;
  const okB = await waitTrue(async () => (await row(B, 'sent offline').count()) >= 1, Math.max(0, 15000 - (Date.now() - t0)), 100);
  const tB = Date.now() - t0;
  const nA = await row(A, 'sent offline').count(), nB = await row(B, 'sent offline').count();
  check(ok, `A row normal: ${ok} after ${tA} ms (rows with the text: ${nA})`);
  check(okB && nB === 1, `B received: ${okB} after ${tB} ms (rows: ${nB})`);
  const s = await dotState(A);
  check(s.hidden, `dot after reconnect: hidden=${s.hidden} class "${s.cls}"`);
  await A.screenshot({ path: SHOTS + '12-back-online.png' });
  await go(B, '/dm/boss');
  const okDm = await waitTrue(async () => (await row(B, 'dm while offline').count()) === 1, 10000, 100);
  check(okDm, `B /dm/boss shows the message queued for the never-opened DM: ${okDm}`);
  await go(B, '/lobby');
  await waitTrue(async () => new URL(B.url()).pathname === '/lobby' && (await row(B, 'first online').count()) === 1, 3000);
});

await step(8, 'Reconnect after more than a page arrived (TL-35)', async (check) => {
  const before = (await st(A)).open.texts.length;
  await ctxA.setOffline(true);
  await sleep(300);
  const posted = await B.evaluate(async () => {
    const id = (await import('/js/store.js')).state.open.channelId;
    let ok = 0;
    for (let i = 1; i <= 60; i++) {
      const r = await fetch(`/api/channels/${id}/messages`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: crypto.randomUUID(), text: `gap-${i}` }) });
      if (r.ok) ok++;
    }
    return ok;
  });
  await ctxA.setOffline(false);
  const connected = await waitTrue(async () => (await st(A)).connection === 'connected', 15000, 100);
  await sleep(800);
  const s = await st(A);
  check(posted === 60 && connected, `B posted ${posted} while A was offline; A reconnected ${connected}; A rows before ${before}`);
  check(s.open.texts.length === 50 && s.open.hasMore && s.open.texts.includes('gap-60') && !s.open.texts.includes('gap-1'), `after the reconnect: ${s.open.texts.length} rows, hasMore ${s.open.hasMore}, first "${s.open.texts[0]}", gap-60 ${s.open.texts.includes('gap-60')}, gap-1 ${s.open.texts.includes('gap-1')} (the tail replaces the rows before the gap)`);
  await A.locator('.messages').evaluate(e => { e.scrollTop = 0; });
  const filled = await waitTrue(async () => (await st(A)).open.texts.includes('gap-1') && (await st(A)).open.texts.includes('first online'), 5000, 100);
  check(filled, `scrolling up fills the gap: gap-1 and "first online" loaded ${filled}, rows ${(await st(A)).open.texts.length}`);
  await A.locator('.messages').evaluate(e => { e.scrollTop = e.scrollHeight; });
});

await step(9, 'Repeat POST with the same clientId', async (check) => {
  const out = await A.evaluate(async () => {
    const id = await fetch('/api/bootstrap').then(r => r.json()).then(d => d.rooms[0].id);
    const post = () => fetch(`/api/channels/${id}/messages`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: '11111111-1111-1111-1111-111111111111', text: 'twice' }) })
      .then(async r => ({ status: r.status, body: await r.text() }));
    const a = await post(); const b = await post();
    return { id, a, b };
  });
  const ja = (() => { try { return JSON.parse(out.a.body); } catch { return null; } })();
  const jb = (() => { try { return JSON.parse(out.b.body); } catch { return null; } })();
  check(out.a.status === 200 && out.b.status === 200, `statuses ${out.a.status}, ${out.b.status}`);
  check(!!ja?.id && ja.id === jb?.id, `ids ${ja?.id ?? out.a.body.slice(0, 120)} / ${jb?.id ?? out.b.body.slice(0, 120)}`);
  await sleep(1500);
  check((await row(B, 'twice').count()) === 1, `rows "twice" in B: ${await row(B, 'twice').count()}, in A: ${await row(A, 'twice').count()}`);
});

await step(10, 'File upload offline, then online', async (check) => {
  await ctxA.setOffline(true);
  await waitTrue(async () => !(await dotState(A)).hidden, 10000);
  await sleep(300);
  await sendFiles(A, PNG);
  await sleep(500);
  const modal = await A.locator('.warning-modal').isVisible().catch(() => false);
  const r = A.locator('.message-group.pending').filter({ has: A.locator('.pending-thumb[title^="tiny.png"]') });
  const has = await waitTrue(async () => (await r.count()) === 1, 3000);
  await sleep(2000);
  const info = has ? await r.evaluate(e => ({ cls: e.className, thumbs: [...e.querySelectorAll('.pending-thumb')].map(t => t.title), status: e.querySelector('.pending-status')?.textContent ?? null, cancel: !!e.querySelector('.pending-cancel'), retry: !!e.querySelector('.pending-retry'), track: !!e.querySelector('.upload-progress-track') })) : null;
  check(has && !info?.cls.includes('failed'), `pending row: ${has}; ${JSON.stringify(info)}; warning modal: ${modal}`);
  const t0 = Date.now();
  await ctxA.setOffline(false);
  const ok = await waitTrue(async () => (await A.locator('.message-group:not(.pending) img.gallery-image').count()) > 0, 20000, 200);
  const pendLeft = await A.locator('.message-group.pending').count();
  let reason = '';
  if (!ok) reason = (await A.locator('.message-group .pending-status').allInnerTexts().catch(() => [])).join(' | ') || '(empty)';
  check(ok, `normal row with img.gallery-image: ${ok} after ${Date.now() - t0} ms; pending rows left ${pendLeft}${reason ? `; status "${reason}"` : ''}`);
  if (ok) check(true, `img src ${short(await A.locator('img.gallery-image').last().getAttribute('src'))}; B has image: ${await waitTrue(async () => (await B.locator('img.gallery-image').count()) > 0, 5000)}`);
  await sleep(500);
  await A.screenshot({ path: SHOTS + '13-file-after-online.png' });
});

await step(11, 'Upload while the server cannot be reached stays pending (OF-08)', async (check) => {
  const DOWN = makePng(fixture('down.png'), [40, 200, 90], 1);
  const galleries = () => A.locator('.message-group:not(.pending) img.gallery-image').count();
  const before = await galleries();
  await ctxA.route('**/api/tus**', route => route.abort('connectionfailed'));   // the browser is online; the server is not reachable
  await sendFiles(A, DOWN);
  const r = A.locator('.message-group.pending').filter({ has: A.locator('.pending-thumb[title^="down.png"]') });
  const has = await waitTrue(async () => (await r.count()) === 1, 3000);
  await sleep(12000);   // tus retries four times, about nine seconds, before it reports
  const info = has ? await r.evaluate(e => ({ cls: e.className, status: e.querySelector('.pending-status')?.textContent ?? null, reason: e.querySelector('.pending-reason')?.textContent ?? null })) : null;
  check(has && !!info && !info.cls.includes('failed') && info.status !== 'Failed', `pending row after the attempts: ${has}; ${JSON.stringify(info)}`);
  await ctxA.unroute('**/api/tus**');
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a wake-up, as the hub's reconnect is one
  const t0 = Date.now();
  const ok = await waitTrue(async () => (await galleries()) > before, 20000, 200);
  check(ok, `sent after the server is back: ${ok} after ${Date.now() - t0} ms; pending rows left ${await A.locator('.message-group.pending').count()}; statuses ${JSON.stringify(await A.locator('.message-group .pending-status').allInnerTexts().catch(() => []))}`);
});

await step(12, 'A text stays pending while a proxy answers 502 for the server, and goes when the server is back (OF-08)', async (check) => {
  // The browser is online and the server restarts: the reverse proxy in front of it answers the POST with a 502.
  let down = true, tried = 0;
  const posts = /\/api\/(channels|dm)\/[^/]+\/messages$/;
  const handler = route => down && route.request().method() === 'POST' && ++tried ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.continue();
  await ctxA.route(posts, handler);
  await A.fill('.message-input', 'sent during the restart');
  await A.press('.message-input', 'Enter');
  const r = row(A, 'sent during the restart');
  const got = await waitTrue(() => tried > 0, 5000, 50);
  await sleep(500);   // time for the client to act on the answer
  const cls = (await r.count()) === 1 ? await r.getAttribute('class') : '';
  check(got && cls.includes('pending') && !cls.includes('failed'), `the POST got a 502: ${got}; the row is pending and not failed: "${cls}"`);
  down = false;
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a wake-up, as the hub's reconnect is one
  const sent = await waitTrue(async () => (await r.count()) === 1 && !(await r.getAttribute('class')).includes('pending'), 10000, 100);
  check(sent && tried === 1, `sent after the server is back: ${sent}; POSTs that got the 502: ${tried}`);
  await ctxA.unroute(posts, handler);
});

await step(13, 'New-version strip', async (check, notes) => {
  const cycle = async () => {
    const t0 = Date.now();
    await ctxA.setOffline(true);
    const down = await waitTrue(async () => !(await dotState(A)).hidden, 45000);
    const tDown = Date.now() - t0;
    await ctxA.setOffline(false);
    const up = await waitTrue(async () => (await dotState(A)).hidden, 15000);
    await sleep(1500);
    return `hub dropped ${down} (${tDown} ms), reconnected ${up}`;
  };
  await A.evaluate(() => { document.documentElement.dataset.build = 'other'; });
  const c1 = await cycle();
  let vis = await A.locator('#notice').isVisible();
  notes.push(`method 1 (dataset.build = 'other', then offline/online; ${c1}): #notice visible ${vis}`);
  if (!vis) {
    let seen = 0;
    await ctxA.route('**/api/bootstrap**', async route => {
      const res = await route.fetch(); const j = await res.json();
      if (j.config) { j.config.buildStamp = 'other-build'; seen++; }
      await route.fulfill({ response: res, json: j });
    });
    const c2 = await cycle();
    vis = await A.locator('#notice').isVisible();
    notes.push(`method 2 (route rewrites config.buildStamp of /api/bootstrap, then offline/online; ${c2}; rewritten responses ${seen}): #notice visible ${vis}`);
    if (!vis) {
      await A.reload(); await A.waitForSelector('.message-input', { timeout: 10000 }); await sleep(1000);
      vis = await A.locator('#notice').isVisible();
      notes.push(`method 3 (same route, page reload; rewritten responses ${seen}): #notice visible ${vis}`);
    }
    await ctxA.unroute('**/api/bootstrap**');
  }
  const text = (await A.locator('#notice .notice-text').innerText().catch(() => '')).trim();
  const btn = (await A.locator('#notice .notice-action').innerText().catch(() => '')).trim();
  check(vis && text.startsWith('You are awesome') && btn === 'Reload', `text "${text}", button "${btn}"`);
  const fits = await A.evaluate(() => document.querySelector('.chat-container').getBoundingClientRect().bottom <= innerHeight);
  const geo = await A.evaluate(() => ({ bottom: document.querySelector('.chat-container').getBoundingClientRect().bottom, h: innerHeight, strip: document.getElementById('notice').getBoundingClientRect().height }));
  check(fits, `chat-container bottom ${geo.bottom} <= innerHeight ${geo.h}: ${fits} (strip height ${geo.strip})`);
  await A.screenshot({ path: SHOTS + '14-notice.png' });
});

await step(14, 'Sign out without a connection does not sign out (AU-22)', async (check) => {
  await ctxA.setOffline(true);
  const off = await waitTrue(async () => (await st(A)).connection === 'offline', 10000, 100);
  await A.click('.status-button');
  await A.locator('.status-dropdown [data-action="signout"]').click();
  await acceptDialogs(A);
  const reason = await waitTrue(async () => (await A.locator('.status-dropdown-container .row-reason').innerText().catch(() => '')) === 'Needs a connection', 3000, 50);
  await sleep(500);
  const s = await st(A);
  check(off && reason && s.user === 'boss' && (await A.locator('.page-login').count()) === 0, `offline ${off}; "Needs a connection" shown ${reason}; still signed in as ${s.user}; login page ${await A.locator('.page-login').count()}`);
  await ctxA.setOffline(false);
  const back = await waitTrue(async () => (await st(A)).connection === 'connected', 15000, 100);
  await A.reload(); await A.waitForSelector('.message-input', { timeout: 10000 });
  check(back && (await st(A)).user === 'boss', `after the network returns and a reload: user ${(await st(A)).user}`);
});

await step(15, 'Sign out clears IndexedDB', async (check) => {
  await A.click('.status-button');
  await A.locator('.status-dropdown [data-action="signout"]').click();
  await acceptDialogs(A);
  const ok = await waitTrue(async () => (await A.locator('.page-login').count()) === 1, 5000);
  check(ok, `login page: ${ok}, path ${new URL(A.url()).pathname}; dialogs ${JSON.stringify(stepLogs(14, 'A').filter(l => l.kind === 'dialog').map(l => l.text))}`);
  await sleep(500);
  const dbs = await A.evaluate(() => indexedDB.databases ? indexedDB.databases().then(l => l.map(d => `${d.name}@${d.version}`)) : 'n/a');
  const n = await A.evaluate(() => new Promise(r => {
    const q = indexedDB.open('yap');
    q.onerror = () => r('open error');
    q.onsuccess = () => {
      const db = q.result;
      try {
        const tx = db.transaction(['outbox', 'snapshots'], 'readonly'); let n = 0;
        tx.objectStore('outbox').count().onsuccess = e => n += e.target.result;
        tx.objectStore('snapshots').count().onsuccess = e => n += e.target.result;
        tx.oncomplete = () => r(n);
      } catch (e) { r(`no stores (${[...db.objectStoreNames].join(',')}): ${e.name}`); }
    };
  }));
  check(n === 0, `databases before the check: ${JSON.stringify(dbs)}; outbox+snapshots count: ${n}`);
  const errs = stepLogs(14, 'A').filter(l => l.kind === 'pageerror');
  check(errs.length === 0, `page errors during sign-out: ${errs.length ? fmt(errs) : 'none'}`);
});

await finish(browser, server);
