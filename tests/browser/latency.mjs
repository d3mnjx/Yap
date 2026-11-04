// AD-26 end to end: the waits a person feels reach the admin's latency table. One person, one tab: a reload
// (start), a tap on a room (open), the older page (older), a text send (send and post), a tap on a pin that is not
// loaded (jump), an offline/online pair (reconnect). Then the Diagnostics tab. Run from tests/browser: node latency.mjs -- --port=5098

import { chromium } from 'playwright';
import { BASE, SHOTS, sleep, waitTrue, step, finish, startServer, signIn, watchContext, watchPage } from './lib.mjs';

const server = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); watchContext(ctx, 'A');
const A = await ctx.newPage(); watchPage(A, 'A');

const rows = () => A.locator('.message-group').count();

await step(1, 'Sign in, history, reload, a room tap, older, send, reconnect', async (check) => {
  await signIn(A, 'boss');

  // History for the older page: 120 generated messages in the lobby, through the Debug tab.
  await A.goto(BASE + '/admin');
  const debugTab = A.locator('.page-admin .nav-item[data-tab="debug"]');
  const adminUp = await waitTrue(async () => (await debugTab.count()) > 0, 10000, 100);
  check(adminUp, `admin page up: ${adminUp}, path ${new URL(A.url()).pathname}`);
  if (!adminUp) await A.screenshot({ path: SHOTS + '99-fail-admin.png' });
  await debugTab.click();
  await A.fill('.page-admin .debug-form input[type=number]', '120');
  await A.locator('.page-admin .generate-btn').click();
  const gen = await waitTrue(async () => ((await A.locator('.page-admin .debug-result').textContent()) ?? '').startsWith('Generated'), 10000, 100);
  check(gen, `generator: "${await A.locator('.page-admin .debug-result').textContent()}"`);

  // A load that lands on a conversation: the first page of the load is the room, so 'start' is measured.
  await A.goto(BASE + '/lobby');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  await waitTrue(async () => (await rows()) > 0, 5000, 100);

  // A tap on a room from another page (the New Channel page; the fixture has one room): a mount, and with it
  // an 'open' sample. A tap on the room that is already open does not navigate, so it measures nothing.
  await A.locator('.users-sidebar .rooms-list .room-item.add-room').click();
  const left = await waitTrue(async () => new URL(A.url()).pathname !== '/lobby', 3000, 50);
  await A.locator('.users-sidebar .rooms-list .room-item:not(.add-room)').first().click();
  const back = await waitTrue(async () => new URL(A.url()).pathname === '/lobby', 3000, 50);
  check(left && back, `left the lobby: ${left}, back by a tap: ${back}`);
  await waitTrue(async () => (await rows()) > 5, 5000, 100);

  // Older: scroll to the top; the timeline asks for the page before the oldest row.
  const before = await rows();
  await A.evaluate(() => { const l = document.querySelector('.messages'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); });
  const older = await waitTrue(async () => (await rows()) > before, 5000, 100);
  check(older, `older rows: ${before} -> ${await rows()}`);

  // Send: text only, so the sample measures the wire and not an upload.
  await A.fill('.message-input', 'latency check');
  await A.press('.message-input', 'Enter');
  const sent = await waitTrue(async () => (await A.locator('.message-content', { hasText: 'latency check' }).count()) > 0, 5000, 100);
  check(sent, 'own message rendered');

  // Jump: a pin of the oldest message, which no page loaded, comes in a window around it (TL-41).
  const pinned = await A.evaluate(async () => {
    const hub = await import('/js/hub.js'), { state } = await import('/js/store.js');
    const id = state.open.channelId;
    let oldest = state.open.messages[0], more = state.open.hasMore;
    while (more) { const p = await hub.invoke('older', id, oldest.timestamp, oldest.id); if (!p.messages?.length) break; oldest = p.messages[0]; more = p.hasMore; }
    return !state.open.messages.some(m => m.id === oldest.id) && (await hub.invoke('pin', id, oldest.id)) == null;
  });
  await A.locator('.pins-button').click();
  await A.locator('.pin-entry .pin-time').first().click();
  const jumped = await waitTrue(async () => (await A.locator('.highlight-message').count()) > 0, 5000, 50);
  check(pinned && jumped, `the oldest message pinned, not loaded: ${pinned}; highlighted in its window: ${jumped}`);

  // Reconnect: the offline event closes the connection; navigator.onLine stays true, so the retry loop reconnects
  // after its first 1 s delay, and the online event finds the connection already up.
  await A.evaluate(() => window.dispatchEvent(new Event('offline')));
  await sleep(1500);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(3000);
});

await step(2, 'The samples reach the server, per person and per connection', async (check) => {
  // The queued samples ride the next beat (10 s); the round trip of a beat rides the beat after it.
  const diagnostics = () => A.evaluate(() => fetch('/api/admin/diagnostics').then(r => r.json()));
  let d;
  const got = await waitTrue(async () => { d = await diagnostics(); const s = d.users.find(u => u.username === 'boss')?.latency?.stats ?? {}; return 'rtt' in s && 'reconnect' in s; }, 45_000, 2000);
  check(got, 'a beat with the round trip and the queued samples arrived within 45 s');
  const me = d.users.find(u => u.username === 'boss');
  check(!!me, `users with samples: ${JSON.stringify(d.users.map(u => u.username))}`);
  const stats = me?.latency?.stats ?? {};
  for (const name of ['rtt', 'send', 'post', 'open', 'older', 'jump', 'start', 'reconnect']) check(name in stats, `${name}: ${JSON.stringify(stats[name] ?? null)}`);
  const conn = d.sessions.find(s => s.username === 'boss' && s.connected);
  const keys = Object.keys(conn?.latency?.stats ?? {});
  check(!!conn && keys.includes('rtt') && !keys.includes('post'), `live connection stats: ${JSON.stringify(keys)}; userId ${conn?.userId}`);
});

await step(3, 'The Diagnostics tab shows the table per person', async (check) => {
  await A.goto(BASE + '/admin');
  await A.locator('.page-admin .nav-item[data-tab="diagnostics"]').click();
  const card = A.locator('.page-admin .diag-chart-card', { hasText: 'Latency by user' });
  await card.waitFor({ timeout: 10000 });
  const headers = (await card.locator('thead th').allInnerTexts()).map(t => t.trim().toLowerCase());   // the CSS uppercases them
  check(headers.length === 11 && headers[0] === 'who' && headers.at(-1) === 'slow calls', `headers: ${JSON.stringify(headers)}`);
  const first = (await card.locator('tbody tr td:first-child').allInnerTexts()).map(t => t.trim());
  check(first[0] === 'boss', `first column: ${JSON.stringify(first)}`);
  check((await card.locator('tbody td.diag-indent').count()) >= 1, `connection rows: ${await card.locator('tbody td.diag-indent').count()}`);
  const cells = (await card.locator('tbody tr').first().locator('td').allInnerTexts()).map(t => t.trim());
  check(cells.slice(2, 10).every(c => c !== '—'), `boss row: ${JSON.stringify(cells)}`);
  const second = (await card.locator('tbody tr').nth(1).locator('td').allInnerTexts()).map(t => t.trim());
  check(second[4] === '—', `a connection row has no server send: ${JSON.stringify(second)}`);
  await card.screenshot({ path: SHOTS + '99-latency-by-user.png' });
});

await finish(browser, server);
