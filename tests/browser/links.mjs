// Message links (TL-43, TL-44, MR-84 to MR-86): the code of a message id, Copy Message Link in the More menu, a click
// on a link in a message, an opened address, the refusals, the sign-in on the way to a link, the label that a
// row shows in the place of the address, and a link in a pin and in a search result of a phone.
// Run: npm run links (see README.md).

import { chromium } from 'playwright';
import { BASE, SHOTS, sleep, waitTrue, row, step, finish, startServer, signIn, watchContext, watchPage, fixture, makePng, sendFiles, api } from './lib.mjs';

const RED = makePng(fixture('red.png'), [220, 30, 30]);
const KNOWN_ID = '3f2b8c1e-9a47-4d0b-b1c6-52e7a90d4f18', KNOWN_CODE = 'PyuMHppHTQuxxlLnqQ1PGA';

async function send(page, text) { await page.fill('.message-input', text); await page.press('.message-input', 'Enter'); }
const pathOf = page => new URL(page.url()).pathname;
const atPath = (page, path, ms = 5000) => waitTrue(() => pathOf(page) === path, ms, 50);
const rows = page => page.locator('.messages-container .message-group:not(.system-message)');
const lit = locator => waitTrue(async () => ((await locator.first().getAttribute('class').catch(() => '')) ?? '').includes('highlight-message'), 5000, 50);   // the highlight of a jump
const sentId = async (page, text) => {   // the id of a row that the server has: a pending row has an id of the device
  await waitTrue(async () => (await row(page, text).count()) === 1 && !(await row(page, text).getAttribute('class')).includes('pending'), 5000);
  return (await row(page, text).getAttribute('id')).slice('msg-'.length);
};
const codeOf = (page, id) => page.evaluate(async id => (await import('/js/message-links.js')).codeOf(id), id);
const post = (page, channelId, text) => api(page, 'POST', `/api/channels/${channelId}/messages`, { clientId: crypto.randomUUID(), text });
const noticeText = async page => {
  const shown = await waitTrue(async () => (await page.locator('.delete-confirm-overlay').count()) === 1, 5000, 50);
  return shown ? `${await page.locator('.delete-confirm-title').innerText()}: ${await page.locator('.delete-confirm-text').innerText()}` : '(no dialog)';
};

const server = await startServer();
const browser = await chromium.launch();
const context = async name => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctx, name); return ctx; };
const ctxA = await context('A'), ctxB = await context('B'), ctxC = await context('C');
await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });   // step 2 reads the copied address back
const A = await ctxA.newPage(); watchPage(A, 'A');
const B = await ctxB.newPage(); watchPage(B, 'B');
const C = await ctxC.newPage(); watchPage(C, 'C');
await signIn(A, 'boss'); await signIn(B, 'guest'); await signIn(C, 'third');

// Two rooms that every account reads from their first message: homelab for the linked messages, archive for a
// message that is not among the loaded rows. Pin stays with the admin (the default), so "third" may not pin.
for (const name of ['homelab', 'archive']) await api(A, 'POST', '/api/rooms', { name, description: null, adminOnly: false, historyLimit: 'unlimited', sinceJoined: false });
const roomIds = Object.fromEntries((await api(A, 'GET', '/api/bootstrap')).rooms.map(r => [r.isLobby ? 'lobby' : r.name, r.id]));
console.log(`setup: rooms ${JSON.stringify(Object.keys(roomIds))}`);
let backupId, backupLink, dmLink;

await step(1, 'The code of a message id, and which address is a message link', async (check) => {
  const r = await A.evaluate(async ([id, code]) => {
    const m = await import('/js/message-links.js');
    return {
      code: m.codeOf(id), back: m.idOf(code), short: m.idOf('too-short'), link: m.linkOf(id),
      own: m.messageIdOf(`${location.origin}/m/${code}`),
      other: m.messageIdOf(`https://other.example/m/${code}`),
      lookalike: m.messageIdOf(`${location.protocol}//${location.host}@other.example/m/${code}`),
      longer: m.messageIdOf(`${location.origin}/m/${code}/more`),
      room: m.messageIdOf(`${location.origin}/room/${id}`),
    };
  }, [KNOWN_ID, KNOWN_CODE]);
  check(r.code === KNOWN_CODE && r.back === KNOWN_ID && r.short === null, `code "${r.code}", back "${r.back}", a short text gives ${r.short}`);
  check(r.link === `${BASE}/m/${KNOWN_CODE}` && r.own === KNOWN_ID, `link "${r.link}"; this server's address gives the id: ${r.own === KNOWN_ID}`);
  check(r.other === null && r.lookalike === null && r.longer === null && r.room === null,
    `no message link: another server ${r.other}, this host before an @ ${r.lookalike}, a longer path ${r.longer}, a room address ${r.room}`);
});

