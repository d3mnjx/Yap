// The smoke run of the chat client (two people, a phone): login, the frame, messages, reactions, editing,
// typing, DMs and unread, delete, status, the pickers, reload on a deep link, sign-out, the back button.
// Run: npm run smoke (see README.md). Screenshots go to shots/.

import { chromium } from 'playwright';
import { acceptDialogs, BASE, SHOTS, sleep, waitTrue, row, logs, step, finish, startServer, signIn, watchContext, watchPage } from './lib.mjs';

const audit = {};
async function hiddenAudit(page, name) {
  const list = await page.evaluate(() => [...document.querySelectorAll('[hidden]')].filter(e => getComputedStyle(e).display !== 'none').map(e => (e.className?.baseVal ?? e.className) || e.tagName));
  for (const c of list) audit[c] = (audit[c] ?? new Set()).add(name);
}
const server = await startServer();
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxA, 'A');
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxB, 'B');
const A = await ctxA.newPage(); watchPage(A, 'A');
const B = await ctxB.newPage(); watchPage(B, 'B');

await step(1, 'Login page', async (check) => {
  await A.goto(BASE + '/');
  await A.waitForSelector('.page-login', { timeout: 10000 });
  check(await A.locator('.page-login .username-input').count() === 1, 'username-input present');
  check(await A.locator('.page-login .username-form .join-button').count() === 1, `join-button present, text "${await A.locator('.username-form .join-button').textContent().catch(() => '')}"`);
  await A.screenshot({ path: SHOTS + '01-login.png' });
});

await step(2, 'Sign in boss, frame', async (check) => {
  await A.fill('.username-input', 'boss');
  await A.press('.username-input', 'Enter');   // Enter before the server's check: the page joins when the answer arrives
  await A.waitForSelector('.chat-container', { timeout: 10000 });
  await A.waitForSelector('.users-sidebar .rooms-list .room-item', { timeout: 10000 });
  const name = (await A.locator('.chat-header .status-username').textContent())?.trim();
  check(name === 'boss', `status-username "${name}"`);
  const rooms = await A.locator('.users-sidebar .rooms-list .room-item').count();
  const roomTexts = await A.locator('.users-sidebar .rooms-list .room-item').allInnerTexts();
  check(rooms >= 1, `room-item count ${rooms} (${roomTexts.map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')})`);
  check(await A.locator('.message-input').count() === 1, 'message-input present');
  await waitTrue(async () => new URL(A.url()).pathname === '/lobby', 2000);
  const path = new URL(A.url()).pathname;
  check(path === '/lobby', `path ${path}`);
  check(await A.locator('.room-item.add-room').count() >= 1, 'add-room present (admin)');
  await A.screenshot({ path: SHOTS + '02-frame.png' });
});

await step(3, 'Sign in guest, presence in A', async (check, notes) => {
  const tSubmit = await signIn(B, 'guest');
  check(true, `B frame up, path ${new URL(B.url()).pathname}`);
  const ok = await waitTrue(async () => (await A.locator('.users-list .user-item', { hasText: 'guest' }).count()) > 0, 5000, 50);
  const dt = Date.now() - tSubmit;
  check(ok && dt <= 3000, `A shows guest user-item without reload: ${ok}, ${dt} ms after guest's submit`);
  const users = await A.locator('.users-list .user-item').allInnerTexts();
  // The count of people online is in the people title of the sidebar (SH-28); the header has no people button
  // above 768 px (SH-08). The bot counts as online, so the number is 3 with two people; reported, not asserted.
  check(true, `users-list: ${users.map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')}; people-header "${(await A.locator('.people-header').textContent())?.trim()}"`);
});

