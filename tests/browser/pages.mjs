// The page run of the client (step 5): the login rules, Settings, the login link and the retired secret code, the
// verification and link pages, Admin (users, invites, registration, bot, debug, logs, GIFs, diagnostics) and
// Create Channel / Channel Settings, the keyboard on the sidebar and +, the notification choices at 20 px on a
// phone, and the GIF picker's Settings link. Run: npm run pages (see README.md). Screenshots go to shots/ (20-…).

import { chromium } from 'playwright';
import { acceptDialogs, BASE, SHOTS, sleep, waitTrue, step, stepLogs, finish, startServer, signIn, watchContext, watchPage } from './lib.mjs';

const txt = async loc => ((await loc.first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
const vis = loc => loc.first().isVisible().catch(() => false);
const pathOf = page => new URL(page.url()).pathname;
const atPath = (page, p, ms = 5000) => waitTrue(async () => pathOf(page) === p, ms);
async function menu(page, action) {
  await page.click('.status-button');
  await page.locator(`.status-dropdown [data-action="${action}"]`).click();
}
// Sign Out in the status menu. acceptDialogs presses and records every confirmation; the step reads them from the log.
async function signOut(page) {
  await menu(page, 'signout');
  await acceptDialogs(page);
  return waitTrue(async () => pathOf(page) === '/login' && (await page.locator('.page-login').count()) > 0, 5000);
}
const dialogs = (n, name) => stepLogs(n, name).filter(l => l.kind === 'dialog' && l.page === name).map(l => l.text);

const server = await startServer();
const browser = await chromium.launch();
// The status of every write, so the report can tell a request that failed from one that got its answer and was
// then reported as aborted (a 204 whose empty body api.js does not read).
const writes = new Map();
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  watchContext(ctx, name);
  ctx.on('response', r => { if (r.request().method() !== 'GET') { const k = `${name} ${r.request().method()} ${new URL(r.url()).pathname}`; writes.set(k, [...(writes.get(k) ?? []), r.status()]); } });
  const page = await ctx.newPage(); watchPage(page, name);
  return { ctx, page };
}
const { ctx: ctxA, page: A } = await open('A');
await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });   // step 5 reads the copied link back
const { page: B } = await open('B');
let C = null, D = null;
let linkUrl = null, inviteUrl = null, roomId = null;

await step(1, 'Login validation (AU-02)', async (check, notes) => {
  await A.goto(BASE + '/');
  await A.waitForSelector('.page-login .username-input', { timeout: 10000 });
  const input = A.locator('.username-input'), err = A.locator('.page-login .validation-error'), hint = A.locator('.new-account-hint');
  const button = A.locator('.username-form .join-button');
  // Key by key, the trim runs at every keystroke, so the space goes before the B arrives.
  await input.pressSequentially('A B', { delay: 40 });
  notes.push(`typed key by key "A B" -> value "${await input.inputValue()}"`);
  await input.fill('A B');   // one input event, as a paste
  await sleep(150);
  const v = await input.inputValue();
  check(v === 'a b', `fill "A B" -> value "${v}"`);
  const e1 = await txt(err), d1 = await button.isDisabled();
  check(await vis(err) && e1 === 'Only lowercase letters, numbers, _ and . allowed' && d1, `error "${e1}" visible ${await vis(err)}, join disabled ${d1}`);
  await input.fill('ab..c'); await sleep(150);
  const e2 = await txt(err);
  check(await vis(err) && e2 === 'Cannot have consecutive periods' && await button.isDisabled(), `"ab..c": error "${e2}", join disabled ${await button.isDisabled()}`);
  await input.fill(''); await input.fill('a'); await sleep(100);
  const preBlur = (await vis(err)) ? `"${await txt(err)}"` : '(hidden)';
  await input.blur();
  const e3 = (await vis(err)) ? await txt(err) : '(hidden)';
  await sleep(700);   // the server's check for "a" answers 250 ms after the keystroke
  const e3late = (await vis(err)) ? await txt(err) : '(hidden)';
  check(e3 === 'Username must be at least 2 characters' && e3late === e3, `"a": before blur ${preBlur}; after blur "${e3}"; 700 ms later "${e3late}"`);
  const t0 = Date.now();
  await input.fill('boss');
  const ok = await waitTrue(async () => (await vis(hint)) && (await txt(hint)).includes('boss') && !(await button.isDisabled()), 1000, 25);
  check(ok, `"boss": hint "${await txt(hint)}" after ${Date.now() - t0} ms, join enabled ${!(await button.isDisabled())}, error visible ${await vis(err)}`);
  await A.screenshot({ path: SHOTS + '20-login-hint.png' });
});

await step(2, 'Sign in boss (Enter) and guest', async (check) => {
  await A.press('.username-input', 'Enter');
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const okA = await atPath(A, '/lobby', 3000);
  check(okA, `A path ${pathOf(A)}, status-username "${await txt(A.locator('.status-username'))}"`);
  await signIn(B, 'guest');
  check(pathOf(B) === '/lobby', `B path ${pathOf(B)}`);
});

await step(3, 'Settings page: themes and text size', async (check, notes) => {
  await menu(A, 'settings');
  const ok = await atPath(A, '/settings', 3000);
  await A.waitForSelector('.page-settings', { timeout: 5000 }).catch(() => {});
  const inFrame = await A.locator('.chat-container .page-settings').count();
  const title = await txt(A.locator('.dm-header-title h3'));
  check(ok && inFrame === 1 && title === 'Settings', `path ${pathOf(A)}, .page-settings inside .chat-container ${inFrame}, header title "${title}"`);
  await A.waitForSelector('.theme-grid .theme-card', { timeout: 5000 }).catch(() => {});
  await A.screenshot({ path: SHOTS + '21-settings-top.png' });
  const cards = await A.locator('.theme-grid .theme-card').count(), sel = await A.locator('.theme-grid .theme-card.selected').count();
  const selName = await A.locator('.theme-grid .theme-card.selected').getAttribute('title').catch(() => null);
  const sizes = await A.locator('.font-size-row .font-size-option').count();
  check(cards === 11 && sel === 1 && sizes === 6, `theme cards ${cards}, selected ${sel} ("${selName}"), font-size options ${sizes}`);
  const themeB0 = await B.evaluate(() => document.documentElement.dataset.theme);
  await A.locator('.theme-grid .theme-card[title="Nord"]').click();
  const atOnce = await A.evaluate(() => document.documentElement.dataset.theme);
  const saved = await waitTrue(async () => (await vis(A.locator('.settings-header .save-status'))) && (await txt(A.locator('.settings-header .save-status'))) === 'Saved', 3000, 50);
  check(atOnce === 'nord' && saved, `right after the click data-theme "${atOnce}"; save-status "Saved" within 3 s: ${saved}; Nord card selected: ${await A.locator('.theme-card[title="Nord"].selected').count()}`);
  await sleep(1000);
  const themeB1 = await B.evaluate(() => document.documentElement.dataset.theme);
  check(themeB0 === themeB1, `B data-theme before "${themeB0}", after "${themeB1}"`);
  await A.locator('.font-size-row .font-size-option[title="17px"]').click();
  const fs = await A.evaluate(() => document.documentElement.style.fontSize);
  check(fs === '17px', `after "17px": html style.fontSize "${fs}"`);
  notes.push(`B html style.fontSize "${await B.evaluate(() => document.documentElement.style.fontSize)}"`);
});