await step(2, 'Copy Message Link in the More menu, and "Copied" after the two copy items (MR-54, MR-56, MR-84)', async (check) => {
  await A.goto(`${BASE}/room/${roomIds.homelab}`);
  await A.waitForSelector('.message-input', { timeout: 10000 });
  await send(A, 'the backup runs at 03:00');
  backupId = await sentId(A, 'the backup runs at 03:00');
  backupLink = `${BASE}/m/${await codeOf(A, backupId)}`;
  await row(A, 'the backup runs at 03:00').hover();
  await row(A, 'the backup runs at 03:00').locator('.action-more').click();
  const menu = A.locator('.more-menu');
  const items = (await menu.locator('.more-menu-item:visible').allInnerTexts()).map(s => s.trim());
  check(items.join(' | ') === 'Copy Text | Copy Message Link | Pin Message | Delete Message', `items: ${items.join(' | ')}`);
  await menu.locator('.more-menu-item', { hasText: 'Copy Message Link' }).click();
  const closed = await waitTrue(async () => (await A.locator('.more-menu').count()) === 0, 2000, 50);
  const said = () => waitTrue(async () => (await row(A, 'the backup runs at 03:00').locator('.row-reason').innerText().catch(() => '')) === 'Copied', 2000, 50);
  const saidLink = await said();
  const clip = await A.evaluate(() => navigator.clipboard.readText()).catch(e => `(read failed: ${e.message})`);
  check(closed && clip === backupLink && saidLink, `menu closed ${closed}; clipboard "${clip}" is the address of the message: ${clip === backupLink}; "Copied" at the row ${saidLink}`);

  // Copy Text says it too (MR-56). The first "Copied" goes away before the second click, so the check sees a new one.
  await waitTrue(async () => (await A.locator('.row-reason').count()) === 0, 4000, 100);
  await row(A, 'the backup runs at 03:00').hover();
  await row(A, 'the backup runs at 03:00').locator('.action-more').click();
  await A.locator('.more-menu .more-menu-item', { hasText: 'Copy Text' }).click();
  const saidText = await said();
  const clipText = await A.evaluate(() => navigator.clipboard.readText()).catch(e => `(read failed: ${e.message})`);
  check(saidText && clipText === 'the backup runs at 03:00', `Copy Text: clipboard "${clipText}"; "Copied" at the row ${saidText}`);
});

await step(3, 'A picture of someone else has More and the item for a reader who may not pin (MR-47)', async (check) => {
  await B.goto(`${BASE}/room/${roomIds.homelab}`);
  await C.goto(`${BASE}/room/${roomIds.homelab}`);
  await B.waitForSelector('.message-input', { timeout: 10000 });
  await C.waitForSelector('.message-input', { timeout: 10000 });
  await row(C, 'the backup runs at 03:00').waitFor({ timeout: 5000 });
  const before = await rows(C).count();
  await sendFiles(B, RED);
  const arrived = await waitTrue(async () => (await rows(C).count()) === before + 1, 10000);
  const picture = rows(C).last();
  await picture.hover();
  const more = picture.locator('.action-more');
  const shown = arrived && await more.isVisible();
  if (shown) await more.click();
  const items = shown ? (await C.locator('.more-menu .more-menu-item:visible').allInnerTexts()).map(s => s.trim()) : [];
  check(shown && items.join(' | ') === 'Copy Message Link', `the picture arrived ${arrived}; More shows ${shown}; items: ${items.join(' | ')}`);
  await C.keyboard.press('Escape');
});

