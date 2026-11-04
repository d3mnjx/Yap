// The feature run of the chat client: replies, link cards, the image gallery, emoji sizes and pack emoji,
// older pages and the top note, the New messages pill, typing in a DM, Shift+Enter, the keys on a GIF star, the
// emoji pick at the limit with Edit on a failed row, a rename of the open room, and the media of a pin (the viewer over
// the pins panel, a video that plays in the entry).
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

await finish(browser, server);