await step(4, 'Profile: display name and bio', async (check) => {
  const status = A.locator('.settings-header .save-status');
  const t0 = Date.now();
  await A.fill('#display-name', 'The Boss');
  let savedAt = null;
  await waitTrue(async () => { if ((await vis(status)) && (await txt(status)) === 'Saved') { savedAt = Date.now() - t0; return true; } return false; }, 3000, 50);
  check(savedAt !== null, `save-status "Saved" ${savedAt !== null ? `after ${savedAt} ms` : 'not seen within 3 s'} (now "${await txt(status)}")`);
  const t1 = Date.now();
  const bossB = B.locator('.users-list .user-item', { hasText: 'The Boss' });
  const okB = await waitTrue(async () => (await bossB.count()) > 0, 3000, 50);
  check(okB, `B users-list shows "The Boss": ${okB} (${Date.now() - t1} ms after Saved); B rows: ${(await B.locator('.users-list .user-item').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')}`);
  await A.fill('#bio', 'hello');
  const counter = await txt(A.locator('.bio-counter'));
  check(counter === '5/150', `bio-counter "${counter}"`);
});

await step(5, 'Login link (ST-11 to ST-13)', async (check, notes) => {
  const sec = A.locator('[data-section="link"]');
  const present = sec.locator('.link-present'), absent = sec.locator('.link-absent'), status = sec.locator('.link-status'), value = sec.locator('.link-value');
  await waitTrue(async () => (await vis(present)) || (await vis(absent)), 3000);
  const wasPresent = await vis(present), wasAbsent = await vis(absent);
  notes.push(`on load: link-present visible ${wasPresent}, link-absent visible ${wasAbsent}; summary "${await txt(sec.locator('.link-summary'))}"`);
  if (wasAbsent) {
    await sec.locator('.link-create').click();
    const ok = await waitTrue(async () => (await vis(present)) && (await txt(value)).includes('/invite/'), 3000);
    check(ok && (await txt(status)) === 'Login link created', `after Create: link-present ${await vis(present)}, value "${await txt(value)}", status "${await txt(status)}"`);
  }
  const before = await txt(value);
  await sec.locator('.link-reveal').click();
  let after = await txt(value);
  if (!before.includes('••••')) {   // a new link shows in full already, so the first click hides it
    notes.push(`before reveal the value is in full ("${before}"); the first click gives "${after}"`);
    await sec.locator('.link-reveal').click();
    after = await txt(value);
  }
  check(!after.includes('••••') && after.includes('/invite/'), `reveal: "${before}" -> "${after}" (button title "${await sec.locator('.link-reveal').getAttribute('title')}")`);
  await sec.locator('.link-copy').click();
  const copied = await waitTrue(async () => (await sec.locator('.link-copy').getAttribute('title')) === 'Copied!', 1000, 25);
  const clip = await A.evaluate(() => navigator.clipboard.readText()).catch(e => `(read failed: ${e.message})`);
  check(copied, `copy: title "Copied!" ${copied}; clipboard "${clip}" equals the value ${clip === after}`);
  await sec.locator('.link-expiry').selectOption('7');
  const exp = await waitTrue(async () => (await vis(status)) && (await txt(status)).startsWith('Link expires '), 2000, 50);
  check(exp, `expiry 7 days: status "${await txt(status)}", select shows "${await sec.locator('.link-expiry option:checked').innerText().catch(() => '')}"`);
  const old = after;
  await sec.locator('.link-new').click();
  const renewed = await waitTrue(async () => (await txt(status)) === 'New link created. The old one no longer works.', 2000, 50);
  linkUrl = await txt(value);
  check(renewed && linkUrl !== old && !linkUrl.includes('••••'), `New Link: status "${await txt(status)}"; value "${linkUrl}" (changed ${linkUrl !== old})`);
  notes.push(`link-summary "${await txt(sec.locator('.link-summary'))}"; expiry select now "${await sec.locator('.link-expiry option:checked').innerText().catch(() => '')}"`);
});

await step(6, 'Secret code, retired (ST-14, AU-13)', async (check, notes) => {
  // boss is a fresh account and never had a code: the card stays hidden, and nothing can create one.
  const sec = A.locator('[data-section="passphrase"]');
  await sleep(500);   // the page's own passphrase request has answered (204) by now
  const hidden = !(await vis(sec));
  const status = await A.evaluate(async () => (await fetch('/api/account/passphrase', { method: 'POST', credentials: 'same-origin' })).status);
  check(hidden && status === 410, `Secret Code card visible ${!hidden}; POST /api/account/passphrase -> ${status} (410 expected)`);
  // The Login Link card carries the note that the link's code is typed on the login page instead.
  const note = await txt(A.locator('[data-section="link"] .link-present .form-hint'));
  check(note.includes('type the last part of the link'), `Login Link note: "${note}"`);
  notes.push(`link-summary now "${await txt(A.locator('[data-section="link"] .link-summary'))}"`);
});