await step(4, 'A click on a link in a message opens the other room in the same tab and jumps (MR-85, TL-43)', async (check) => {
  await B.goto(`${BASE}/lobby`);
  await B.waitForSelector('.message-input', { timeout: 10000 });
  await post(A, roomIds.lobby, `it is here: ${backupLink}`);
  const link = row(B, 'it is here').locator('a.message-link');
  await link.waitFor({ timeout: 5000 });
  await link.click();
  const moved = await atPath(B, `/room/${roomIds.homelab}`);
  const jumped = await lit(row(B, 'the backup runs at 03:00'));
  check(moved && jumped && ctxB.pages().length === 1, `path ${pathOf(B)}; the linked row has the highlight ${jumped}; tabs of the reader: ${ctxB.pages().length}`);
});

await step(5, 'A link to a message of the open room jumps and keeps the address (TL-43)', async (check) => {
  await post(A, roomIds.homelab, `again: ${backupLink}`);
  const link = row(B, 'again:').locator('a.message-link');
  await link.waitFor({ timeout: 5000 });
  await waitTrue(async () => !((await row(B, 'the backup runs at 03:00').getAttribute('class')) ?? '').includes('highlight-message'), 4000, 100);   // the highlight of step 4 is over
  await link.click();
  const jumped = await lit(row(B, 'the backup runs at 03:00'));
  check(jumped && pathOf(B) === `/room/${roomIds.homelab}` && ctxB.pages().length === 1, `the linked row has the highlight ${jumped}; path ${pathOf(B)}; tabs: ${ctxB.pages().length}`);
});

await step(6, 'A link to a direct message: a third person gets "Message not found.", the partner gets the message (TL-44)', async (check) => {
  await A.goto(`${BASE}/dm/guest`);
  await A.waitForSelector('.message-input', { timeout: 10000 });
  await send(A, 'the price is 40');
  dmLink = `${BASE}/m/${await codeOf(A, await sentId(A, 'the price is 40'))}`;
  await C.goto(`${BASE}/lobby`); await B.goto(`${BASE}/lobby`);
  await C.waitForSelector('.message-input', { timeout: 10000 });
  await B.waitForSelector('.message-input', { timeout: 10000 });
  await post(A, roomIds.lobby, `between two people: ${dmLink}`);

  const forThird = row(C, 'between two people').locator('a.message-link');
  await forThird.waitFor({ timeout: 5000 });
  await forThird.click();
  const reason = C.locator('.row-reason');
  const refused = await waitTrue(async () => (await reason.count()) === 1, 3000, 50);
  const text = refused ? await reason.innerText() : '';
  const outside = refused ? await reason.evaluate(e => !e.closest('a')) : false;
  check(refused && text === 'Message not found.' && outside && pathOf(C) === '/lobby' && ctxC.pages().length === 1,
    `the third person: reason "${text}", outside the link ${outside}, path ${pathOf(C)}, tabs ${ctxC.pages().length}`);

  const forPartner = row(B, 'between two people').locator('a.message-link');
  await forPartner.waitFor({ timeout: 5000 });
  await forPartner.click();
  const moved = await atPath(B, '/dm/boss');
  const jumped = await lit(row(B, 'the price is 40'));
  check(moved && jumped, `the partner: path ${pathOf(B)}; the linked row has the highlight ${jumped}`);
});

await step(7, 'An opened address shows a message that is not loaded, and Back does not return to the address (TL-43)', async (check) => {
  await api(A, 'POST', '/api/admin/generate', { channelId: roomIds.archive, count: 120, hours: 2 });
  await A.goto(`${BASE}/room/${roomIds.archive}`);
  await waitTrue(async () => (await rows(A).count()) >= 50, 10000);
  // A message from the page before the loaded rows: an open of the room does not bring it.
  const oldId = await A.evaluate(async () => {
    const { state } = await import('/js/store.js'), hub = await import('/js/hub.js');
    const first = state.open.messages[0];
    return (await hub.invoke('older', state.open.channelId, first.timestamp, first.id)).messages[0].id;
  });
  await C.goto(`${BASE}/lobby`);
  await C.waitForSelector('.message-input', { timeout: 10000 });
  await C.goto(`${BASE}/m/${await codeOf(A, oldId)}`);
  const moved = await atPath(C, `/room/${roomIds.archive}`, 10000);
  const jumped = await lit(C.locator(`[id="msg-${oldId}"]`));
  const window = (await C.locator('.newer-messages').count()) === 1;
  check(moved && jumped && window, `path ${pathOf(C)}; the linked row has the highlight ${jumped}; the rows are a window with an end row ${window}`);
  await C.goBack();
  const back = await atPath(C, '/lobby');
  check(back, `after Back: ${pathOf(C)}`);
});

