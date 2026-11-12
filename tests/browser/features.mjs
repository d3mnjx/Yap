// The feature run of the chat client: replies, link cards, the image gallery, emoji sizes and pack emoji,
// older pages and the top note, the New messages pill, typing in a DM, Shift+Enter, the keys on a GIF star, the
// emoji pick at the limit with Edit on a failed row, a rename of the open room, the media of a pin (the viewer over
// the pins panel, a video that plays in the entry), the jump to a row that is not loaded (the window, TL-41), and the
// message search above and under 768 px (search.md).
// Run: npm run features (see README.md). Screenshots go to shots/.

import { chromium } from 'playwright';
import { BASE, SHOTS, sleep, waitTrue, row, step, finish, startServer, signIn, watchContext, watchPage, fixture, makePng, sendFiles, api } from './lib.mjs';

const RED = makePng(fixture('red.png'), [220, 30, 30]);
const BLUE = makePng(fixture('blue.png'), [30, 60, 220]);

const lastRow = page => page.locator('.messages-container .message-group:not(.system-message)').last();
async function send(page, text) { await page.fill('.message-input', text); await page.press('.message-input', 'Enter'); }
const scroller = page => page.locator('.messages');
const scrollInfo = page => scroller(page).evaluate(e => ({ top: Math.round(e.scrollTop), h: e.scrollHeight, ch: e.clientHeight }));
const countRows = page => page.locator('.messages-container .message-group:not(.system-message)').count();

const server = await startServer();
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxA, 'A');
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxB, 'B');
const A = await ctxA.newPage(); watchPage(A, 'A');
const B = await ctxB.newPage(); watchPage(B, 'B');
await signIn(A, 'boss'); await signIn(B, 'guest');
console.log(`setup: A ${new URL(A.url()).pathname}, B ${new URL(B.url()).pathname}`);