await step(7, 'Sessions, mutes, time and date', async (check, notes) => {
  const items = A.locator('[data-section="sessions"] .session-item');
  await waitTrue(async () => (await items.count()) >= 1, 3000);
  const n = await items.count(), cur = await A.locator('[data-section="sessions"] .session-item.current').count();
  const badge = await txt(A.locator('[data-section="sessions"] .session-item.current .session-badge'));
  check(n >= 1 && cur === 1 && badge === 'This device', `session-items ${n}, current ${cur}, badge "${badge}"; rows: ${(await items.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')}`);

  const box = A.locator('#notification-settings');
  await box.locator('.server-seg .seg-btn', { hasText: 'Mute' }).click();
  const muted = await waitTrue(async () => (await vis(box.locator('.duration-row'))) && (await txt(box.locator('.mute-hint'))) === 'Muted until you turn notifications back on.', 2000, 50);
  check(muted, `Mute: duration-row visible ${await vis(box.locator('.duration-row'))}, mute-hint "${await txt(box.locator('.mute-hint'))}", modes visible ${await vis(box.locator('.modes'))}, duration selected "${await txt(box.locator('.duration-seg .seg-selected'))}"`);
  await box.locator('.server-seg .seg-btn', { hasText: 'Allow' }).click();
  const allowed = await waitTrue(async () => vis(box.locator('.modes')), 2000, 50);
  check(allowed && !(await vis(box.locator('.duration-row'))), `Allow: modes visible ${allowed}, duration-row visible ${await vis(box.locator('.duration-row'))}`);
  await box.locator('.room-seg .seg-btn', { hasText: 'Individual' }).click();
  const lobby = box.locator('.room-list .notif-item', { hasText: '#lobby' });
  const listed = await waitTrue(async () => (await vis(box.locator('.room-list'))) && (await lobby.count()) === 1, 2000, 50);
  const toggle = lobby.locator('.notif-item-toggle');
  const cls0 = listed ? await toggle.getAttribute('class') : null;
  check(listed && cls0.includes('muted'), `Individual: room-list visible ${await vis(box.locator('.room-list'))}, items "${(await box.locator('.room-list .notif-item').allInnerTexts()).join(' | ')}", #lobby toggle class "${cls0}"`);
  if (listed) {
    await toggle.click();
    const off = await waitTrue(async () => !(await toggle.getAttribute('class')).includes('muted') && (await toggle.getAttribute('aria-pressed')) === 'false', 2000, 50);
    check(off, `after toggle: class "${await toggle.getAttribute('class')}", aria-pressed "${await toggle.getAttribute('aria-pressed')}", title "${await toggle.getAttribute('title')}"`);
  }
  await box.scrollIntoViewIfNeeded();
  await A.screenshot({ path: SHOTS + '22-settings-mutes.png' });

  const time = A.locator('[data-section="time"]');
  await waitTrue(async () => (await time.locator('.clock-options .format-option').count()) > 0, 3000);
  const clocks = await time.locator('.clock-options .format-option').count(), orders = await time.locator('.order-options .format-option').count();
  check(clocks === 2 && orders === 3, `clock options ${clocks} (${(await time.locator('.clock-options .format-option').allInnerTexts()).join(' | ')}, selected "${await txt(time.locator('.clock-options .format-option.selected'))}"), order options ${orders} (${(await time.locator('.order-options .format-option').allInnerTexts()).join(' | ')})`);
  // The marked cards must describe what the page shows: the marked clock card and the clock have the same style
  // (AM/PM or not), and the marked order card is the order of the stored dateFormat.
  const is12 = t => /[AP]M/i.test(t);
  const orderOf = t => { if (/^\d{4}-/.test(t)) return 'ymd'; const [a] = t.split(/\D+/).map(Number); return a === new Date().getDate() ? 'dmy' : 'mdy'; };
  const format = await A.evaluate(() => fetch('/api/bootstrap').then(r => r.json()).then(d => d.user?.dateFormat ?? null));
  const markedClock = await txt(time.locator('.clock-options .format-option.selected')), markedOrder = await txt(time.locator('.order-options .format-option.selected'));
  const t0 = await txt(time.locator('.current-time'));
  check(is12(markedClock) === is12(t0) && orderOf(markedOrder) === (format ?? '').split('-')[0] && (format ?? '').split('-')[1] === (is12(t0) ? '12h' : '24h'),
    `stored dateFormat ${JSON.stringify(format)}; marked clock "${markedClock}", marked order "${markedOrder}" (${orderOf(markedOrder)}); current-time "${t0}"`);
  const other = time.locator('.clock-options .format-option:not(.selected)');
  const otherText = await txt(other);
  await other.click();
  const changed = await waitTrue(async () => is12(await txt(time.locator('.current-time'))) !== is12(t0), 2000, 50);
  const t1 = await txt(time.locator('.current-time'));
  check(changed, `other clock card ("${otherText}"): current-time "${t0}" -> "${t1}"; marked now "${await txt(time.locator('.clock-options .format-option.selected'))}"`);
  await time.locator('.time-plus').click();
  await waitTrue(async () => (await txt(time.locator('.current-time'))) !== t1, 2000, 50);
  const t2 = await txt(time.locator('.current-time'));
  const hourOf = s => { const m = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(s); if (!m) return null; let h = Number(m[1]) % 12; if (!m[3]) h = Number(m[1]); else if (/pm/i.test(m[3])) h += 12; return h; };
  const diff = (hourOf(t2) - hourOf(t1) + 24) % 24;
  check(diff === 1, `+1 hour: "${t1}" -> "${t2}" (hour difference ${diff}); detected "${await txt(time.locator('.detected'))}"`);
  await time.locator('.time-detect').click();
  await sleep(500);
  notes.push(`Detect: current-time "${await txt(time.locator('.current-time'))}", detected "${await txt(time.locator('.detected'))}"`);
});