await step(8, 'A wrong code and an unknown message open the lobby with a dialog (TL-44)', async (check) => {
  await C.goto(`${BASE}/m/not-a-code`);
  const wrong = await noticeText(C);
  check(wrong === 'Message link: Message not found.' && await atPath(C, '/lobby'), `a wrong code: dialog "${wrong}", path ${pathOf(C)}`);
  await C.locator('.confirm-ok').click();
  await C.goto(`${BASE}/m/${await codeOf(A, crypto.randomUUID())}`);
  const unknown = await noticeText(C);
  check(unknown === 'Message link: Message not found.' && await atPath(C, '/lobby'), `an unknown message: dialog "${unknown}", path ${pathOf(C)}`);
  await C.locator('.confirm-ok').click();
});

await step(9, 'A person who is not signed in signs in and gets the message (SH-42)', async (check) => {
  const ctxD = await context('D');
  const D = await ctxD.newPage(); watchPage(D, 'D');
  await D.goto(backupLink);
  // The sign-in of lib.mjs starts at '/', which would replace the address that the login page keeps for the return.
  await D.waitForSelector('.page-login .username-input', { timeout: 10000 });
  await D.fill('.username-input', 'late');
  await D.waitForSelector('.username-form .join-button:not([disabled])', { timeout: 5000 });
  await D.press('.username-input', 'Enter');
  const moved = await atPath(D, `/room/${roomIds.homelab}`, 10000);
  const jumped = await lit(row(D, 'the backup runs at 03:00'));
  check(moved && jumped, `path ${pathOf(D)}; the linked row has the highlight ${jumped}`);
  await ctxD.close();
});

// ---- the label (MR-86) ----

const label = (page, text) => row(page, text).locator('a.message-link-label');
// The questions about messages that the reader's page sends to the server, as the frames of its connection.
const asked = [];
const askedAbout = id => asked.filter(frame => frame.includes(id)).length;

await step(10, 'A link shows as a label for a reader who may read the message, and as the address for the others (MR-86)', async (check) => {
  await post(A, roomIds.lobby, `once more: ${backupLink}`);   // a second row with the same link
  B.on('websocket', ws => ws.on('framesent', f => { const text = String(f.payload); if (text.includes('"target":"messageLinks"')) asked.push(text); }));
  await B.goto(`${BASE}/lobby`);
  const shown = await waitTrue(async () => (await label(B, 'it is here').count()) === 1 && (await label(B, 'once more').count()) === 1, 10000, 50);
  const text = shown ? (await label(B, 'it is here').innerText()).trim() : '';
  const href = shown ? await label(B, 'it is here').getAttribute('href') : '';
  check(shown && text.startsWith('# homelab · boss · ') && href === backupLink, `the label of a room message: "${text}"; it keeps the address ${href === backupLink}`);
  check(askedAbout(backupId) === 1, `two rows with the same link make one question about it: ${askedAbout(backupId)}`);
  await B.screenshot({ path: SHOTS + 'links-label.png' });

  const dmShown = await waitTrue(async () => (await label(B, 'between two people').count()) === 1, 5000, 50);
  const dmText = dmShown ? (await label(B, 'between two people').innerText()).trim() : '';
  check(dmShown && dmText.startsWith('boss · ') && !dmText.includes('#'), `the label of a direct message for its partner: "${dmText}"`);

  // The third person may read the room and may not read the direct message.
  const roomLabel = await waitTrue(async () => (await label(C, 'it is here').count()) === 1, 10000, 50);
  const plain = row(C, 'between two people').locator('a.message-link');
  const plainText = (await plain.innerText()).trim(), plainClass = (await plain.getAttribute('class')) ?? '';
  check(roomLabel && plainText === dmLink && !plainClass.includes('message-link-label'),
    `the third person: the room link is a label ${roomLabel}; the direct message link stays the address ${plainText === dmLink}, class "${plainClass}"`);
});