await step(1, 'Reply', async (check) => {
  await send(B, 'original');
  await row(A, 'original').waitFor({ timeout: 5000 });
  await row(A, 'original').hover();
  await row(A, 'original').locator('.action-reply').click();
  const bar = A.locator('.reply-bar');
  const barTxt = (await bar.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const barVis = await bar.isVisible();
  const target = (await row(A, 'original').getAttribute('class')).includes('reply-target');
  const focus = await A.evaluate(() => document.activeElement?.classList.contains('message-input'));
  check(barVis && barTxt.includes('guest') && target && focus, `reply-bar visible ${barVis} "${barTxt}"; original reply-target ${target}; input focused ${focus}`);
  await A.keyboard.type('a reply');
  await A.keyboard.press('Enter');
  for (const [p, nm] of [[A, 'A'], [B, 'B']]) {
    const r = row(p, 'a reply');
    const ok = await waitTrue(async () => (await r.count()) === 1 && !(await r.getAttribute('class')).includes('pending'), 5000);
    const cls = ok ? await r.getAttribute('class') : '';
    const prev = ok ? (await r.locator('.reply-preview').innerText().catch(() => '')).replace(/\s+/g, ' ').trim() : '';
    check(ok && cls.includes('has-reply') && cls.includes('has-header') && prev.includes('original'), `${nm}: class "${cls}", reply-preview "${prev}"`);
  }
  check(!(await bar.isVisible()), `A reply-bar hidden after send: ${!(await bar.isVisible())}; reply-target left: ${await A.locator('.reply-target').count()}`);
  await row(B, 'a reply').locator('.reply-preview').click();
  const hl = await waitTrue(async () => (await row(B, 'original').getAttribute('class')).includes('highlight-message'), 1500, 50);
  check(hl, `B original gets highlight-message: ${hl}`);
  await B.screenshot({ path: SHOTS + '15-reply.png' });
});

await step(2, 'Link card', async (check) => {
  await send(A, 'look https://example.com/ now');
  const r = row(A, 'look');
  await r.waitFor({ timeout: 5000 });
  const a = r.locator('a.message-link[href="https://example.com/"]');
  const n = await a.count();
  const tgt = n ? await a.getAttribute('target') : null;
  check(n === 1 && tgt === '_blank', `a.message-link count ${n}, target ${tgt}, text "${n ? await a.innerText() : ''}"`);
  const card = await waitTrue(async () => (await r.locator('.link-preview-card').count()) > 0, 15000, 250);
  const cardTxt = card ? (await r.locator('.link-preview-card').innerText()).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  check(true, `link-preview-card within 15 s: ${card}${card ? ` "${cardTxt}"` : ''} (B: ${await row(B, 'look').locator('.link-preview-card').count()})`);
});

await step(3, 'Images through the tray, a caption, and the gallery (IB-33, MR-24)', async (check) => {
  const items = () => A.locator('.attachment-tray .tray-item').count();
  await A.setInputFiles('.message-input-container input[type=file]', [RED, BLUE]);
  const inTray = await waitTrue(async () => (await items()) === 2, 3000, 50);
  const sendShown = await waitTrue(async () => (await A.locator('.send-button').evaluate(b => b.getBoundingClientRect().width)) >= 40, 1000, 50);   // the collapse animates for 0.15 s
  await A.locator('.attachment-tray .tray-remove').last().click();
  const one = (await items()) === 1;
  await A.setInputFiles('.message-input-container input[type=file]', [BLUE]);
  const twoAgain = await waitTrue(async () => (await items()) === 2, 3000, 50);
  check(inTray && sendShown && one && twoAgain, `tray: 2 after the pick ${inTray}; Send visible over the empty draft ${sendShown}; 1 after ✕ ${one}; 2 after a second pick ${twoAgain}; pending rows ${await A.locator('.message-group.pending').count()}`);
  await A.fill('.message-input', 'two colours');
  await A.click('.send-button');
  const trayGone = await A.locator('.attachment-tray').isHidden();
  const gal = A.locator('.message-group:not(.pending) .image-gallery').filter({ has: A.locator('.gallery-item') }).last();
  const ok = await waitTrue(async () => (await A.locator('.message-group:not(.pending) .image-gallery').count()) > 0 && (await gal.locator('.gallery-item').count()) === 2, 20000, 200);
  let why = '';
  if (!ok) why = (await A.locator('.message-group .pending-status').allInnerTexts().catch(() => [])).join(' | ') + ` modal: ${await A.locator('.warning-modal').isVisible().catch(() => false)}`;
  const caption = ok ? (await A.locator('.message-group:not(.pending)').last().locator('.message-caption').innerText().catch(() => '')).trim() : '';
  const okB = ok && await waitTrue(async () => (await row(B, 'two colours').locator('.gallery-item').count()) === 2, 5000);
  check(ok && caption === 'two colours' && trayGone && okB, `gallery with 2 items: ${ok}${why ? ` (${why})` : ''}; caption "${caption}"; tray hidden after Send ${trayGone}; B shows the caption row with 2 images ${okB}`);
  if (!ok) return;
  await gal.locator('.gallery-image').first().click();
  const modal = A.locator('.image-modal');
  await modal.waitFor({ timeout: 3000 });
  const stages = await modal.locator('.modal-stage').count();
  const idx0 = (await modal.locator('.modal-counter-index').innerText()).trim();
  const tIdx = Date.now();
  await waitTrue(async () => (await modal.locator('.modal-counter-index').innerText()).trim() !== '', 1500, 20);
  check(true, `counter index right after the modal appears: "${idx0}"; filled after ${Date.now() - tIdx} ms`);
  const idx = (await modal.locator('.modal-counter-index').innerText()).trim(), tot = (await modal.locator('.modal-counter-total').innerText()).trim();
  check(stages === 2 && idx === '1' && tot === '2', `modal stages ${stages}, counter ${idx}/${tot}`);
  await sleep(400);
  await A.screenshot({ path: SHOTS + '16-gallery.png' });
  await A.keyboard.press('ArrowRight');
  const two = await waitTrue(async () => (await modal.locator('.modal-counter-index').innerText()).trim() === '2', 1500, 50);
  check(two, `ArrowRight -> index "${(await modal.locator('.modal-counter-index').innerText().catch(() => '')).trim()}"`);
  await A.keyboard.press('Escape');
  const gone = await waitTrue(async () => (await A.locator('.image-modal').count()) === 0 || !(await A.locator('.image-modal').isVisible()), 1000, 50);
  check(gone, `Escape closes the modal: ${gone}`);
});

await step(4, 'Emoji-only and mixed', async (check) => {
  await send(A, '😀😀');
  const r = A.locator('.messages-container .message-group').filter({ has: A.locator('.message-content.emoji-only') }).last();
  const ok = await waitTrue(async () => (await r.locator('img.emoji-big').count()) === 2, 5000);
  check(ok, `emoji-only row with 2 img.emoji-big: ${ok} (content class "${await lastRow(A).locator('.message-content').getAttribute('class')}", imgs ${JSON.stringify(await lastRow(A).locator('.message-content img').evaluateAll(e => e.map(i => i.className)))})`);
  await send(A, 'hi 😀');
  const r2 = row(A, 'hi');
  await r2.last().waitFor({ timeout: 5000 });
  const cls = await r2.last().locator('.message-content img').evaluateAll(e => e.map(i => i.className));
  const only = (await r2.last().locator('.message-content').getAttribute('class'));
  check(cls.includes('emoji emoji-text') && !only.includes('emoji-only'), `mixed: imgs ${JSON.stringify(cls)}, content class "${only}"`);
  // MR-15: a slot whose image arrived is .loaded and draws no glyph. An image that never arrives (U+1F000 is an astral
  // code point the set lacks, so its request fails) shows the device's own emoji after a second, over the hidden image,
  // and the slot keeps the text's line: its top is the text's top, as for the loaded one.
  const loaded = await waitTrue(async () => (await r2.last().locator('.emoji-slot.loaded img').count()) === 1, 5000);
  const noGlyph = await r2.last().locator('.emoji-slot').first().evaluate(s => getComputedStyle(s, '::before').content);
  check(loaded && noGlyph === 'none', `loaded slot: ${loaded}, glyph content ${noGlyph}`);
  await send(A, 'cold 🀀');
  const slot = row(A, 'cold').last().locator('.emoji-slot');
  await slot.waitFor({ timeout: 5000 });
  const shown = await waitTrue(() => slot.evaluate(s => getComputedStyle(s, '::before').visibility === 'visible' && getComputedStyle(s.firstChild).visibility === 'hidden'), 3000);
  check(shown && (await slot.getAttribute('data-glyph')) === '🀀', `glyph after a second: ${shown}, slot class "${await slot.getAttribute('class')}", data-glyph ${await slot.getAttribute('data-glyph')}`);
  const above = s => s.evaluate(s => { const text = document.createRange(); text.selectNode(s.previousSibling); return text.getBoundingClientRect().top - s.getBoundingClientRect().top; });
  const [cold, hi] = [await above(slot), await above(r2.last().locator('.emoji-slot').first())];
  check(Math.abs(cold - hi) < 0.5, `the failed image's slot keeps the line like a loaded one: above its text by ${cold} and ${hi}`);
});

await step(5, 'Pack emoji', async (check) => {
  const sc = await A.evaluate(() => fetch('/api/bootstrap').then(r => r.json()).then(d => d.emojiImages?.packs?.[0]?.emojis?.[0]?.shortcode ?? null));
  check(!!sc, `packs[0].emojis[0].shortcode = ${sc}`);
  if (!sc) return;
  await send(A, `:${sc}:`);
  const ok = await waitTrue(async () => (await lastRow(A).locator('img.emoji-custom').count()) > 0, 5000);
  const imgs = await lastRow(A).locator('.message-content img').evaluateAll(e => e.map(i => `${i.className} alt=${i.alt}`));
  const okB = await waitTrue(async () => (await lastRow(B).locator('img.emoji-custom').count()) > 0, 5000);
  check(ok, `A img.emoji-custom: ${ok} ${JSON.stringify(imgs)}; B: ${okB}`);
});

await step(6, 'Older messages', async (check, notes) => {
  const res = await A.evaluate(async () => {
    const id = await fetch('/api/bootstrap').then(r => r.json()).then(d => d.rooms[0].id);
    const r = await fetch('/api/admin/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: id, count: 120, hours: 2 }) });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  });
  check(res.status === 200, `generate: ${res.status} ${res.body}`);
  await B.goto(BASE + '/lobby');
  await B.waitForSelector('.message-input', { timeout: 10000 });
  await waitTrue(async () => (await countRows(B)) > 0, 5000);
  await sleep(1000);
  const n0 = await countRows(B);
  const s0 = await scrollInfo(B);
  check(n0 <= 50 && n0 > 0, `initial rows ${n0}; scroll ${JSON.stringify(s0)}; at bottom ${s0.h - s0.top - s0.ch < 5}`);
  let sawLoading = false;
  const watchLoading = async ms => { const end = Date.now() + ms; while (Date.now() < end) { if (await B.locator('.loading-older').count()) sawLoading = true; await sleep(20); } };
  await scroller(B).evaluate(e => { e.scrollTop = 0; });
  const p = watchLoading(1500);
  const more = await waitTrue(async () => (await countRows(B)) > n0, 5000, 50);
  await p;
  await sleep(300);
  const n1 = await countRows(B);
  const s1 = await scrollInfo(B);
  check(more && n1 > 50 && s1.top > 0, `after scroll to top: .loading-older seen ${sawLoading}; rows ${n1}; scrollTop ${s1.top} (> 0 means no jump to the top)`);
  let n = n1, pages = 1, start = false;
  for (let i = 0; i < 10 && !start; i++) {
    await scroller(B).evaluate(e => { e.scrollTop = 0; });
    await waitTrue(async () => (await countRows(B)) > n || (await B.locator('.history-start').count()) > 0, 5000, 50);
    await sleep(300);
    const m = await countRows(B);
    if (m > n) pages++;
    n = m;
    start = (await B.locator('.messages-top .history-start, .history-start').count()) > 0 && (await B.locator('.history-start').first().innerText()).includes('This is the beginning of #lobby');
  }
  const hs = (await B.locator('.history-start').allInnerTexts()).map(t => t.trim());
  check(start, `history-start reached: ${start} (${JSON.stringify(hs)}); total rows ${n}; older pages loaded ${pages}`);
});

await step(7, 'New messages pill', async (check) => {
  await scroller(B).evaluate(e => { e.scrollTop = 0; });
  await sleep(1000);
  const s0 = await scrollInfo(B);
  await send(A, 'pill test');
  const pill = B.locator('.new-messages-pill');
  const shown = await waitTrue(async () => (await pill.count()) > 0 && (await pill.isVisible()), 3000, 50);
  await sleep(300);
  const s1 = await scrollInfo(B);
  check(shown && Math.abs(s1.top - s0.top) <= 2, `pill shown: ${shown} ("${shown ? (await pill.innerText()).trim() : ''}"); scrollTop ${s0.top} -> ${s1.top}`);
  await B.screenshot({ path: SHOTS + '17-pill.png' });
  if (!shown) return;
  await pill.click();
  const bottom = await waitTrue(async () => { const s = await scrollInfo(B); return s.h - s.top - s.ch < 5; }, 3000, 50);
  const s2 = await scrollInfo(B);
  check(bottom && (await pill.count()) === 0, `after click: pill count ${await pill.count()}, distance to bottom ${s2.h - s2.top - s2.ch}`);
});

await step(8, 'Typing in a DM', async (check) => {
  await A.locator('.users-list .user-item', { hasText: 'guest' }).first().locator('.user-name').click();
  await waitTrue(async () => new URL(A.url()).pathname === '/dm/guest', 3000);
  await A.locator('.message-input').click();
  await A.locator('.message-input').pressSequentially('abc', { delay: 100 });
  await B.locator('.users-list .user-item', { hasText: 'boss' }).first().locator('.user-name').click();
  await waitTrue(async () => new URL(B.url()).pathname === '/dm/boss', 3000);
  await A.locator('.message-input').pressSequentially('def', { delay: 100 });
  const ti = B.locator('.typing-indicator');
  const ok = await waitTrue(async () => (await ti.isVisible()) && (await ti.innerText()).trim() === 'boss is typing...', 3000, 50);
  check(ok, `A ${new URL(A.url()).pathname}, B ${new URL(B.url()).pathname}; B indicator visible ${await ti.isVisible()}, text "${(await ti.innerText().catch(() => '')).trim()}"`);
  const t0 = Date.now();
  const gone = await waitTrue(async () => !(await ti.isVisible()), 10000, 100);
  check(gone, `case 1 (guest opened the DM while boss typed): indicator hidden after boss stops: ${gone} (${Date.now() - t0} ms after the last key)`);
  await A.fill('.message-input', '');
  await sleep(4000);
  await A.locator('.message-input').pressSequentially('ghi', { delay: 100 });
  const on2 = await waitTrue(async () => (await ti.isVisible()) && (await ti.innerText()).trim() === 'boss is typing...', 3000, 50);
  const t1 = Date.now();
  const gone2 = await waitTrue(async () => !(await ti.isVisible()), 10000, 100);
  check(on2 && gone2, `case 2 (both already in the DM, boss types again): shown ${on2}, hidden ${gone2} after ${Date.now() - t1} ms`);
  await A.fill('.message-input', '');
});

await step(9, 'Shift+Enter', async (check) => {
  await A.locator('.message-input').click();
  await A.keyboard.type('line1');
  await A.keyboard.press('Shift+Enter');
  await A.keyboard.type('line2');
  await A.keyboard.press('Enter');
  const r = row(A, 'line1');
  await waitTrue(async () => (await r.count()) === 1 && !(await r.getAttribute('class')).includes('pending'), 5000);
  const info = await r.locator('.message-content').evaluate(e => ({ text: e.textContent, inner: e.innerText, br: e.querySelectorAll('br').length, ws: getComputedStyle(e).whiteSpace }));
  const okB = await waitTrue(async () => (await row(B, 'line1').count()) === 1, 5000);
  check(/line1\nline2/.test(info.textContent ?? info.text), `textContent ${JSON.stringify(info.text)}, innerText ${JSON.stringify(info.inner)}, <br> ${info.br}, white-space ${info.ws}; B has row ${okB}`);
});

await step(10, 'Two GIF files in one pick become one message with two GIFs (IB-33)', async (check) => {
  await sendFiles(A, [
    { name: 'one.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') },
    { name: 'two.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAAD/AP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }]);
  const sent = await waitTrue(async () => (await A.locator('.message-group:not(.pending) .gif-message-gallery').count()) > 0, 20000, 200);
  const counts = await A.evaluate(async () => (await import('/js/store.js')).state.open.messages.filter(m => m.gifs.length).map(m => m.gifs.length));
  const dom = await A.locator('.message-group:not(.pending) .gif-message-gallery').last().locator('.gif-message').count();
  check(sent && counts.at(-1) === 2 && dom === 2, `message with GIFs ${sent}; GIF counts per message ${JSON.stringify(counts)}; GIFs in the last gallery ${dom}; pending rows left ${await A.locator('.message-group.pending').count()}; statuses ${JSON.stringify(await A.locator('.message-group .pending-status').allInnerTexts().catch(() => []))}`);
  const okB = await waitTrue(async () => (await B.locator('.gif-message-gallery').last().locator('.gif-message').count()) === 2, 5000);
  check(okB, `B shows two GIFs in one row: ${okB}`);
});

await step(11, 'Chosen Away stops the automatic read (NT-07, PR-24)', async (check) => {
  const unread = () => A.evaluate(async () => { const s = (await import('/js/store.js')).state; return s.unread[s.open.channelId] ?? 0; });
  await A.click('.status-button'); await A.locator('.status-dropdown [data-status="away"]').click();
  const away = await waitTrue(async () => (await A.locator('.status-button').getAttribute('class')).includes('status-away'), 3000);
  await send(B, 'while you are away');
  await row(A, 'while you are away').waitFor({ timeout: 5000 });
  await sleep(1000);
  const whileAway = await unread();
  check(away && whileAway === 1, `A Away ${away}; unread count of the open DM after B's message: ${whileAway}`);
  await A.click('.status-button'); await A.locator('.status-dropdown [data-status="online"]').click();
  const cleared = await waitTrue(async () => (await unread()) === 0, 3000, 100);
  check(cleared, `back Online: unread ${await unread()} (the three conditions hold again)`);
});

await step(12, 'Enter and Space on a GIF favourite star change the favourite only; on the card they send (PK-21)', async (check) => {
  const gifs = () => B.locator('.gif-message').count();
  const star = () => A.locator('.gif-card .gif-fav-btn').first();
  const favorited = () => star().evaluate(e => e.classList.contains('favorited'));
  await A.click('.gif-toggle-button');
  await A.locator('.gif-sidebar [data-tab="recent"]').click();
  await A.locator('.gif-card').first().waitFor({ timeout: 5000 });
  await sleep(700);   // the tab's refresh replaces its cards
  // The focus goes to the card and then, with Tab, to its star; a key on the star must not reach the card.
  const pressOnStar = async key => {
    await A.locator('.gif-card').first().focus(); await A.keyboard.press('Tab');
    const focused = await A.evaluate(() => document.activeElement.className);
    await A.keyboard.press(key); await sleep(600);
    return focused;
  };
  const before = await gifs(), fav0 = await favorited();
  const f1 = await pressOnStar('Enter'); const fav1 = await favorited(), after1 = await gifs();
  const f2 = await pressOnStar('Space'); const fav2 = await favorited(), after2 = await gifs();
  const stillOpen = await A.locator('.gif-card').count();
  check(f1.includes('gif-fav-btn') && f2.includes('gif-fav-btn') && fav1 !== fav0 && fav2 === fav0 && after1 === before && after2 === before && stillOpen > 0,
    `focused "${f1}" / "${f2}"; favourite ${fav0} -> Enter ${fav1} -> Space ${fav2}; B GIFs ${before} -> ${after1} -> ${after2}; picker still open ${stillOpen > 0}`);
  await A.locator('.gif-card').first().focus();
  await A.keyboard.press('Enter');
  const sent = await waitTrue(async () => (await gifs()) === before + 1, 5000);
  check(sent, `Enter on the card itself sends: B GIFs ${await gifs()} (was ${before})`);
});

await step(13, 'An emoji pick stops at the limit; a failed row offers Edit and sends the corrected text (IB-14, MR-72)', async (check) => {
  for (const p of [A, B]) { await p.evaluate(async () => (await import('/js/router.js')).navigate('/lobby')); await p.waitForSelector('.message-input', { timeout: 5000 }); }   // both in the lobby: step 11 left them in a DM
  await sleep(300);
  await A.fill('.message-input', 'a'.repeat(4000));
  await A.click('.emoji-toggle-button');
  const cell = A.locator('[data-picker-pane="emoji"] .emoji-btn').first();
  await cell.waitFor({ timeout: 5000 });
  await cell.click();
  const len = (await A.inputValue('.message-input')).length;
  await A.keyboard.press('Escape');
  check(len === 4000, `draft length after the pick at the limit: ${len}`);
  await A.fill('.message-input', '');
  // A row the server refuses: the client never lets 4001 characters through, so the sender is used directly.
  await A.evaluate(async () => { const { state } = await import('/js/store.js'); (await import('/js/sender.js')).queueMessage({ channelId: state.open.channelId, partner: state.open.partner ?? null, text: 'x'.repeat(4001) }); });
  const failed = A.locator('.message-group.failed').last();
  const gotFailed = await waitTrue(async () => (await A.locator('.message-group.failed').count()) > 0, 8000);
  const reason = gotFailed ? (await failed.locator('.pending-reason').innerText()).trim() : '';
  if (gotFailed) await failed.hover();
  const hasEdit = gotFailed && (await failed.locator('.action-edit').count()) === 1;
  const dump = gotFailed ? '' : JSON.stringify(await A.evaluate(async () => {
    const { state } = await import('/js/store.js'); const disk = await (await import('/js/offline/outbox.js')).loadAll();
    return { open: state.open?.channelId, partner: state.open?.partner, pending: state.pending.map(r => ({ failed: r.failed, len: r.text?.length, ch: r.channelId })), disk: disk.map(r => ({ failed: r.failed, len: r.text?.length, ch: r.channelId })), dom: { pending: document.querySelectorAll('.message-group.pending').length, failed: document.querySelectorAll('.message-group.failed').length } };
  }));
  check(gotFailed && hasEdit, `failed row ${gotFailed} ("${reason}"); Edit in its bar ${hasEdit} ${dump}`);
  if (!hasEdit) return;
  await failed.locator('.action-edit').click();
  await A.fill('.message-group.failed .edit-input', 'corrected after a failure');
  await A.press('.message-group.failed .edit-input', 'Enter');
  const okB = await waitTrue(async () => (await row(B, 'corrected after a failure').count()) > 0, 5000);
  const left = await A.locator('.message-group.failed').count();
  check(okB && left === 0, `B has the corrected text ${okB}; failed rows left on A ${left}`);
});

await step(14, 'A rename of the open room reaches the header and the tab title (SH-05, SH-45)', async (check) => {
  const header = p => p.locator('.chat-header .header-title h3').first().innerText().then(t => t.trim()).catch(() => '');
  const pathOf = p => new URL(p.url()).pathname;
  await A.locator('.room-item.add-room').click();
  await A.fill('#channel-name', 'oldname');
  await A.locator('.page-channel .save-button').click();
  const created = await waitTrue(async () => /^\/room\/[0-9a-f-]{36}$/.test(pathOf(A)), 5000);
  const id = pathOf(A).split('/')[2];
  await B.goto(`${BASE}/room/${id}`);
  await B.waitForSelector('.messages-container', { timeout: 10000 });
  const h0 = await header(B), t0 = await B.title();
  check(created && h0.includes('oldname') && t0.endsWith('#oldname'), `room ${id}; B header "${h0}", title "${t0}"`);
  const rowA = A.locator('.rooms-list .room-item', { hasText: 'oldname' });
  await rowA.hover(); await rowA.locator('.room-settings').click();
  await A.waitForSelector('#channel-name', { timeout: 3000 });
  await A.fill('#channel-name', 'newname');
  await A.locator('.page-channel .save-button').click();
  const back = await waitTrue(async () => pathOf(A) === `/room/${id}`, 5000);
  const okB = await waitTrue(async () => (await header(B)).includes('newname') && (await B.title()).endsWith('#newname'), 3000);
  const okA = await waitTrue(async () => (await header(A)).includes('newname') && (await A.title()).endsWith('#newname'), 3000);
  check(back && okB && okA, `A back at the room ${back}; B header "${await header(B)}", title "${await B.title()}"; A header "${await header(A)}", title "${await A.title()}"`);
});

await step(15, 'A pin opens its pictures in the viewer over the panel and plays its video in place (SH-48, SH-49, TL-22, TL-29)', async (check) => {
  await A.goto(BASE + '/lobby');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  // The store and the hub of the page itself (the same module instances): the ids, and a pin without the row menu.
  const ids = () => A.evaluate(async () => { const s = (await import('/js/store.js')).state; return { channelId: s.open.channelId, ...Object.fromEntries(s.open.messages.filter(m => !m.pending).map(m => [m.text, m.id])) }; });
  const invoke = (...args) => A.evaluate(async args => (await import('/js/hub.js')).invoke(...args), args);
  await A.setInputFiles('.message-input-container input[type=file]', [RED, BLUE]);
  await A.fill('.message-input', 'pin album');
  await A.click('.send-button');
  const { channelId } = await ids();
  await api(A, 'POST', `/api/channels/${channelId}/messages`, { clientId: crypto.randomUUID(), text: 'pin video', videos: ['/uploads/pin-video.mp4'] });   // no file behind it: the player and its tap are the point
  const sent = await waitTrue(async () => { const m = await ids(); return !!m['pin album'] && !!m['pin video']; }, 20000, 200);
  const m = await ids();
  const pinned = sent && (await invoke('pin', channelId, m['pin album'])) == null && (await invoke('pin', channelId, m['pin video'])) == null;
  check(pinned, `both messages sent ${sent}; both pinned ${pinned}`);
  if (!pinned) return;

  const panel = A.locator('.pins-panel'), modal = A.locator('.image-modal');
  const openPanel = async () => { await A.locator('.pins-button').click(); await panel.waitFor({ state: 'visible', timeout: 3000 }); };
  const album = () => A.locator('.pin-entry').filter({ hasText: 'pin album' });
  await openPanel();
  const shots = await album().locator('button.pin-shot').count();
  await album().locator('button.pin-shot').nth(1).click();
  await modal.waitFor({ timeout: 3000 });
  const at = await waitTrue(async () => (await modal.locator('.modal-counter-index').innerText()).trim() === '2', 2000, 50);
  const stillOpen = await panel.isVisible();
  const download = await modal.locator('.modal-download').getAttribute('href');
  check(shots === 2 && at && stillOpen && /^\/uploads\//.test(download ?? ''), `pin entry picture buttons ${shots}; viewer at 2 / 2 ${at}; panel still open under it ${stillOpen}; Download "${download}"`);
  await modal.locator('.modal-close').click();
  const closeOnly = await waitTrue(async () => (await modal.count()) === 0, 2000, 50) && await panel.isVisible();
  await album().locator('button.pin-shot').first().click();
  await modal.waitFor({ timeout: 3000 });
  await A.keyboard.press('Escape');
  const escViewer = await waitTrue(async () => (await modal.count()) === 0, 2000, 50) && await panel.isVisible();
  await A.keyboard.press('Escape');
  const escPanel = await waitTrue(async () => (await panel.count()) === 0, 2000, 50);
  check(closeOnly && escViewer && escPanel, `the viewer's × closes the viewer only ${closeOnly}; Escape closes the viewer first ${escViewer}, then the panel ${escPanel}`);

  await openPanel();
  const videoEntry = A.locator('.pin-entry').filter({ hasText: 'pin video' });
  const inGrid = await A.locator('.pin-entry .pin-cell .video-container').count();
  await videoEntry.locator('.video-play-overlay').click();
  // The controls, not the overlay: with no file the play fails, and the row's player shows its overlay again (MR-27).
  const playing = await videoEntry.locator('video.video-player').evaluate(v => v.controls);
  check(inGrid === 0 && playing && await panel.isVisible(), `no video in a grid cell ${inGrid === 0}; a tap on the video starts the row's player (controls ${playing}), and the panel stays`);

  await album().locator('button.pin-shot').first().click();
  await modal.waitFor({ timeout: 3000 });
  const unpinned = (await invoke('unpin', channelId, m['pin album'])) == null;   // as if another device: the 'pins' event closes the viewer
  const viewerGone = await waitTrue(async () => (await modal.count()) === 0, 3000, 50);
  check(unpinned && viewerGone && await panel.isVisible(), `unpin while the viewer is open ${unpinned}: the viewer closes ${viewerGone}, the panel stays with the other pin`);

  await videoEntry.locator('.pin-time').click();
  const jumped = await waitTrue(async () => (await panel.count()) === 0, 5000, 50);
  check(jumped, `a tap on the header jumps, and the panel closes ${jumped}`);
  await invoke('unpin', channelId, m['pin video']);
});

await step(16, 'A jump to a row that is not loaded shows a window around it; the pill, the end row, the arrow, a send and a reconnect lead back (SH-49, MR-34, TL-41, TL-42, OF-08)', async (check) => {
  await A.goto(BASE + '/lobby');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const channelId = await A.evaluate(async () => (await import('/js/store.js')).state.open.channelId);
  const invoke = (...args) => A.evaluate(async args => (await import('/js/hub.js')).invoke(...args), args);
  const post = (text, extra = {}) => api(B, 'POST', `/api/channels/${channelId}/messages`, { clientId: crypto.randomUUID(), text, ...extra });
  // Three digits: "ws-5" would also match the rows "ws-50" and "ws-150"
  const ids = [];
  for (let i = 0; i < 150; i++) ids.push((await post(`ws-${String(i).padStart(3, '0')}`)).id);
  check((await invoke('pin', channelId, ids[50])) == null, 'ws-050 pinned');
  // A took all 150 live: a fresh open leaves the newest 50, and ws-050 is not loaded.
  await A.goto(BASE + '/lobby');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const fresh = await waitTrue(() => A.evaluate(async () => { const s = (await import('/js/store.js')).state; return s.connection === 'connected' && !s.open?.fromDevice && !s.open?.loading; }), 10000, 100);
  check(fresh && (await row(A, 'ws-149').count()) === 1 && (await row(A, 'ws-050').count()) === 0, `a fresh open ${fresh}: ws-149 loaded, ws-050 not`);

  // The hub methods page A calls, by name: SignalR's JSON frames go through the socket's send.
  await A.evaluate(() => {
    window.__calls = {};
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') for (const f of data.split('\x1e')) {
        const t = /"target":"(\w+)"/.exec(f)?.[1]?.toLowerCase();
        if (t) window.__calls[t] = (window.__calls[t] ?? 0) + 1;
      }
      return send.call(this, data);
    };
  });
  const calls = () => A.evaluate(() => { const c = window.__calls; window.__calls = {}; return c; });
  const panel = A.locator('.pins-panel'), pill = A.locator('.new-messages-pill'), arrow = A.locator('.down-arrow');
  const end = A.locator('.newer-messages'), goNewest = A.locator('.newer-messages-button');
  const atBottom = async () => { const s = await scrollInfo(A); return s.h - s.top - s.ch < 5; };
  const lit = text => waitTrue(async () => ((await row(A, text).first().getAttribute('class').catch(() => '')) ?? '').includes('highlight-message'), 3000, 50);
  const centred = text => row(A, text).evaluate(n => {
    const l = n.closest('.messages').getBoundingClientRect(), r = n.getBoundingClientRect();
    return Math.round((r.top + r.bottom) / 2 - (l.top + l.bottom) / 2);
  });
  const openPanel = async () => { await A.locator('.pins-button').click(); await panel.waitFor({ state: 'visible', timeout: 3000 }); };
  const jumpToPin = async text => { await openPanel(); await A.locator('.pin-entry').filter({ hasText: text }).locator('.pin-time').click(); };
  const connection = () => A.evaluate(async () => (await import('/js/store.js')).state.connection);

  // 1. The window: one around call, the target in the middle, the end row under the window's last row (TL-42).
  await calls();
  await jumpToPin('ws-050');
  const closed = await waitTrue(async () => (await panel.count()) === 0, 5000, 50);
  const hl = await lit('ws-050');
  const off = await centred('ws-050');
  const c1 = await calls();
  const edges = { first: await row(A, 'ws-074').count(), after: await row(A, 'ws-075').count(), newest: await row(A, 'ws-149').count() };
  const endShown = (await end.count()) === 1 && await end.evaluate(n => n.previousElementSibling?.textContent.includes('ws-074'));
  check(closed && hl && Math.abs(off) <= 40 && c1.around === 1 && !c1.older && edges.first === 1 && edges.after === 0 && edges.newest === 0 && endShown,
    `panel closed ${closed}; highlighted ${hl}; ${off} px from the middle; calls ${JSON.stringify(c1)}; ws-074 ${edges.first}, ws-075 ${edges.after}, ws-149 ${edges.newest}; end row under ws-074 ${endShown}`);
  await A.screenshot({ path: SHOTS + '16-window.png' });

  // 2. An older page goes above the window as usual (TL-06).
  const n2 = await countRows(A);
  await scroller(A).evaluate(e => { e.scrollTop = 0; });
  const more = await waitTrue(async () => (await countRows(A)) > n2, 5000, 50);
  const c2 = await calls();
  check(more && c2.older >= 1 && (await row(A, 'ws-050').count()) === 1, `rows ${n2} -> ${await countRows(A)}; calls ${JSON.stringify(c2)}`);

  // 3. A message from B: the pill, and no row under the window.
  await post('ws-live-1');
  const pillShown = await waitTrue(async () => (await pill.count()) === 1, 3000, 50);
  await sleep(200);
  check(pillShown && (await row(A, 'ws-live-1').count()) === 0 && (await arrow.count()) === 0, `pill ${pillShown}; row ws-live-1 ${await row(A, 'ws-live-1').count()}; arrow ${await arrow.count()} (the pill wins)`);

  // 4. The pill opens the conversation again: the newest rows at the bottom, the follow on.
  await calls();
  await pill.click();
  const back = await waitTrue(async () => (await row(A, 'ws-live-1').count()) === 1 && await atBottom(), 5000, 50);
  const c4 = await calls();
  const last4 = (await lastRow(A).locator('.message-content').innerText()).trim();
  await post('ws-live-2');
  const followed = await waitTrue(async () => (await row(A, 'ws-live-2').count()) === 1 && await atBottom(), 3000, 50) && (await pill.count()) === 0;
  check(back && c4.openroom === 1 && last4 === 'ws-live-1' && (await row(A, 'ws-050').count()) === 0 && (await end.count()) === 0 && followed,
    `at the bottom ${back}; calls ${JSON.stringify(c4)}; last row "${last4}"; window rows gone ${(await row(A, 'ws-050').count()) === 0}; end row gone ${(await end.count()) === 0}; the next message follows ${followed}`);

  // 5. A send in a window goes to the newest messages first (TL-14).
  await jumpToPin('ws-050');
  await lit('ws-050');
  await calls();
  await send(A, 'ws-own-send');
  const sentBack = await waitTrue(async () => (await row(A, 'ws-own-send').count()) === 1 && !((await row(A, 'ws-own-send').getAttribute('class')) ?? '').includes('pending') && await atBottom(), 5000, 50);
  const c5 = await calls();
  check(sentBack && c5.openroom === 1 && (await row(A, 'ws-050').count()) === 0, `own message at the bottom ${sentBack}; calls ${JSON.stringify(c5)}`);

  // 6. Offline in a window: Go to newest names the reason, a send shows its pending row under the window at once
  // (OF-08), and the reconnect goes to the newest messages, the message sent (TL-35).
  await jumpToPin('ws-050');
  await lit('ws-050');
  await ctxA.setOffline(true);
  const wentOff = await waitTrue(async () => (await connection()) === 'offline', 5000, 50);
  await goNewest.click();
  const newestReason = await waitTrue(async () => (await A.locator('.row-reason').filter({ hasText: 'Needs a connection' }).count()) === 1, 2000, 50);
  await send(A, 'ws-offline-send');
  const pendingShown = await waitTrue(async () => ((await row(A, 'ws-offline-send').getAttribute('class').catch(() => '')) ?? '').includes('pending'), 3000, 50);
  const windowStays = (await row(A, 'ws-050').count()) === 1;
  await ctxA.setOffline(false);
  const reconnected = await waitTrue(async () => (await connection()) === 'connected' && (await row(A, 'ws-050').count()) === 0 && await atBottom()
    && !((await row(A, 'ws-offline-send').getAttribute('class').catch(() => 'pending')) ?? '').includes('pending'), 15000, 100);
  check(wentOff && newestReason && pendingShown && windowStays && reconnected,
    `offline ${wentOff}; Go to newest says "Needs a connection" ${newestReason}; pending row under the window ${pendingShown && windowStays}; after the reconnect the newest rows at the bottom, the message sent ${reconnected}`);

  // 7. Offline, a pin that is not loaded names the reason, and the panel stays.
  await ctxA.setOffline(true);
  await waitTrue(async () => (await connection()) === 'offline', 5000, 50);
  await jumpToPin('ws-050');
  const reason = await waitTrue(async () => (await A.locator('.pin-entry .row-reason').filter({ hasText: 'Needs a connection' }).count()) === 1, 2000, 50);
  check(reason && await panel.isVisible(), `"Needs a connection" at the entry ${reason}; panel open ${await panel.isVisible()}`);
  await A.keyboard.press('Escape');
  await ctxA.setOffline(false);
  await waitTrue(async () => (await connection()) === 'connected' && await atBottom(), 15000, 100);

  // 8. A reply quote jumps the same way (MR-34).
  await post('ws-reply', { replyToId: ids[50] });
  await waitTrue(async () => (await row(A, 'ws-reply').count()) === 1, 5000, 50);
  await sleep(1200);   // the device stores this tail: the store's write waits for 800 ms without a change
  await calls();
  await row(A, 'ws-reply').locator('.reply-preview').click();
  const quoteJump = await lit('ws-050');
  const c8 = await calls();
  check(quoteJump && c8.around === 1 && !c8.older, `quote: ws-050 highlighted ${quoteJump}; calls ${JSON.stringify(c8)}`);

  // 9. The device keeps the newest rows, never the window (OF-14).
  await sleep(1200);
  const stored = await A.evaluate(async id => (await (await import('/js/offline/snapshot.js')).loadTail(id))?.messages.map(m => m.text) ?? null, channelId);
  check(!!stored && stored.includes('ws-reply') && !stored.includes('ws-050'), `stored tail: ${stored?.length} rows, ends "${stored?.at(-1)}", holds ws-050 ${stored?.includes('ws-050')}`);

  // The arrow is the way back too (TL-40). It shows only more than a screen above the end of the window.
  await scroller(A).evaluate(e => { e.scrollTop = 0; });
  await waitTrue(async () => (await arrow.count()) === 1, 2000, 50);
  await calls();
  await arrow.click();
  const arrowBack = await waitTrue(async () => (await row(A, 'ws-reply').count()) === 1 && (await row(A, 'ws-050').count()) === 0 && await atBottom(), 5000, 50);
  const c9 = await calls();
  check(arrowBack && c9.openroom === 1, `the arrow leads to the newest rows ${arrowBack}; calls ${JSON.stringify(c9)}`);

  // 10. A loaded row scrolls with the animation and asks the server for nothing. ws-120 is in the tail, far enough
  // above the bottom to be centred.
  check((await invoke('pin', channelId, ids[120])) == null && (await row(A, 'ws-120').count()) === 1, 'ws-120 pinned and loaded');
  await sleep(500);
  await calls();
  await jumpToPin('ws-120');
  const loadedHl = await lit('ws-120');
  const c10 = await calls();
  check(loadedHl && !c10.around && Math.abs(await centred('ws-120')) <= 40, `highlighted ${loadedHl}; calls ${JSON.stringify(c10)}; ${await centred('ws-120')} px from the middle`);
  await invoke('unpin', channelId, ids[50]);
  await invoke('unpin', channelId, ids[120]);
});


// ---- the message search (docs/spec/search.md) ----
// The lobby holds ws-000 to ws-149 from step 16, newest last, and more rows after them.

const searchField = page => page.locator('.search-field-header .search-input');
const results = page => page.locator('.search-results .search-result');
const countLine = page => page.locator('.search-count');
const storeOf = page => page.evaluate(async () => { const s = (await import('/js/store.js')).state; return { connection: s.connection, window: !!s.open?.hasNewer }; });

await step(17, 'Search above 768 px: the field, the panel in the place of the sidebar, a result, Escape, the hint, the empty text, Ctrl+F (SR-03 to SR-23)', async (check) => {
  await A.goto(BASE + '/lobby');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const channelId = await A.evaluate(async () => (await import('/js/store.js')).state.open.channelId);
  const post = text => api(B, 'POST', `/api/channels/${channelId}/messages`, { clientId: crypto.randomUUID(), text });
  const long = Array.from({ length: 9 }, (_, i) => `line ${i + 1} of a long note about the move of the server`).join('\n') + '\nthe last line has the zebraword in it';
  await post(long);
  await post('Příliš žluťoučký kůň');
  const panel = A.locator('.search-panel'), sidebar = A.locator('.users-sidebar');

  // 1. No people button; the field is there with a placeholder. One character opens nothing; two open the panel.
  const noPeople = (await A.locator('.icon-people').count()) === 0 && !(await A.locator('.users-toggle').isVisible());
  const placeholder = await searchField(A).getAttribute('placeholder');
  await searchField(A).fill('w');
  await sleep(400);
  const oneChar = !(await panel.isVisible()) && await sidebar.isVisible();
  await searchField(A).fill('ws-05');
  const opened = await waitTrue(async () => (await panel.isVisible()) && !(await sidebar.isVisible()) && (await results(A).count()) === 10, 5000, 50);
  const count = await countLine(A).textContent();
  const first = await results(A).first().locator('.pin-text').textContent();
  const marks = await results(A).first().locator('mark').allTextContents();
  check(noPeople && !!placeholder && oneChar && opened && count === '10 results' && first === 'ws-059' && marks.join('|') === 'ws-05',
    `no people button ${noPeople}; placeholder "${placeholder}"; one character keeps the sidebar ${oneChar}; panel with 10 results ${opened}; count "${count}"; first "${first}"; marks ${JSON.stringify(marks)}`);
  await A.screenshot({ path: SHOTS + '17-search-panel.png' });

  // 2. A result that is not loaded: the window around it, the panel stays.
  await results(A).filter({ hasText: 'ws-052' }).locator('.pin-time').click();
  const jumped = await waitTrue(async () => ((await row(A, 'ws-052').first().getAttribute('class').catch(() => '')) ?? '').includes('highlight-message'), 5000, 50);
  const stays = (await panel.isVisible()) && (await results(A).count()) === 10 && (await A.locator('.newer-messages').count()) === 1;
  check(jumped && stays, `ws-052 highlighted ${jumped}; the panel stays with its results, the end row shows ${stays}`);

  // 3. Escape with the focus in the messages ends the search: the sidebar is back, the field is empty.
  await A.locator('.messages').click({ position: { x: 5, y: 5 } });
  await A.keyboard.press('Escape');
  const ended = await waitTrue(async () => (await sidebar.isVisible()) && !(await panel.isVisible()), 3000, 50);
  check(ended && (await searchField(A).inputValue()) === '', `Escape ends the search ${ended}; field "${await searchField(A).inputValue()}"`);

  // 4. Escape closes one thing: the emoji picker first, then the search (SR-23).
  await A.locator('.newer-messages-button').click();
  await waitTrue(async () => !(await storeOf(A)).window, 5000, 50);
  await searchField(A).fill('ws-05');
  await waitTrue(async () => (await results(A).count()) === 10, 5000, 50);
  const cont = A.locator('.message-input-container');
  await A.locator('.emoji-toggle-button').click();
  const pickerOpen = await waitTrue(async () => (await cont.getAttribute('data-picker')) === 'emoji', 3000, 50);
  await A.keyboard.press('Escape');
  const pickerClosed = await waitTrue(async () => (await cont.getAttribute('data-picker')) === null, 2000, 50);
  const searchKept = await panel.isVisible();
  await A.keyboard.press('Escape');
  const thenSearch = await waitTrue(async () => !(await panel.isVisible()), 2000, 50);
  check(pickerOpen && pickerClosed && searchKept && thenSearch, `picker open ${pickerOpen}; first Escape closes the picker ${pickerClosed} and keeps the search ${searchKept}; second Escape ends the search ${thenSearch}`);

  // 5. Nothing found: the empty text and the reach line with the name of the room. Cut to one character: the hint, the panel stays.
  await searchField(A).fill('qqzzxxnothing');
  const empty = await waitTrue(async () => (await A.locator('.search-empty').count()) === 1, 5000, 50);
  const since = await A.locator('.search-since').textContent().catch(() => '');
  const emptyText = await A.locator('.search-empty').textContent().catch(() => '');
  await searchField(A).fill('q');
  const hint = await waitTrue(async () => (await A.locator('.search-hint').textContent().catch(() => '')) === 'Type 2 or more characters', 3000, 50);
  check(empty && emptyText.length > 0 && /^Search covers messages in # lobby since .+\.$/.test(since) && hint && await panel.isVisible(),
    `empty text ${empty} "${emptyText}"; reach line "${since}"; hint at one character ${hint}, panel open ${await panel.isVisible()}`);
  // An emptied field keeps the panel (SR-20), and the X stays as the way out for a device with no Escape key (SR-22).
  await searchField(A).fill('');
  await sleep(200);
  const xStays = (await panel.isVisible()) && await A.locator('.search-field-header .search-clear').isVisible();
  await A.locator('.search-field-header .search-clear').click();
  const cleared = xStays && await waitTrue(async () => !(await panel.isVisible()) && (await sidebar.isVisible()) && !(await A.locator('.search-field-header .search-clear').isVisible()), 2000, 50);

  // 6. Ctrl+F puts the cursor in the field (SR-21).
  await A.locator('.message-input').click();
  await A.keyboard.press('Control+f');
  const focused = await searchField(A).evaluate(n => document.activeElement === n);
  check(cleared && focused, `with an empty field the panel and the X stay ${xStays}; the X ends the search ${cleared}; Ctrl+F focuses the field ${focused}`);

  // 7. Accent marks do not count, in the search and in the highlight (SR-04, SR-10).
  await searchField(A).fill('prilis kun');
  const folded = await waitTrue(async () => (await results(A).count()) === 1, 5000, 50);
  const foldMarks = await results(A).first().locator('mark').allTextContents();
  check(folded && foldMarks.join('|') === 'Příliš|kůň', `"prilis kun" finds the text ${folded}; marks ${JSON.stringify(foldMarks)}`);

  // 8. A long text whose only match is in its last line shows the match inside the six lines (SR-09).
  await searchField(A).fill('zebraword');
  // The row of the query before stays until the answer comes (SR-14), so the wait is for this query's mark.
  await waitTrue(async () => (await results(A).first().locator('mark').allTextContents().catch(() => [])).join('') === 'zebraword', 5000, 50);
  const box = await results(A).first().locator('.pin-text').evaluate(text => {
    const mark = text.querySelector('mark').getBoundingClientRect(), b = text.getBoundingClientRect();
    return { inside: mark.top >= b.top - 1 && mark.bottom <= b.bottom + 1, lines: Math.round(b.height / parseFloat(getComputedStyle(text).lineHeight)), cut: text.className };
  });
  check(box.inside && box.lines === 6 && box.cut.includes('cut-top'), `the match is inside the box ${box.inside}; ${box.lines} lines; classes "${box.cut}"`);
  await A.screenshot({ path: SHOTS + '17-search-long.png' });

  // 9. 25 results, the total of all, and more on scroll (SR-11).
  await searchField(A).fill('ws-');
  await waitTrue(async () => (await results(A).count()) === 25, 5000, 50);
  const total = await countLine(A).textContent();
  await A.locator('.search-list').evaluate(e => { e.scrollTop = e.scrollHeight; });
  const more = await waitTrue(async () => (await results(A).count()) >= 50, 5000, 50);
  check(/^\d{3} results$/.test(total) && more && (await countLine(A).textContent()) === total, `first page 25 of "${total}"; after a scroll ${await results(A).count()} rows; the count stays`);
  await A.keyboard.press('Escape');
});

const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
watchContext(ctxN, 'narrow');
const N = await ctxN.newPage(); watchPage(N, 'narrow');
await step(18, 'Search at 768 px or less: the sidebar row, the search screen, a result, Back, "Go to newest", the width tiers (SR-24 to SR-31)', async (check) => {
  await signIn(N, 'thumb');
  const screen = N.locator('.search-screen'), field = N.locator('.search-screen .search-input'), at = N.locator('.search-at-result');
  const cls = async loc => (await loc.getAttribute('class')) ?? '';
  const shown = async () => (await screen.isVisible()) && (await cls(screen)).includes('in') && !(await cls(screen)).includes('away');
  const openSearch = async () => { await N.click('.users-toggle'); await N.locator('.search-row').click(); };
  const lit = text => waitTrue(async () => ((await row(N, text).first().getAttribute('class').catch(() => '')) ?? '').includes('highlight-message'), 5000, 50);
  const tap = text => results(N).filter({ hasText: text }).locator('.pin-time').click();

  // 1. The row opens the screen and closes the sidebar; the hint shows; the field has the focus.
  await openSearch();
  const opened = await waitTrue(shown, 3000, 50);
  const sidebarClosed = !(await cls(N.locator('.users-sidebar'))).includes('sidebar-open');
  const hint = await N.locator('.search-hint').textContent().catch(() => '');
  const focus = await field.evaluate(n => document.activeElement === n);
  check(opened && sidebarClosed && hint === 'Type 2 or more characters' && focus, `screen open ${opened}; sidebar closed ${sidebarClosed}; hint "${hint}"; focus in the field ${focus}`);

  // 2. The count line names the conversation. A tap on a result that is not loaded: the message, the search header.
  await field.fill('ws-05');
  await waitTrue(async () => (await results(N).count()) === 10, 5000, 50);
  const count = await countLine(N).textContent();
  await N.screenshot({ path: SHOTS + '18-search-screen.png' });
  await N.locator('.search-list').evaluate(e => { e.scrollTop = 120; });
  const kept = await N.locator('.search-list').evaluate(e => e.scrollTop);
  await N.locator('.messages').evaluate(e => { e.__kept = true; });   // the list of messages must stay the same node through every step back
  await tap('ws-052');
  const atMessage = await waitTrue(async () => (await at.isVisible()) && (await cls(screen)).includes('away'), 5000, 50);
  const hl = await lit('ws-052');
  const header = { query: await at.locator('.search-at-query span').textContent(), count: await at.locator('.search-at-count').textContent(), controls: await N.locator('.header-controls').isVisible(), title: await N.locator('.header-title').isVisible() };
  await sleep(400);   // the fade of the screen (SR-30), so the picture shows the conversation alone
  check(count === '10 results · # lobby' && atMessage && hl && header.query === 'ws-05' && header.count === count && !header.controls && !header.title && (await N.locator('.newer-messages').count()) === 1,
    `count "${count}"; at the message ${atMessage}, highlighted ${hl}; header ${JSON.stringify(header)}; end row ${await N.locator('.newer-messages').count()}`);
  await N.screenshot({ path: SHOTS + '18-search-at-result.png' });

  // 3. The header's arrow shows the same list at the same place. The Back of the browser does the same, and the
  // conversation is not drawn again. Forward lands on a closed step, and the arrow still needs one press.
  await at.locator('.search-back').click();
  const backToList = await waitTrue(shown, 3000, 50);
  const place = await N.locator('.search-list').evaluate(e => e.scrollTop);
  await tap('ws-053');
  await waitTrue(async () => at.isVisible(), 5000, 50);
  await N.goBack();
  const browserBack = await waitTrue(shown, 3000, 50);
  const sameNode = await N.locator('.messages').evaluate(e => e.__kept === true);
  await N.goForward();
  await sleep(400);
  const stillList = await shown();
  await N.locator('.search-screen .search-back').click();
  const ended = await waitTrue(async () => !(await screen.isVisible()) && await N.locator('.header-controls').isVisible(), 3000, 50);
  check(backToList && place === kept && browserBack && sameNode && stillList && ended && (await N.evaluate(() => history.state)) === null,
    `arrow back to the list ${backToList}, scroll ${kept} -> ${place}; browser Back ${browserBack}, same message list ${sameNode}; after Forward the list still shows ${stillList}; one press of the arrow ends the search ${ended}; history state ${JSON.stringify(await N.evaluate(() => history.state))}`);

  // 4. "Go to newest" at a result ends the search and leaves no step behind (SR-28).
  await openSearch();
  await field.fill('ws-05');
  await waitTrue(async () => (await results(N).count()) === 10, 5000, 50);
  await tap('ws-052');
  await waitTrue(async () => at.isVisible(), 5000, 50);
  await N.locator('.newer-messages-button').click();
  const newest = await waitTrue(async () => !(await at.isVisible()) && !(await screen.isVisible()) && await N.locator('.header-controls').isVisible(), 5000, 50);
  await sleep(300);
  check(newest && (await N.evaluate(() => history.state)) === null && new URL(N.url()).pathname === '/lobby', `"Go to newest" ends the search ${newest}; history state ${JSON.stringify(await N.evaluate(() => history.state))}; path ${new URL(N.url()).pathname}`);

  // 5. A result in the loaded rows: centred, no end row, the search header stays through a scroll by hand, and the
  // down arrow ends the search.
  await waitTrue(async () => !(await storeOf(N)).window && (await row(N, 'ws-149').count()) === 1, 5000, 50);
  await openSearch();
  await field.fill('ws-14');
  await waitTrue(async () => (await results(N).count()) === 10, 5000, 50);
  await tap('ws-140');
  const loaded = await waitTrue(async () => at.isVisible(), 5000, 50);
  const noEnd = (await N.locator('.newer-messages').count()) === 0;
  // A scroll by hand starts with a finger on the list: that releases the row a jump holds in the middle (TL-41).
  await N.locator('.messages').dispatchEvent('pointerdown');
  await N.locator('.messages').evaluate(e => { e.scrollTop = 0; });
  await sleep(300);
  await N.locator('.messages').evaluate(e => { e.scrollTop = Math.max(0, e.scrollTop + 200); });
  await sleep(300);
  const byHand = await at.isVisible();
  const arrow = N.locator('.down-arrow');
  const arrowShown = await waitTrue(async () => (await arrow.count()) === 1, 3000, 50);
  if (arrowShown) await arrow.click();
  const arrowEnds = await waitTrue(async () => !(await at.isVisible()) && !(await screen.isVisible()), 3000, 50);
  check(loaded && noEnd && byHand && arrowShown && arrowEnds, `at a loaded result ${loaded}, no end row ${noEnd}; a scroll by hand keeps the search ${byHand}; the down arrow shows ${arrowShown} and ends the search ${arrowEnds}`);

  // 6. A reconnect under the result list keeps the query and the list (SR-28).
  await openSearch();
  await field.fill('ws-05');
  await waitTrue(async () => (await results(N).count()) === 10, 5000, 50);
  await tap('ws-052');
  await waitTrue(async () => at.isVisible(), 5000, 50);
  await at.locator('.search-back').click();
  await waitTrue(shown, 3000, 50);
  await ctxN.setOffline(true);
  const off = await waitTrue(async () => (await storeOf(N)).connection !== 'connected', 20000, 100);
  await ctxN.setOffline(false);
  const on = await waitTrue(async () => { const s = await storeOf(N); return s.connection === 'connected' && !s.window; }, 30000, 100);
  check(off && on && await shown() && (await field.inputValue()) === 'ws-05' && (await results(N).count()) === 10, `offline ${off}, connected again at the newest messages ${on}; the list still shows ${await shown()} with "${await field.inputValue()}" and ${await results(N).count()} results`);

  // 7. Without a connection the search says so (SR-18).
  await ctxN.setOffline(true);
  await waitTrue(async () => (await storeOf(N)).connection !== 'connected', 20000, 100);
  await field.fill('ws-06');
  const needs = await waitTrue(async () => (await N.locator('.search-error').textContent().catch(() => '')) === 'Needs a connection', 5000, 50);
  await ctxN.setOffline(false);
  await waitTrue(async () => (await storeOf(N)).connection === 'connected', 30000, 100);
  const again = await waitTrue(async () => (await results(N).count()) === 10 && (await N.locator('.search-error').count()) === 0, 5000, 50);   // ws-060 to ws-069
  check(needs && again, `"Needs a connection" in the place of the list ${needs}; with the connection back the search runs again by itself ${again}`);
  await N.locator('.search-screen .search-back').click();
  await waitTrue(async () => !(await screen.isVisible()), 3000, 50);

  // 8. Under the screen nothing takes the focus. The Search key puts the keyboard away. A reload during a search
  // leaves no dead step: the next search needs one Back, not two (SR-25, SR-27).
  await openSearch();
  await waitTrue(shown, 3000, 50);
  const covered = await N.evaluate(() => document.querySelector('.chat-header').inert && document.querySelector('.chat-main').inert);
  await field.press('Enter');
  const blurred = await field.evaluate(n => document.activeElement !== n);
  await N.reload();
  await N.waitForSelector('.message-input', { timeout: 10000 });
  const stateAfterReload = await N.evaluate(() => history.state);
  const uncovered = await N.evaluate(() => !document.querySelector('.chat-header').inert && !document.querySelector('.chat-main').inert);
  await openSearch();
  await waitTrue(shown, 3000, 50);
  await N.goBack();
  const oneBack = await waitTrue(async () => !(await screen.isVisible()), 3000, 50);
  check(covered && blurred && stateAfterReload === null && uncovered && oneBack,
    `the frame under the screen is inert ${covered}; Enter leaves the field ${blurred}; after a reload the history state is ${JSON.stringify(stateAfterReload)} and the frame is free ${uncovered}; one Back ends the next search ${oneBack}`);

  // 9. 700 px is the same design. A window that crosses 768 px ends the search (SR-31).
  await N.setViewportSize({ width: 700, height: 900 });
  await openSearch();
  const wide = await waitTrue(shown, 3000, 50);
  const covers = await screen.evaluate(e => { const r = e.getBoundingClientRect(); return Math.round(r.width) === innerWidth && Math.round(r.top) === 0; });
  await field.fill('ws-05');
  await waitTrue(async () => (await results(N).count()) === 10, 5000, 50);
  await N.screenshot({ path: SHOTS + '18-search-700.png' });
  await N.setViewportSize({ width: 1000, height: 900 });
  const tierEnds = await waitTrue(async () => !(await screen.isVisible()) && !(await N.locator('.search-panel').isVisible()) && (await searchField(N).inputValue()) === '', 3000, 50);
  check(wide && covers && tierEnds && (await N.evaluate(() => history.state)) === null, `the screen at 700 px ${wide}, over the whole frame ${covers}; 1000 px ends the search ${tierEnds}; history state ${JSON.stringify(await N.evaluate(() => history.state))}`);
});

await finish(browser, server);