await step(4, 'Send "hello from boss"', async (check) => {
  await A.evaluate(() => {
    window.__seen = [];
    const mc = document.querySelector('.messages-container');
    new MutationObserver(() => {
      for (const g of document.querySelectorAll('.message-group')) {
        if (g.textContent.includes('hello from boss')) window.__seen.push(g.className);
      }
    }).observe(mc, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const t0 = Date.now();
  await A.fill('.message-input', 'hello from boss');
  await A.press('.message-input', 'Enter');
  await row(A, 'hello from boss').first().waitFor({ timeout: 5000 });
  const settled = await waitTrue(async () => { const r = row(A, 'hello from boss'); return (await r.count()) === 1 && !(await r.getAttribute('class')).includes('pending'); }, 5000, 50);
  const seen = [...new Set(await A.evaluate(() => window.__seen))];
  check(settled, `A row present, .pending gone within 5s: ${settled} (${Date.now() - t0} ms); classes seen: ${seen.join(' / ')}`);
  check(await A.locator('.message-input').inputValue() === '', 'A input cleared');
  const okB = await waitTrue(async () => (await row(B, 'hello from boss').count()) === 1, 5000);
  const hdr = okB ? (await row(B, 'hello from boss').locator('.message-username').textContent())?.trim() : null;
  check(okB && hdr === 'boss', `B row present: ${okB}, header name "${hdr}"`);
  await B.screenshot({ path: SHOTS + '03-message.png' });
});

await step(5, 'Send "hi boss" from B', async (check) => {
  await B.fill('.message-input', 'hi boss');
  await B.press('.message-input', 'Enter');
  const okA = await waitTrue(async () => (await row(A, 'hi boss').count()) === 1, 5000);
  check(okA, 'A shows "hi boss"');
  await waitTrue(async () => !((await row(B, 'hi boss').getAttribute('class')) ?? 'pending').includes('pending'), 5000);
  for (const [p, nm] of [[B, 'B'], [A, 'A']]) {
    const c1 = await row(p, 'hello from boss').getAttribute('class');
    const c2 = await row(p, 'hi boss').getAttribute('class');
    check(c1.includes('has-header') && c2.includes('has-header'), `${nm}: "hello from boss" class="${c1}"; "hi boss" class="${c2}"`);
  }
});

await step(6, 'Reaction from B', async (check, notes) => {
  const r = row(B, 'hello from boss');
  await r.hover();
  await r.locator('.message-actions .action-picker').click();
  await B.waitForSelector('.emoji-picker-wrapper', { timeout: 5000 });
  const sections = await B.locator('.emoji-picker-wrapper .emoji-section').evaluateAll(els => els.map(e => `${e.dataset.section}:${e.querySelectorAll('.emoji-btn').length}`));
  check(sections.length > 0, `wrapper open; sections ${sections.join(', ')}`);
  const btn = B.locator('.emoji-picker-wrapper [data-section="smileys"] .emoji-btn').first();
  if (await btn.count() === 0) { check(false, 'no smileys section'); return; }
  const emoji = await btn.getAttribute('data-emoji');
  await btn.click();
  const okB = await waitTrue(async () => (await row(B, 'hello from boss').locator('.reaction-pill').count()) > 0, 5000);
  const okA = await waitTrue(async () => (await row(A, 'hello from boss').locator('.reaction-pill').count()) > 0, 5000);
  const pillA = okA ? (await row(A, 'hello from boss').locator('.reaction-pill').first().innerText()).replace(/\s+/g, ' ') : '';
  check(okA && okB, `clicked ${emoji}; pill in B: ${okB}, in A: ${okA} ("${pillA}"); wrapper closed: ${(await B.locator('.emoji-picker-wrapper').count()) === 0}`);
  await A.screenshot({ path: SHOTS + '04-reaction.png' });
});

await step(7, 'Edit in A', async (check) => {
  const r = row(A, 'hello from boss');
  await r.hover();
  await r.locator('.action-edit').click();
  const ed = A.locator('.edit-input');
  await ed.waitFor({ timeout: 5000 });
  const val = await ed.inputValue();
  check(val === 'hello from boss', `edit-input value "${val}"`);
  await ed.press('End');
  await ed.pressSequentially(' (edited)');
  await ed.press('Enter');
  for (const [p, nm] of [[A, 'A'], [B, 'B']]) {
    const ok = await waitTrue(async () => (await row(p, 'hello from boss (edited)').locator('.edited-indicator').count()) > 0, 5000);
    const txt = ok ? (await row(p, 'hello from boss (edited)').locator('.message-content').innerText()) : '';
    check(ok, `${nm}: content "${txt}", edited-indicator ${ok}`);
  }
  check(await A.locator('.edit-input').count() === 0, 'editor closed in A');
});

await step(8, 'Typing indicator', async (check) => {
  await B.click('.message-input');
  const t0 = Date.now();
  await B.locator('.message-input').pressSequentially('typing...', { delay: 50 });
  const tEnd = Date.now();
  const ti = A.locator('.typing-indicator');
  const shown = await waitTrue(async () => (await ti.isVisible()) && (await ti.innerText()).includes('guest'), 3000, 50);
  check(shown, `A typing-indicator visible with guest: ${shown}, text "${(await ti.innerText().catch(() => '')).trim()}" (${Date.now() - t0} ms after first key)`);
  const attrHidden = await waitTrue(async () => (await ti.getAttribute('hidden')) !== null, 8000, 100);
  const tAttr = Date.now() - tEnd;
  const hidden = await waitTrue(async () => (await ti.evaluate(e => getComputedStyle(e).display)) === 'none', 1000, 100);
  const st = await ti.evaluate(e => ({ display: getComputedStyle(e).display, hiddenAttr: e.hidden, text: e.innerText.trim() }));
  check(attrHidden && hidden, `hidden attribute set: ${attrHidden} (${tAttr} ms after last key); still visible to the user: ${!hidden}; computed display "${st.display}", hidden=${st.hiddenAttr}, text left "${st.text}"`);
  await B.fill('.message-input', '');
});

await step(9, 'DM and unread', async (check) => {
  await A.locator('.users-list .user-item', { hasText: 'guest' }).first().locator('.user-name').click();
  await waitTrue(async () => new URL(A.url()).pathname === '/dm/guest', 5000);
  check(new URL(A.url()).pathname === '/dm/guest', `A path ${new URL(A.url()).pathname}`);
  const h3 = await A.locator('.dm-header-title h3').textContent({ timeout: 3000 }).catch(() => null);
  check(h3?.trim() === 'guest', `dm header "${h3?.trim()}"`);
  check(await A.locator('.chat-container[data-context="dm"]').count() === 1, `data-context=${await A.locator('.chat-container').getAttribute('data-context')}`);
  await A.fill('.message-input', 'psst');
  await A.press('.message-input', 'Enter');
  const bossRow = B.locator('.users-list .user-item', { hasText: 'boss' }).first();
  const ok = await waitTrue(async () => (await bossRow.locator('.unread-badge').innerText()).trim() === '1', 5000);
  check(ok, `B boss unread-badge "${(await bossRow.locator('.unread-badge').innerText().catch(() => '')).trim()}" visible=${await bossRow.locator('.unread-badge').isVisible()}`);
  await waitTrue(() => B.locator('.mailbox-button').isVisible(), 3000);
  const mbVis = await B.locator('.mailbox-button').isVisible();
  const mbTxt = (await B.locator('.mailbox-badge').innerText().catch(() => '')).trim();
  check(mbVis && mbTxt === '1', `B mailbox visible ${mbVis}, badge "${mbTxt}"`);
  await B.screenshot({ path: SHOTS + '05-unread.png' });
  await bossRow.locator('.user-name').click();
  await waitTrue(async () => new URL(B.url()).pathname === '/dm/boss', 5000);
  check(new URL(B.url()).pathname === '/dm/boss', `B path ${new URL(B.url()).pathname}`);
  const ps = await waitTrue(async () => (await row(B, 'psst').count()) === 1, 5000);
  check(ps, `B sees psst: ${ps}`);
  const mbHidden = await waitTrue(async () => (await B.locator('.mailbox-button').evaluate(e => getComputedStyle(e).display)) === 'none', 3000);
  check(mbHidden, `B mailbox computed display none: ${mbHidden} (display "${await B.locator('.mailbox-button').evaluate(e => getComputedStyle(e).display)}", hidden attr ${await B.locator('.mailbox-button').getAttribute('hidden') !== null}); boss badge now "${(await bossRow.locator('.unread-badge').innerText().catch(() => '')).trim()}"`);
});

await hiddenAudit(A, 'A'); await hiddenAudit(B, 'B');
await step(10, 'Delete psst', async (check) => {
  const r = row(A, 'psst');
  await r.hover();
  await r.locator('.action-more').click();
  const menu = A.locator('.more-menu');
  await menu.waitFor({ state: 'visible', timeout: 3000 });
  check(true, `more-menu items: ${(await menu.locator('.more-menu-item:visible').allInnerTexts()).map(s => s.trim()).join(' | ')}`);
  await menu.locator('[data-action="delete"]').click();
  await A.locator('.delete-confirm-overlay').waitFor({ timeout: 3000 });
  check(true, 'delete-confirm-overlay shown');
  await A.locator('.confirm-delete').click();
  const goneA = await waitTrue(async () => (await row(A, 'psst').count()) === 0, 5000);
  const goneB = await waitTrue(async () => (await row(B, 'psst').count()) === 0, 5000);
  check(goneA && goneB, `gone in A: ${goneA}, in B: ${goneB}; overlay closed: ${(await A.locator('.delete-confirm-overlay').count()) === 0}`);
});

await step(11, 'Status menu, Away', async (check) => {
  await A.click('.status-button');
  const dd = A.locator('.status-dropdown');
  await dd.waitFor({ state: 'visible', timeout: 3000 });
  const items = (await dd.locator('.dropdown-item:visible').allInnerTexts()).map(s => s.trim());
  const want = ['Online', 'Away', 'Invisible', 'Settings', 'Notification settings', 'Admin', 'Sign Out'];
  check(want.every(w => items.includes(w)), `items: ${items.join(' | ')}`);
  await dd.locator('[data-status="away"]').click();
  const okA = await waitTrue(async () => (await A.locator('.status-button').getAttribute('class')).includes('status-away'), 3000);
  check(okA, `A status-button class "${await A.locator('.status-button').getAttribute('class')}"; dropdown closed: ${!(await dd.isVisible().catch(() => false))}`);
  const dot = B.locator('.users-list .user-item', { hasText: 'boss' }).first().locator('.user-status-dot');
  const okB = await waitTrue(async () => (await dot.getAttribute('class')).includes('away'), 3000);
  check(okB, `B boss dot class "${await dot.getAttribute('class')}"`);
  await A.click('.status-button');
  await A.locator('.status-dropdown [data-status="online"]').click();
  const back = await waitTrue(async () => (await A.locator('.status-button').getAttribute('class')).includes('status-online'), 3000);
  const backB = await waitTrue(async () => (await dot.getAttribute('class')).includes('online'), 3000);
  check(back && backB, `back to online: A "${await A.locator('.status-button').getAttribute('class')}", B dot "${await dot.getAttribute('class')}"`);
});

await step(12, 'Emoji toggle', async (check) => {
  await A.click('.emoji-toggle-button');
  const cont = A.locator('.message-input-container');
  const open = await waitTrue(async () => (await cont.getAttribute('data-picker')) === 'emoji', 3000);
  const picker = A.locator('.message-input-container [data-picker-pane="emoji"] .emoji-picker');
  const vis = await picker.isVisible().catch(() => false);
  const nSec = await picker.locator('.emoji-section').count();
  check(open && vis && nSec > 0, `data-picker=${await cont.getAttribute('data-picker')}, picker visible ${vis}, sections ${nSec}`);
  await picker.locator('.emoji-search input').fill('smile');
  await sleep(500);
  const hits = await picker.locator('.emoji-btn:not([data-search-miss])').evaluateAll(els => els.filter(e => e.offsetParent !== null).length);
  const total = await picker.locator('.emoji-btn:not([data-search-miss])').count();
  check(hits > 0, `after "smile": ${hits} visible .emoji-btn:not([data-search-miss]) (${total} without data-search-miss in DOM)`);
  await A.keyboard.press('Escape');
  const closed = await waitTrue(async () => (await cont.getAttribute('data-picker')) === null, 2000);
  check(closed, `Escape closes: data-picker=${await cont.getAttribute('data-picker')}`);
});

await step(13, 'GIF toggle', async (check) => {
  await A.click('.gif-toggle-button');
  const cont = A.locator('.message-input-container');
  const open = await waitTrue(async () => (await cont.getAttribute('data-picker')) === 'gif', 3000);
  const gp = A.locator('.gif-picker');
  const vis = await waitTrue(() => gp.isVisible(), 3000);
  check(open && vis, `data-picker=${await cont.getAttribute('data-picker')}, gif-picker visible ${vis}`);
  await sleep(2000);
  const txt = (await A.locator('.gif-results').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const cards = await A.locator('.gif-results > *').count();
  check(true, `gif-results text "${txt.slice(0, 100)}" (children ${cards})`);
  await A.mouse.click(300, 200);
  const closed = await waitTrue(async () => (await cont.getAttribute('data-picker')) === null, 2000);
  check(closed, `click outside closes: data-picker=${await cont.getAttribute('data-picker')}`);
});

await step(14, 'Reload A on DM', async (check) => {
  await A.fill('.message-input', 'before reload');
  await A.press('.message-input', 'Enter');
  await waitTrue(async () => (await row(B, 'before reload').count()) === 1, 5000);
  const before = (await A.locator('.messages-container .message-group .message-content').allInnerTexts()).map(s => s.trim());
  const nLogs = logs.length;
  await A.reload();
  const up = await waitTrue(async () => (await A.locator('.chat-container').count()) > 0, 10000);
  if (!up) {
    const n404 = logs.slice(nLogs).filter(l => l.page === 'A' && l.kind === 'http');
    check(false, `no frame after reload; body text "${(await A.locator('body').innerText()).trim().slice(0, 80)}"; ${n404.length} HTTP errors, e.g. ${n404.slice(0, 4).map(l => l.text).join(', ')}`);
    return;
  }
  await waitTrue(async () => (await row(A, 'before reload').count()) === 1, 5000);
  const after = (await A.locator('.messages-container .message-group .message-content').allInnerTexts()).map(s => s.trim());
  const path = new URL(A.url()).pathname;
  const ctx = await A.locator('.chat-container').getAttribute('data-context');
  const h3 = (await A.locator('.dm-header-title h3').textContent().catch(() => ''))?.trim();
  check(path === '/dm/guest' && ctx === 'dm' && h3 === 'guest', `path ${path}, context ${ctx}, header "${h3}"`);
  check(JSON.stringify(before) === JSON.stringify(after), `messages before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  await sleep(1000);
  const n404 = logs.slice(nLogs).filter(l => l.page === 'A' && l.kind === 'http');
  check(n404.length === 0, `HTTP errors after reload: ${n404.length}${n404.length ? ' — ' + n404.map(l => l.text).join(', ') : ''}`);
  // ERR_ABORTED entries are the old document's requests (lazy emoji images) that the reload cancels; they say
  // nothing about the reloaded page.
  const newErr = logs.slice(nLogs).filter(l => l.page === 'A' && !(l.kind === 'requestfailed' && l.text.endsWith('net::ERR_ABORTED')));
  check(newErr.length === 0, `A log entries after reload: ${newErr.length}${newErr.length ? ' — ' + newErr.map(l => l.kind + ': ' + l.text.slice(0, 120)).join(' ; ') : ''}`);
});

const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
watchContext(ctxP, 'phone');
const P = await ctxP.newPage(); watchPage(P, 'phone');
await step(15, 'Phone layout', async (check) => {
  await signIn(P, 'guest2');
  const ham = await P.locator('.icon-hamburger').isVisible();
  const sb = await P.locator('.users-sidebar').getAttribute('class');
  check(ham && !sb.includes('sidebar-open'), `hamburger visible ${ham}, sidebar class "${sb}", path ${new URL(P.url()).pathname}`);
  await P.click('.users-toggle');
  const open = await waitTrue(async () => (await P.locator('.users-sidebar').getAttribute('class')).includes('sidebar-open'), 2000);
  check(open, `after toggle: "${await P.locator('.users-sidebar').getAttribute('class')}"`);
  await sleep(400);
  await P.screenshot({ path: SHOTS + '06-phone.png' });
  await P.click('.users-toggle').catch(async () => { await P.click('.sidebar-backdrop'); });
  const closedSb = await waitTrue(async () => !(await P.locator('.users-sidebar').getAttribute('class')).includes('sidebar-open'), 2000);
  check(closedSb, `sidebar closed again before emoji: ${closedSb}`);
  await P.click('.emoji-toggle-button');
  const ok = await waitTrue(async () => (await P.locator('[data-picker-pane="emoji"] .combined-picker').count()) > 0, 3000);
  const dp = await P.locator('.message-input-container').getAttribute('data-picker');
  const vis = await P.locator('[data-picker-pane="emoji"] .combined-picker').isVisible().catch(() => false);
  check(ok, `combined-picker in emoji pane: ${ok}, visible ${vis}, data-picker=${dp}, active-tab ${await P.locator('.combined-picker').first().getAttribute('data-active-tab').catch(() => null)}`);
  await sleep(500);
  await P.screenshot({ path: SHOTS + '07-phone-sheet.png' });
  // IB-41: the sheet keeps its pickers across a visit to another page
  const emojiBefore = await P.locator('.combined-picker .emoji-btn').count();
  await P.evaluate(async () => (await import('/js/router.js')).navigate('/settings'));
  await waitTrue(async () => new URL(P.url()).pathname === '/settings' && (await P.locator('.page-settings').count()) > 0, 5000);
  await P.evaluate(async () => (await import('/js/router.js')).navigate('/lobby'));
  await P.waitForSelector('.message-input', { timeout: 5000 });
  await P.click('.emoji-toggle-button');
  const again = await waitTrue(async () => (await P.locator('.combined-picker .emoji-btn').count()) > 0, 3000);
  const gifPane = await P.locator('.combined-picker [data-combined-pane="gifs"] > *').count();
  check(emojiBefore > 0 && again && gifPane > 0, `sheet after Settings and back: emoji buttons before ${emojiBefore}, after ${await P.locator('.combined-picker .emoji-btn').count()}; GIF pane children ${gifPane}`);
});

await hiddenAudit(P, 'phone');
await step(16, 'Sign out A', async (check, notes) => {
  if (await A.locator(".status-button").count() === 0) { notes.push("(fallback) page A had no frame; loaded / again first"); await A.goto(BASE + "/"); await A.waitForSelector(".status-button", { timeout: 10000 }); }
  const flags = await A.evaluate(async () => { const d = await (await fetch('/api/bootstrap')).json(); return { hasLink: d.user?.hasLink, hasPassphrase: d.user?.hasPassphrase }; });
  notes.push(`bootstrap user flags ${JSON.stringify(flags)}`);
  const A2 = await ctxA.newPage(); watchPage(A2, 'A2');   // a second tab of the same device (GEN-05)
  await A2.goto(BASE + '/dm/guest'); await A2.waitForSelector('.message-input', { timeout: 10000 }); await sleep(500);
  const nLogs16 = logs.length;
  const signoutResp = A.waitForResponse(r => r.url().endsWith('/api/auth/signout'), { timeout: 5000 }).catch(() => null);
  await A.click('.status-button');
  await A.locator('.status-dropdown [data-action="signout"]').click();
  await acceptDialogs(A);
  const ok = await waitTrue(async () => (await A.locator('.page-login').count()) === 1, 5000);
  const dialogs = logs.slice(nLogs16).filter(l => l.page === 'A' && l.kind === 'dialog').map(l => l.text);   // accepted by acceptDialogs
  check(ok, `login page: ${ok}, path ${new URL(A.url()).pathname}, dialogs: ${JSON.stringify(dialogs)}`);
  const resp = await signoutResp;
  check(resp?.status() === 204, `/api/auth/signout status ${resp?.status()}`);
  const otherTab = await waitTrue(async () => (await A2.locator('.page-login').count()) === 1, 5000);
  const a2 = await A2.evaluate(async () => { const s = (await import('/js/store.js')).state; return { user: s.user?.username ?? null, connection: s.connection }; });
  check(otherTab && !a2.user && a2.connection === 'signedOut', `second tab of the device: login page ${otherTab}, user ${a2.user}, connection ${a2.connection}`);
  await A2.close();
  await sleep(500);
  const errs16 = logs.slice(nLogs16).filter(l => l.page === 'A');
  check(errs16.filter(l => l.kind === 'pageerror').length === 0, `A log entries during sign-out: ${errs16.length}${errs16.length ? ' — ' + errs16.map(l => l.kind + ': ' + l.text.slice(0, 120)).join(' ; ') : ''}`);
  await A.screenshot({ path: SHOTS + '08-after-signout.png' });
});

await step(17, 'Back button in B reopens the DM (SH-44)', async (check) => {
  const p0 = new URL(B.url()).pathname;
  await B.locator('.rooms-list .room-item', { hasText: 'lobby' }).first().click();
  // The URL changes at the click; the context changes when the chat page mounts, after the route handler awaited
  // the page module. A read between the two sees "dm" under /lobby, so wait for both (2 of 4 runs on 2026-10-18).
  await waitTrue(async () => new URL(B.url()).pathname === '/lobby' && (await B.locator('.chat-container').getAttribute('data-context')) === 'room', 3000);
  const p1 = new URL(B.url()).pathname;
  const ctx1 = await B.locator('.chat-container').getAttribute('data-context');
  check(p1 === '/lobby' && ctx1 === 'room', `start ${p0}; after lobby click: path ${p1}, context ${ctx1}`);
  await B.goBack();
  const back = await waitTrue(async () => new URL(B.url()).pathname === '/dm/boss' && (await B.locator('.chat-container').getAttribute('data-context')) === 'dm', 3000);
  await sleep(500);
  const h3 = (await B.locator('.dm-header-title h3').textContent().catch(() => ''))?.trim();
  const msgs = (await B.locator('.messages-container .message-group .message-content').allInnerTexts()).map(s => s.trim());
  check(back && h3 === 'boss', `after back: path ${new URL(B.url()).pathname}, context ${await B.locator('.chat-container').getAttribute('data-context')}, header "${h3}", messages ${JSON.stringify(msgs)}`);
  await B.goBack();
  await sleep(800);
  check(true, `second back: path ${new URL(B.url()).pathname}, context ${await B.locator('.chat-container').getAttribute('data-context').catch(() => null)}`);
  await B.screenshot({ path: SHOTS + '09-back.png' });
});

console.log('\n==== HIDDEN-BUT-DISPLAYED (elements with [hidden] whose computed display is not none) ====');
for (const [c, pages] of Object.entries(audit)) console.log(`${c}  (${[...pages].join(',')})`);
await finish(browser, server);