await step(11, 'A reaction draws the row again, and the label stays with no second question (MR-86)', async (check) => {
  const target = row(B, 'it is here');
  await target.hover();
  await target.locator('.quick-reaction').first().click();
  const reacted = await waitTrue(async () => (await target.locator('.reaction-pill').count()) === 1, 5000, 50);
  await sleep(300);   // an answer of the server would have changed the label by now
  const kept = (await label(B, 'it is here').count()) === 1;
  check(reacted && kept && askedAbout(backupId) === 1, `the reaction shows ${reacted}; the label stays ${kept}; questions about the message: ${askedAbout(backupId)}`);
});

await step(12, 'An address with this host before an @ is a normal link with no label (MR-86)', async (check) => {
  const lookalike = `${new URL(BASE).protocol}//${new URL(BASE).host}@other.example/m/${KNOWN_CODE}`;
  await post(A, roomIds.lobby, `a trap: ${lookalike}`);
  const link = row(B, 'a trap').locator('a.message-link');
  await link.waitFor({ timeout: 5000 });
  await sleep(1000);   // the time in which a label would come
  const cls = (await link.getAttribute('class')) ?? '', text = (await link.innerText()).trim();
  check(!cls.includes('message-link-label') && text === lookalike && (await link.getAttribute('target')) === '_blank', `class "${cls}"; text is the address ${text === lookalike}; it opens a new tab as every other link`);
});

// ---- a link in a pin and in a search result (MR-85) ----
// Both cover the conversation on a phone. After a tap on a link to a message of the open conversation they give
// way, as after a tap on the pin or on the result.

await step(13, 'A link in a pin closes the pins panel and jumps (MR-85)', async (check) => {
  const note = await post(A, roomIds.homelab, `pinned note: ${backupLink}`);
  const pinned = await A.evaluate(async ([channelId, id]) => (await import('/js/hub.js')).invoke('pin', channelId, id), [roomIds.homelab, note.id]);
  await B.goto(`${BASE}/room/${roomIds.homelab}`);
  await B.locator('.pins-button').click();
  const panel = B.locator('.pins-panel');
  await panel.waitFor({ state: 'visible', timeout: 3000 });
  await B.locator('.pin-entry a.message-link').click();
  const closed = await waitTrue(async () => (await panel.count()) === 0, 3000, 50);
  const jumped = await lit(row(B, 'the backup runs at 03:00'));
  check(pinned == null && closed && jumped && ctxB.pages().length === 1, `pinned ${pinned == null}; the panel closed ${closed}; the linked row has the highlight ${jumped}; tabs: ${ctxB.pages().length}`);
});

await step(14, 'On a phone, a link in a search result shows the conversation at the message (MR-85)', async (check) => {
  const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watchContext(ctxN, 'narrow');
  const N = await ctxN.newPage(); watchPage(N, 'narrow');
  await signIn(N, 'thumb');
  await N.goto(`${BASE}/room/${roomIds.homelab}`);
  await N.waitForSelector('.message-input', { timeout: 10000 });
  await N.click('.users-toggle');
  await N.locator('.search-row').click();
  const screen = N.locator('.search-screen');
  await N.locator('.search-screen .search-input').fill('pinned note');
  const link = N.locator('.search-results .search-result').filter({ hasText: 'pinned note' }).locator('a.message-link');
  await link.waitFor({ timeout: 5000 });
  await link.tap();
  const away = await waitTrue(async () => ((await screen.getAttribute('class')) ?? '').includes('away'), 3000, 50);
  const jumped = await lit(row(N, 'the backup runs at 03:00'));
  const header = await N.locator('.search-at-result').isVisible();
  check(away && jumped && header && ctxN.pages().length === 1, `the results gave way ${away}; the linked row has the highlight ${jumped}; the search header shows ${header}; tabs: ${ctxN.pages().length}`);
  await ctxN.close();
});

await finish(browser, server);