await step(8, 'Verify page (AU-08, AU-09, AU-12, AU-14)', async (check, notes) => {
  ({ page: C } = await open('C'));
  // The login page's own check request tells what the server decided for "boss".
  const typeName = async name => {
    const answer = C.waitForResponse(r => r.url().includes(`/api/auth/check?username=${name}`), { timeout: 3000 }).then(r => r.json()).catch(() => null);
    await C.fill('.username-input', name);
    return answer;
  };
  await C.goto(BASE + '/');
  await C.waitForSelector('.page-login .username-input', { timeout: 10000 });
  let answer = await typeName('boss');
  await sleep(200);
  const hint = await vis(C.locator('.new-account-hint')), enabled = !(await C.locator('.username-form .join-button').isDisabled());
  check(!hint && enabled, `"boss": new-account-hint visible ${hint}, join enabled ${enabled}; server state "${answer?.state}"`);
  if (answer?.state === 'smart') {
    // AU-09: boss has a connected device on this address (A), so the name alone signs in. The verify page needs
    // smart login off for the account: the "Allow smart login" toggle in A's Settings.
    await C.press('.username-input', 'Enter');
    const smart = await atPath(C, '/lobby', 5000) && await C.locator('.status-username').count() > 0;
    notes.push(`smart login applies (AU-09): Enter -> ${pathOf(C)}, status-username "${await txt(C.locator('.status-username'))}"`);
    const out = await signOut(C);
    notes.push(`C signed out: ${out}, dialogs ${JSON.stringify(dialogs(8, 'C'))}`);
    const toggle = A.locator('[data-section="link"] .smart-login-toggle');
    const was = await toggle.isChecked();
    const patch = A.waitForResponse(r => r.url().endsWith('/api/account') && r.request().method() === 'PATCH', { timeout: 3000 }).catch(() => null);
    await A.locator('[data-section="link"] .smart-login .toggle-slider').click();
    const res = await patch;
    notes.push(`A "Allow smart login": checked ${was} -> ${await toggle.isChecked()} (PATCH ${res?.status()}); smart sign-in worked ${smart}`);
    if (!(await C.locator('.page-login').count())) { await C.goto(BASE + '/'); await C.waitForSelector('.page-login .username-input', { timeout: 10000 }); }
    answer = await typeName('boss');
    await sleep(200);
    notes.push(`"boss" again: server state "${answer?.state}", hint ${await vis(C.locator('.new-account-hint'))}, join enabled ${!(await C.locator('.username-form .join-button').isDisabled())}`);
  }
  await C.press('.username-input', 'Enter');
  const atVerify = await atPath(C, '/verify/boss', 3000);
  await C.waitForSelector('.page-verify', { timeout: 3000 }).catch(() => {});
  const h2 = await txt(C.locator('.page-verify h2'));
  check(atVerify && h2 === 'Welcome back, boss', `Enter -> ${pathOf(C)}, h2 "${h2}"`);
  if (!atVerify) return;
  await C.fill('.verify-input', 'nope');
  await C.press('.verify-input', 'Enter');
  const wrong = await waitTrue(async () => (await vis(C.locator('.page-verify .validation-error'))), 3000, 50);
  check(wrong && (await txt(C.locator('.page-verify .validation-error'))) === 'Wrong code', `wrong code: error "${await txt(C.locator('.page-verify .validation-error'))}", input class "${await C.locator('.verify-input').getAttribute('class')}"`);
  await C.screenshot({ path: SHOTS + '23-verify.png' });
  // AU-12: the code of the login link, typed as a person reads it off another screen: any case, any separators.
  const typed = linkUrl ? linkUrl.split('/invite/')[1].replace(/-/g, ' ').toUpperCase() : '';
  await C.fill('.verify-input', typed);
  await C.press('.verify-input', 'Enter');
  const inLobby = await atPath(C, '/lobby', 5000) && await C.locator('.status-username').first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  const who = await txt(C.locator('.status-username'));
  check(inLobby && /boss/i.test(who), `link code "${typed}": ${pathOf(C)}, status-username "${who}" (the display name of boss is "The Boss")`);
  const out = await signOut(C);
  check(out, `sign out C: ${pathOf(C)}, dialogs ${JSON.stringify(dialogs(8, 'C'))}`);
});

await step(9, 'Link page (AU-10)', async (check) => {
  if (!linkUrl) { check(false, 'no link URL from step 5'); return; }
  const target = BASE + new URL(linkUrl, BASE).pathname;
  await C.goto(target);
  const ok = await waitTrue(async () => (await txt(C.locator('.page-invite h2'))) === 'Welcome back, boss', 5000);
  const primary = C.locator('.page-invite .invite-button.primary');
  const label = await txt(primary);
  check(ok && label === 'Continue as boss' && pathOf(C).startsWith('/invite/'), `${linkUrl} -> h2 "${await txt(C.locator('.page-invite h2'))}", text "${await txt(C.locator('.invite-text'))}", button "${label}" (not signed in by opening: ${(await C.locator('.status-username').count()) === 0})`);
  await primary.click();
  const inLobby = await atPath(C, '/lobby', 5000) && await C.locator('.status-username').first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  check(inLobby, `Continue -> ${pathOf(C)}, status-username "${await txt(C.locator('.status-username'))}"`);
  const out = await signOut(C);
  check(out, `sign out C: ${pathOf(C)}, dialogs ${JSON.stringify(dialogs(9, 'C'))}`);
  await C.goto(BASE + '/invite/not-a-real-code');
  const bad = await waitTrue(async () => (await txt(C.locator('.page-invite h2'))) === 'This link no longer works', 5000);
  const sec = C.locator('.page-invite .invite-secondary');
  check(bad && (await vis(sec)) && (await txt(sec)) === 'Go to the login page', `bad code: h2 "${await txt(C.locator('.page-invite h2'))}", link "${await txt(sec)}" href ${await sec.getAttribute('href')}`);
});

await step(10, 'An account switch reaches the other tab of the device (AU-25)', async (check) => {
  const { ctx, page: E } = await open('E');
  await signIn(E, 'eva');
  const E2 = await ctx.newPage(); watchPage(E2, 'E2');
  await E2.goto(BASE + '/lobby'); await E2.waitForSelector('.message-input', { timeout: 10000 }); await sleep(500);
  await E.goto(BASE + new URL(linkUrl, BASE).pathname);
  const primary = E.locator('.page-invite .invite-button.primary');
  const asks = await waitTrue(async () => (await txt(primary)) === 'Switch to boss', 5000);
  const heading = await txt(E.locator('.page-invite h2'));
  await primary.click();
  const who = page => page.evaluate(async () => { const s = (await import('/js/store.js')).state; return { user: s.user?.username ?? null, connection: s.connection, path: location.pathname }; });
  const switched = await waitTrue(async () => (await who(E)).user === 'boss', 8000);
  check(asks && switched, `E: link page h2 "${heading}", button "Switch to boss" ${asks} -> after the click: ${JSON.stringify(await who(E))}`);
  const user = () => who(E2);
  const followed = await waitTrue(async () => (await user()).user === 'boss' && (await user()).connection === 'connected', 8000, 100);
  check(followed, `E2 (the other tab): ${JSON.stringify(await user())}`);
  await E2.fill('.message-input', 'from the other tab'); await E2.press('.message-input', 'Enter');
  const seen = await waitTrue(async () => B.evaluate(async () => (await import('/js/store.js')).state.open?.messages.some(m => m.text === 'from the other tab') ?? false), 5000, 100);
  const author = await B.evaluate(async () => (await import('/js/store.js')).state.open?.messages.find(m => m.text === 'from the other tab')?.username ?? null);
  check(seen && author === 'boss', `a send from the other tab is recorded as "${author}" (B at ${pathOf(B)} sees it: ${seen})`);
  await ctx.close();
});

await step(11, 'Admin: users and an invite (AD-04, AD-15, AD-16)', async (check, notes) => {
  await menu(A, 'admin');
  const ok = await atPath(A, '/admin', 3000);
  await A.waitForSelector('.page-admin', { timeout: 5000 }).catch(() => {});
  const navs = await A.locator('.page-admin .admin-sidebar .nav-item').count();
  const activeTab = await A.locator('.page-admin .nav-item.active').getAttribute('data-tab').catch(() => null);
  await A.waitForSelector('.page-admin .users-table tbody tr', { timeout: 5000 }).catch(() => {});
  const rows = (await A.locator('.page-admin .users-table tbody tr.clickable-row .user-info').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  const bot = await A.evaluate(() => fetch('/api/admin/bot').then(r => r.json()).then(b => b.username).catch(() => null));
  const has = name => rows.some(r => r.split(' ').includes(name));
  check(ok && navs === 10 && activeTab === 'users' && has('boss') && has('guest') && (bot ? has(bot) : rows.length >= 3),
    `path ${pathOf(A)}, .page-admin ${await A.locator('.page-admin').count()}, nav-items ${navs}, active "${activeTab}", frame present ${await A.locator('.chat-container').count()}; user rows: ${rows.join(' | ')} (bot "${bot}")`);
  const stats = await A.locator('.page-admin .theme-stats .theme-stat-card').count();
  check(stats === 11, `theme-stat-cards ${stats}`);
  notes.push(`no-persistence-note visible ${await vis(A.locator('.no-persistence-note'))}`);
  await A.screenshot({ path: SHOTS + '24-admin-users.png' });
  await A.locator('.page-admin .users-table tr.clickable-row', { hasText: 'boss' }).first().click();
  const detail = await waitTrue(async () => vis(A.locator('.page-admin .detail-row .user-detail-panel')), 2000, 50);
  await waitTrue(async () => (await A.locator('.page-admin .detail-row .detail-loading').count()) === 0, 3000, 50);
  check(detail, `boss row -> detail panel ${detail}: "${(await txt(A.locator('.page-admin .detail-row .user-detail-panel'))).slice(0, 160)}"`);

  await A.locator('.page-admin .nav-item[data-tab="invites"]').click();
  await A.waitForSelector('.page-admin .invite-create', { timeout: 5000 });
  const forText = await A.locator('.page-admin .invite-create select').first().locator('option:checked').innerText();
  await A.fill('.page-admin .invite-create input[placeholder="for Tom"]', 'for tom');
  await A.locator('.page-admin .invite-create .save-btn', { hasText: 'Create link' }).click();
  const made = await waitTrue(async () => (await txt(A.locator('.page-admin .save-result'))) === 'Invite created', 3000, 50);
  const row = A.locator('.page-admin tr', { hasText: 'for tom' });
  await waitTrue(async () => (await row.count()) > 0, 3000, 50);
  inviteUrl = await txt(row.locator('.link-code'));
  check(made && inviteUrl.includes('/invite/'), `For "${forText}", note "for tom": save-result "${await txt(A.locator('.page-admin .save-result'))}"; open-invite row "${(await txt(row)).slice(0, 120)}"; URL "${inviteUrl}"; header "${await txt(A.locator('.page-admin .section-header').first())}"`);
  if (!inviteUrl.includes('/invite/')) return;

  await C.goto(BASE + new URL(inviteUrl, BASE).pathname);
  const invited = await waitTrue(async () => (await txt(C.locator('.page-invite h2'))).startsWith("You're invited to"), 5000);
  check(invited, `C h2 "${await txt(C.locator('.page-invite h2'))}", text "${await txt(C.locator('.invite-text'))}"`);
  await C.locator('.invite-input').pressSequentially('tom', { delay: 30 });
  const join = C.locator('.invite-button.join');
  const enabled = await waitTrue(async () => !(await join.isDisabled()), 1000, 25);
  check(enabled, `"tom": Join enabled ${enabled}`);
  await join.click();
  const inLobby = await atPath(C, '/lobby', 5000) && await C.locator('.status-username').first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  const who = await txt(C.locator('.status-username'));
  check(inLobby && who === 'tom', `Join -> ${pathOf(C)}, status-username "${who}"`);
});

// A registration toggle on the admin Settings tab. Returns the state before and after, and the PUT status.
async function adminToggle(label) {
  const row = A.locator('.page-admin .registration-settings .toggle-row', { hasText: label });
  const input = row.locator('input[type=checkbox]');
  const before = await input.isChecked();
  const put = A.waitForResponse(r => r.url().endsWith('/api/admin/settings') && r.request().method() === 'PUT', { timeout: 3000 }).catch(() => null);
  await row.locator('.toggle-slider').click();
  const res = await put;
  return { before, after: await input.isChecked(), status: res?.status() ?? 'no PUT' };
}

await step(12, 'Admin settings: registration (AD-10, AD-11, AU-05)', async (check, notes) => {
  await A.locator('.page-admin .nav-item[data-tab="settings"]').click();
  await A.waitForSelector('.page-admin .registration-settings .toggle-row', { timeout: 5000 });
  const regRows = (await A.locator('.page-admin .registration-settings').first().locator('.toggle-label').allInnerTexts()).map(t => t.trim());
  check(regRows.length === 3, `Registration toggles: ${JSON.stringify(regRows)}`);
  const close = await adminToggle('Close registration');
  check(!close.before && close.after && String(close.status).startsWith('2'), `Close registration: ${close.before} -> ${close.after}, PUT ${close.status}`);
  ({ page: D } = await open('D'));
  await D.goto(BASE + '/');
  await D.waitForSelector('.page-login .username-input', { timeout: 10000 });
  const t0 = Date.now();
  await D.fill('.username-input', 'newbie');
  const closed = await waitTrue(async () => vis(D.locator('.closed-message')), 1500, 25);
  check(closed && await D.locator('.username-form .join-button').isDisabled(), `D "newbie": closed-message ${closed} after ${Date.now() - t0} ms ("${(await txt(D.locator('.closed-message'))).slice(0, 60)}"), join disabled ${await D.locator('.username-form .join-button').isDisabled()}`);
  const reopen = await adminToggle('Close registration');
  check(reopen.before && !reopen.after, `Close registration off: ${reopen.before} -> ${reopen.after}, PUT ${reopen.status}`);
  const approval = await adminToggle('Require approval');
  check(!approval.before && approval.after, `Require approval on: ${approval.before} -> ${approval.after}, PUT ${approval.status}`);
  await D.fill('.username-input', 'pending1');
  const ready = await waitTrue(async () => !(await D.locator('.username-form .join-button').isDisabled()), 2000, 25);
  const signin = D.waitForResponse(r => r.url().endsWith('/api/auth/signin'), { timeout: 3000 }).then(r => `${r.status()} ${r.statusText()}`).catch(() => 'none');
  const boot = D.waitForResponse(r => r.url().endsWith('/api/bootstrap'), { timeout: 3000 }).then(async r => `${r.status()} user ${JSON.stringify((await r.json().catch(() => ({}))).user?.username ?? null)}`).catch(() => 'none');
  await D.press('.username-input', 'Enter');
  notes.push(`D POST /api/auth/signin -> ${await signin}; then GET /api/bootstrap -> ${await boot}`);
  const waiting = await waitTrue(async () => (await vis(D.locator('.waiting-message'))) && (await txt(D.locator('.waiting-name'))) === 'pending1', 3000, 50);
  check(ready && waiting, `D "pending1" + Enter: join enabled ${ready}; waiting-message ${waiting} ("${(await txt(D.locator('.waiting-message'))).slice(0, 90)}")`);
  const t1 = Date.now();
  const item = A.locator('.page-admin .pending-item', { hasText: 'pending1' });
  const listed = await waitTrue(async () => (await item.count()) > 0, 3000, 50);
  check(listed, `A Pending Requests shows pending1: ${listed} after ${Date.now() - t1} ms ("${await txt(A.locator('.page-admin .pending-list'))}")`);
  if (listed) {
    await item.locator('.approve-btn').click();
    const t2 = Date.now();
    const landed = await atPath(D, '/lobby', 5000) && await D.locator('.status-username').first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
    check(landed, `Approve -> D at ${pathOf(D)} after ${Date.now() - t2} ms, status-username "${await txt(D.locator('.status-username'))}"; A pending list left: ${await A.locator('.page-admin .pending-item').count()}`);
    if (!landed) notes.push(`D login page now: waiting-message ${await vis(D.locator('.waiting-message'))}, error ${await vis(D.locator('.page-login .validation-error')) ? `"${await txt(D.locator('.page-login .validation-error'))}"` : '(hidden)'}, join disabled ${await D.locator('.username-form .join-button').isDisabled()}`);
  }
  const back = await adminToggle('Require approval');
  check(back.before && !back.after, `Require approval off: ${back.before} -> ${back.after}, PUT ${back.status}`);
});

await step(13, 'Admin: bot, debug, logs, media, GIFs, diagnostics, visitors', async (check, notes) => {
  const nav = tab => A.locator(`.page-admin .nav-item[data-tab="${tab}"]`).click();
  await nav('bot');
  const username = A.locator('.page-admin .bot-settings input.disabled');
  await waitTrue(async () => (await username.inputValue()) !== '', 3000, 50);   // the GET fills the form; typing first would be overwritten
  const name = A.locator('.page-admin .bot-settings .form-group', { hasText: 'Display Name' }).locator('input');
  const oldName = await name.inputValue();
  await name.fill('Helper');
  await A.locator('.page-admin .bot-settings .save-btn').click();
  const saved = await waitTrue(async () => (await txt(A.locator('.page-admin .bot-settings .save-result'))) === 'Saved!', 3000, 50);
  check(saved, `bot "${await username.inputValue()}": display name "${oldName}" -> "Helper", save-result "${await txt(A.locator('.page-admin .bot-settings .save-result'))}"`);

  await nav('debug');
  await A.fill('.page-admin .debug-form input[type=number]', '15');
  await A.locator('.page-admin .generate-btn').click();
  const gen = await waitTrue(async () => (await txt(A.locator('.page-admin .debug-result'))) !== '', 10000, 100);
  const genText = await txt(A.locator('.page-admin .debug-result'));
  check(gen && genText === 'Generated 15 messages spread across 168h', `debug-result "${genText}"`);

  for (const tab of ['logs', 'media']) {
    await nav(tab);
    const ok = await waitTrue(async () => (await txt(A.locator('.page-admin .tab-host .log-empty'))) === 'Not available without persistence.', 3000, 50);
    check(ok, `${tab}: log-empty "${await txt(A.locator('.page-admin .tab-host .log-empty'))}"`);
  }

  await nav('gifs');
  await waitTrue(async () => (await A.locator('.page-admin .media-stats .media-stat-card').count()) > 0, 5000, 50);
  const cards = (await A.locator('.page-admin .media-stats .media-stat-card').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  const libEmpty = A.locator('.page-admin .gif-library .gif-lib-empty');
  await waitTrue(async () => vis(libEmpty), 3000, 50);
  const libText = await txt(libEmpty), tableNote = await txt(A.locator('.page-admin .tab-host .log-empty').last());
  check(cards.length > 0 && libText.startsWith('The server library is empty') && tableNote === 'No GIFs in the library yet.', `stat cards ${JSON.stringify(cards)}; library "${libText}"; table note "${tableNote}"`);

  await nav('diagnostics');
  await waitTrue(async () => (await A.locator('.page-admin .diag-stats .media-stat-card').count()) > 0, 5000, 50);
  const dcards = (await A.locator('.page-admin .diag-stats .media-stat-card').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
  const sessCard = A.locator('.page-admin .diag-chart-card', { hasText: 'Sessions — presence truth table' });
  const users = (await sessCard.locator('tbody tr td:first-child').allInnerTexts()).map(t => t.trim());
  check(dcards.length > 0 && ['boss', 'guest', 'tom'].every(u => users.includes(u)), `diag stat cards ${JSON.stringify(dcards)}; session rows ${JSON.stringify(users)}`);
  const transports = (await sessCard.locator('tbody tr td:nth-child(3)').allInnerTexts()).map(t => t.trim());
  check(transports.length > 0 && transports.every(t => t === 'WS' || t === '⚠ Fallback'), `sessions Transport column ${JSON.stringify(transports)}; latency table ${JSON.stringify((await A.locator('.page-admin .diag-chart-card', { hasText: 'Latency by user' }).locator('tbody tr td:nth-child(2)').allInnerTexts()).map(t => t.trim()))}`);
  const t0 = Date.now();
  const drawn = await waitTrue(async () => A.evaluate(() => { const c = [...document.querySelectorAll('.page-admin .diag-charts canvas')]; return c.length === 3 && c.every(x => x.clientHeight > 0) && !!window.Chart && c.every(x => window.Chart.getChart(x)); }), 5000, 100);
  const canv = await A.evaluate(() => ({ chart: !!window.Chart, version: window.Chart?.version ?? null, sizes: [...document.querySelectorAll('.page-admin canvas')].map(x => `${x.id} ${x.clientWidth}x${x.clientHeight} chart=${!!window.Chart?.getChart?.(x)}`) }));
  check(drawn, `charts within 5 s: ${drawn} (${Date.now() - t0} ms); Chart.js loaded ${canv.chart} ${canv.version ?? ''}; canvases ${JSON.stringify(canv.sizes)}`);
  if (!canv.chart) notes.push(`chart.js requests: ${stepLogs(13).filter(l => l.text.includes('chart')).map(l => l.kind + ' ' + l.text).join(' ; ') || '(none logged)'}`);
  await A.screenshot({ path: SHOTS + '25-admin-diagnostics.png' });

  await nav('visitors');
  const vok = await waitTrue(async () => (await txt(A.locator('.page-admin .tab-host .log-empty'))) === 'Not available without persistence.', 3000, 50);
  check(vok, `visitors: log-empty "${await txt(A.locator('.page-admin .tab-host .log-empty'))}"`);
});

await step(14, 'Create Channel and Channel Settings (AD-29 to AD-35)', async (check) => {
  await A.locator('.page-admin .back-button').click();
  const lobby = await atPath(A, '/lobby', 3000);
  await A.waitForSelector('.rooms-list .room-item', { timeout: 5000 });
  check(lobby, `admin back -> ${pathOf(A)}`);
  await A.locator('.room-item.add-room').click();
  const atNew = await atPath(A, '/channel/new', 3000);
  await A.waitForSelector('.page-channel', { timeout: 3000 }).catch(() => {});
  const heading = await txt(A.locator('.page-channel .page-heading')), title = await txt(A.locator('.dm-header-title h3'));
  check(atNew && heading === 'Create Channel' && title === 'New Channel', `path ${pathOf(A)}, .page-channel ${await A.locator('.page-channel').count()}, heading "${heading}", header title "${title}"`);
  const save = A.locator('.page-channel .save-button'), hint = A.locator('.page-channel .name-hint');
  await A.fill('#channel-name', 'Dev Talk');
  const red = await hint.evaluate(e => e.style.color), redComputed = await hint.evaluate(e => getComputedStyle(e).color);
  check(red !== '' && await save.isDisabled(), `"Dev Talk": hint style.color "${red}" (computed ${redComputed}), save disabled ${await save.isDisabled()}`);
  await A.fill('#channel-name', 'devtalk');
  check(!(await save.isDisabled()) && (await hint.evaluate(e => e.style.color)) === '', `"devtalk": save enabled ${!(await save.isDisabled())}, hint color "${await hint.evaluate(e => e.style.color)}", save label "${await txt(save)}"`);
  const card = A.locator('.page-channel .permission-card[data-permission="adminOnly"]');
  await card.click();
  check((await card.getAttribute('class')).includes('selected'), `Admin Only card class "${await card.getAttribute('class')}"`);
  await A.locator('.page-channel .history-limit').selectOption({ label: '1 Week' });
  await save.click();
  const created = await waitTrue(async () => /^\/room\/[0-9a-f-]{36}$/.test(pathOf(A)), 5000);
  roomId = created ? pathOf(A).split('/')[2] : null;
  const roomB = B.locator('.rooms-list .room-item', { hasText: 'devtalk' });
  const t0 = Date.now();
  const listedB = await waitTrue(async () => (await roomB.count()) > 0, 3000, 50);
  check(created && listedB, `Save -> ${pathOf(A)}; B lists devtalk ${listedB} after ${Date.now() - t0} ms; B rooms: ${(await B.locator('.rooms-list .room-item').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')}`);
  if (!roomId) return;

  await B.goto(`${BASE}/room/${roomId}`);
  await B.waitForSelector('.messages-container', { timeout: 10000 });
  const ro = await waitTrue(async () => vis(B.locator('.readonly-bar')), 3000, 50);
  check(ro && !(await vis(B.locator('.message-input-container'))), `B /room/${roomId}: readonly-bar visible ${ro} ("${await txt(B.locator('.readonly-bar'))}"), message-input-container visible ${await vis(B.locator('.message-input-container'))}`);

  const rowA = A.locator('.rooms-list .room-item', { hasText: 'devtalk' });
  await rowA.hover();
  await rowA.locator('.room-settings').click();
  const atSettings = await atPath(A, `/channel/${roomId}/settings`, 3000);
  await A.waitForSelector('.page-channel .reorder-item', { timeout: 3000 }).catch(() => {});
  const nameVal = await A.inputValue('#channel-name');
  const order = A.locator('.page-channel .reorder-list .reorder-item');
  const n = await order.count();
  check(atSettings && nameVal === 'devtalk' && n === 2, `gear -> ${pathOf(A)}, name "${nameVal}", heading "${await txt(A.locator('.page-channel .page-heading'))}", header "${await txt(A.locator('.dm-header-title h3'))}", order items ${n} (${(await order.allInnerTexts()).map(t => t.trim()).join(' | ')}), history "${await A.locator('.history-limit').inputValue()}", admin-only selected ${(await A.locator('.permission-card[data-permission="adminOnly"]').getAttribute('class')).includes('selected')}`);
  await order.filter({ hasText: 'devtalk' }).locator('.reorder-btn.up').click();
  const t1 = Date.now();
  const first = await waitTrue(async () => (await txt(B.locator('.rooms-list .room-item').first())).includes('devtalk'), 2000, 50);
  check(first, `Move up: B's first room "${await txt(B.locator('.rooms-list .room-item').first())}" after ${Date.now() - t1} ms; A order now ${(await order.allInnerTexts()).map(t => t.trim()).join(' | ')}`);
  await B.evaluate(async () => (await import('/js/router.js')).navigate('/lobby'));
  await sleep(400);
  const where = await B.evaluate(async () => { const s = (await import('/js/store.js')).state; return { open: s.open?.channelId, lobby: s.rooms.find(r => r.isLobby)?.id, first: s.rooms[0]?.name, title: document.querySelector('.dm-header-title h3')?.textContent?.trim() }; });
  check(where.first === 'devtalk' && !!where.lobby && where.open === where.lobby, `/lobby with devtalk first in the sidebar opens "${where.title}" (the marked lobby: ${where.open === where.lobby}, first room "${where.first}") (SH-43)`);
  await A.screenshot({ path: SHOTS + '26-channel-settings.png' });
  const del = A.locator('.page-channel .delete-button');
  await del.click();
  const armed = await txt(del);
  await del.click();
  const gone = await atPath(A, '/lobby', 3000);
  const t2 = Date.now();
  const goneB = await waitTrue(async () => (await roomB.count()) === 0, 3000, 50);
  check(gone && goneB, `Delete: first click "${armed}"; A -> ${pathOf(A)}; B devtalk gone ${goneB} after ${Date.now() - t2} ms; B at ${pathOf(B)}, rooms ${(await B.locator('.rooms-list .room-item').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | ')}`);
});

await step(15, 'Keyboard: the sidebar rows and + take focus and Enter (SH-26, SH-32, IB-29, IB-67)', async (check) => {
  await A.waitForSelector('.message-input', { timeout: 5000 });
  const active = () => A.evaluate(() => { const a = document.activeElement; return `${a.tagName.toLowerCase()}.${[...a.classList].join('.')}`; });
  await A.focus('.message-input');
  await A.keyboard.press('Shift+Tab');
  const before = await active();   // + stands before the input in the DOM
  await A.focus('.message-input');
  const seen = [];
  const hit = s => seen.some(d => d.includes(s));
  for (let i = 0; i < 40 && !(hit('room-item') && hit('user-item')); i++) { await A.keyboard.press('Tab'); seen.push(await active()); }
  check(before.includes('image-upload-button') && hit('room-item') && hit('user-item'), `Shift+Tab from the input: "${before}"; Tab (${seen.length}): ${seen.join(' > ')}`);
  await A.locator('.users-list .user-item:not(.current-user)').first().focus();
  await A.keyboard.press('Enter');
  const dm = await waitTrue(async () => pathOf(A).startsWith('/dm/'), 3000);
  check(dm, `Enter on a person row -> ${pathOf(A)}`);
  await A.locator('.rooms-list .room-item').first().focus();
  await A.keyboard.press('Enter');
  const lobby = await atPath(A, '/lobby', 3000);
  check(lobby, `Enter on the lobby row -> ${pathOf(A)}`);
  await A.locator('.rooms-list .room-item .room-settings').first().focus();
  await A.keyboard.press('Enter');
  const gear = await waitTrue(async () => /^\/channel\/[0-9a-f-]{36}\/settings$/.test(pathOf(A)), 3000);
  check(gear, `Enter on the gear -> ${pathOf(A)} (not the room under it)`);
  await A.evaluate(async () => (await import('/js/router.js')).navigate('/lobby'));
  await A.waitForSelector('.message-input', { timeout: 5000 });
  await A.locator('.image-upload-button').focus();
  await A.keyboard.press('Enter');
  const item = await A.waitForSelector('.more-menu [data-action="files"]', { timeout: 3000 }).catch(() => null);   // + opens the attach menu since the voice messages (IB-67); the chooser is its first item
  const [chooser] = await Promise.all([A.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), item ? item.click() : Promise.resolve()]);
  check(!!item && !!chooser && chooser.isMultiple(), `Enter on + opens the attach menu: ${!!item}; "Photo or video" opens the file chooser: ${!!chooser}, multiple ${chooser?.isMultiple()}`);
});

await step(16, 'Phone, 20 px text: the choices of a notification row wrap instead of clipping (ST-10, ST-18)', async (check) => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  watchContext(ctx, 'P');
  const P = await ctx.newPage(); watchPage(P, 'P');
  await signIn(P, 'phoneuser');
  await menu(P, 'settings');
  await P.waitForSelector('.dm-seg .seg-btn', { timeout: 5000 });
  await P.locator('.font-size-row .font-size-option[title="20px"]').click();
  await sleep(300);
  const fit = await P.evaluate(() => [...document.querySelectorAll('.dm-seg, .room-seg')].map(seg => {
    const box = seg.getBoundingClientRect();
    const btns = [...seg.querySelectorAll('.seg-btn')].map(b => b.getBoundingClientRect());
    return { n: btns.length, width: Math.round(box.width), lines: new Set(btns.map(b => Math.round(b.top))).size, inside: btns.every(b => b.right <= box.right + 1 && b.left >= box.left - 1), rights: btns.map(b => Math.round(b.right)) };
  }));
  await P.locator('.dm-seg').scrollIntoViewIfNeeded().catch(() => {});
  await P.screenshot({ path: SHOTS + '27-phone-mute-20px.png' });
  check(fit.length === 2 && fit.every(f => f.n === 3 && f.inside), `at 20 px on 320 px: ${JSON.stringify(fit)}`);
  await ctx.close();
  // On a 375 px phone the three choices share one line at the largest text size (ST-26); only 320 px may wrap.
  const ctx375 = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  watchContext(ctx375, 'Q');
  const Q = await ctx375.newPage(); watchPage(Q, 'Q');
  await signIn(Q, 'phoneuser');
  await menu(Q, 'settings');
  await Q.waitForSelector('.dm-seg .seg-btn', { timeout: 5000 });
  await sleep(300);
  const oneLine = await Q.evaluate(() => [...document.querySelectorAll('.dm-seg, .room-seg')].map(seg => {
    const box = seg.getBoundingClientRect();
    const btns = [...seg.querySelectorAll('.seg-btn')].map(b => b.getBoundingClientRect());
    return { n: btns.length, width: Math.round(box.width), lines: new Set(btns.map(b => Math.round(b.top))).size, inside: btns.every(b => b.right <= box.right + 1 && b.left >= box.left - 1), slack: Math.round(box.width - btns.reduce((s, b) => s + b.width, 0)) };
  }));
  await Q.screenshot({ path: SHOTS + '27-phone-mute-20px-375.png' });
  check(oneLine.length === 2 && oneLine.every(f => f.n === 3 && f.inside && f.lines === 1), `at 20 px on 375 px: ${JSON.stringify(oneLine)}`);
  await ctx375.close();
});

// The link shows in the Favorites tab even when it is empty (gif-picker.js folderedView, manage: true). A plain href
// loaded the whole app again; the marker on window survives only an in-place navigation.
await step(17, '"Manage your GIFs in Settings" opens Settings in place, at My GIFs (ST-01)', async (check) => {
  await A.evaluate(async () => (await import('/js/router.js')).navigate('/lobby'));
  await A.waitForSelector('.message-input', { timeout: 5000 });
  await A.evaluate(() => { window.sameDocument = true; });
  await A.click('.gif-toggle-button');
  await A.locator('.gif-sidebar [data-tab="favorites"]').click();
  const link = A.locator('.gif-manage-link');
  await link.waitFor({ timeout: 5000 });
  await link.click();
  const settings = await atPath(A, '/settings', 5000);
  await A.waitForSelector('[data-section="gifs"]', { state: 'visible', timeout: 5000 }).catch(() => null);
  await sleep(500);   // the section pin holds it in view while the page fills
  const same = await A.evaluate(() => window.sameDocument === true);
  const inView = await A.evaluate(() => { const r = document.querySelector('[data-section="gifs"]')?.getBoundingClientRect(); return !!r && r.top < innerHeight && r.bottom > 0; });
  check(settings && same && inView, `path ${pathOf(A)}${A.url().includes('#my-gifs') ? '#my-gifs' : ''}, same document ${same}, My GIFs in view ${inView}`);
});

await step(18, 'Sign out A', async (check) => {
  const out = await signOut(A);
  check(out, `A -> ${pathOf(A)}, .page-login ${await A.locator('.page-login').count()}, dialogs ${JSON.stringify(dialogs(18, 'A'))}`);
});

console.log('\n==== WRITE RESPONSES (status codes per request) ====');
for (const [k, v] of writes) console.log(`${k}: ${[...new Set(v)].join(',')} x${v.length}`);
await finish(browser, server);
