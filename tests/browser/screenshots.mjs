// Regenerates the screenshots of the product spec (docs/spec/img/). Each image belongs to one spec page, and its
// caption there says what the picture must show. The script seeds people, rooms and messages on a throwaway
// server, builds the state of each caption and overwrites the image. Run: npm run screenshots (see README.md).
// A step that cannot build its state fails and leaves the old image in place.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, REPO, sleep, waitTrue, row, step, finish, startServer, signIn, watchContext, watchPage, fixture, writePng, sendFiles as pickAndSend, api } from './lib.mjs';

// offline-phone-pending: Playwright applies setOffline to the service worker only with this variable (see offline.mjs).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const OUT = path.join(REPO, 'docs', 'spec', 'img');
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const THEME = 'light';   // Daylight: every image of the spec uses it

// ---- the pictures, drawn here so the run needs no image files ----

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
// The height of a ridge line at x; both run 0..1, y from the top.
function ridge(points, x) {
  for (let i = 1; i < points.length; i++) {
    if (x > points[i][0]) continue;
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return points.at(-1)[1];
}
function paint(width, height, colour) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(colour(x / width, y / height, width / height), (y * width + x) * 3);
  return rgb;
}

const BACK = [[0, .52], [.15, .38], [.3, .47], [.48, .27], [.64, .43], [.8, .33], [1, .46]];
const MIDDLE = [[0, .66], [.18, .5], [.36, .62], [.55, .45], [.74, .58], [1, .52]];
const FRONT = [[0, .78], [.28, .71], [.5, .74], [.78, .68], [1, .73]];
// The view from the top: sky, sun, three ridges and a path.
function view(u, v, aspect) {
  if (v >= ridge(FRONT, u)) return Math.abs(u - .5) < (v - .72) * .45 ? [140, 122, 91] : [46, 74, 59];
  if (v >= ridge(MIDDLE, u)) return [77, 106, 141];
  if (v >= ridge(BACK, u)) return [127, 147, 181];
  const sky = mix([106, 160, 220], [245, 214, 168], v / .55);
  const d = Math.hypot((u - .7) * aspect, v - .18);
  return d < .08 ? [255, 241, 204] : d < .11 ? mix([255, 241, 204], sky, (d - .08) / .03) : sky;
}

const PEAKS = [[0, .62], [.3, .22], [.45, .36], [.62, .12], [1, .44]];
// The hut: sky, two peaks, a meadow and a house with a lit window.
function hut(u, v) {
  if (v >= .4 && v < .55 && Math.abs(u - .7) <= (v - .4) * 1.1) return [62, 43, 35];
  if (u >= .61 && u < .67 && v >= .63 && v < .79) return [72, 45, 30];
  if (u >= .73 && u < .79 && v >= .6 && v < .68) return [255, 214, 110];
  if (u >= .57 && u < .83 && v >= .55 && v < .79) return [122, 74, 45];
  if (v >= .62) return mix([92, 142, 80], [64, 108, 56], (v - .62) / .38);
  if (v >= ridge(PEAKS, u)) return [138, 155, 180];
  return mix([95, 150, 215], [175, 205, 235], v / .62);
}

// A one-frame GIF (GIF89a, a global palette, LZW as in omggif). The GIF library accepts only .gif and .webp
// without ffmpeg, so the favourite of the pickers needs a real GIF file.
function writeGif(file, width, height, rgb) {
  const palette = [], index = new Map(), pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const key = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    if (!index.has(key)) {
      if (index.size === 256) throw new Error('a GIF holds at most 256 colours');
      index.set(key, index.size); palette.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    }
    pixels[i] = index.get(key);
  }
  let bits = 1;
  while (1 << bits < index.size) bits++;
  const table = Buffer.alloc(3 << bits); Buffer.from(palette).copy(table);
  const minCode = Math.max(2, bits);
  const data = lzw(pixels, minCode);
  const blocks = [];
  for (let i = 0; i < data.length; i += 255) { const part = data.subarray(i, i + 255); blocks.push(Buffer.from([part.length]), part); }
  const u16 = n => Buffer.from([n & 0xff, n >> 8]);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('GIF89a'), u16(width), u16(height), Buffer.from([0x80 | (bits - 1) << 4 | (bits - 1), 0, 0]), table,
    Buffer.from([0x2c]), u16(0), u16(0), u16(width), u16(height), Buffer.from([0, minCode]), ...blocks, Buffer.from([0, 0x3b]),
  ]));
  return file;
}

function lzw(pixels, minCode) {
  const out = [];
  const clear = 1 << minCode, end = clear + 1;
  let size = minCode + 1, next = end + 1, codes = new Map(), bitBuffer = 0, bitCount = 0;
  const emit = code => { bitBuffer |= code << bitCount; bitCount += size; while (bitCount >= 8) { out.push(bitBuffer & 0xff); bitBuffer >>>= 8; bitCount -= 8; } };
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const key = prefix << 8 | pixels[i];
    if (codes.has(key)) { prefix = codes.get(key); continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); next = end + 1; size = minCode + 1; codes = new Map(); }
    else { if (next >= 1 << size) size++; codes.set(key, next++); }   // the decoder grows the code one entry later; this order matches it
    prefix = pixels[i];
  }
  emit(prefix); emit(end);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Buffer.from(out);
}

const VIEW = writePng(fixture('the-view.png'), 400, 300, paint(400, 300, view));
const HUT = writePng(fixture('the-hut.png'), 400, 300, paint(400, 300, hut));
// Coarse colour steps: few colours for the palette, and the pixel look of a GIF.
const GIF = writeGif(fixture('ridge.gif'), 160, 120, paint(160, 120, (u, v, a) => view(u, v, a).map(c => Math.min(255, Math.round(c / 24) * 24))));

// ---- helpers ----

const need = (cond, text) => { if (!cond) throw new Error(text); };
// The quick reactions of the action bar carry the emoji as their title (MR-41). Written as code points: the
// heart needs its variation selector to match the server's default.
const HEART = '\u2764\uFE0F', LAUGH = '\u{1F602}', THUMBS = '\u{1F44D}';
// The third row from the end, the first one the input box pictures show.
const thirdLast = async page => { const rows = page.locator('.messages-container .message-group:not(.system-message)'); return rows.nth((await rows.count()) - 3); };
const text = async loc => ((await loc.first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
const visible = loc => loc.first().isVisible().catch(() => false);

const people = {};   // username -> { ctx, page }
async function open(name, options = DESKTOP) {
  const ctx = await browser.newContext(options);
  watchContext(ctx, name);
  const page = await ctx.newPage(); watchPage(page, name);
  return { ctx, page };
}

const settled = (page, needle, ms = 10000) => waitTrue(async () => {
  const r = row(page, needle);
  return (await r.count()) > 0 && !(await r.last().getAttribute('class')).includes('pending');
}, ms);

async function typeAndSend(page, line) {
  await page.fill('.message-input', line);
  await page.press('.message-input', 'Enter');
  need(await settled(page, line), `"${line}" not confirmed`);
}

// The composer's file input, as a person picks files: one message, one image per file.
async function sendFiles(page, files) {
  const before = await page.locator('.message-group:not(.pending) .image-gallery').count();
  await pickAndSend(page, files);
  need(await waitTrue(async () => (await page.locator('.message-group:not(.pending) .image-gallery').count()) > before, 30000, 200), 'the image message did not arrive');
}

// A click on the quick reaction of the row's action bar. Dispatched, not clicked with the pointer: a hub event
// redraws the row under the pointer, and the hover of the bar then comes and goes. The pictures need no hover here.
// The quick reactions exist only once a pointer has entered the row (message.js fillQuick), so a pointerover first.
async function react(page, needle, emoji) {
  const r = row(page, needle).last();
  const total = () => r.locator('.reaction-count').evaluateAll(cs => cs.reduce((n, c) => n + Number(c.textContent), 0));   // a second person on a pill adds no pill
  const before = await total();
  await r.dispatchEvent('pointerover');
  await r.locator(`.message-actions .quick-reaction[title="${emoji}"]`).dispatchEvent('click');
  need(await waitTrue(async () => (await total()) > before, 5000), `no reaction ${emoji} on "${needle}"`);
}

// Waits for the fonts and for every image in the viewport, so no picture shows a half-loaded row.
async function settle(page, ms = 400) {
  await page.evaluate(() => document.fonts?.ready.then(() => true));
  await waitTrue(() => page.evaluate(() => [...document.images].filter(i => {
    const r = i.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }).every(i => i.complete)), 8000, 100);
  await sleep(ms);
}

async function box(loc) {
  const b = await loc.first().boundingBox();
  need(b, 'no element for the clip');
  return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
}
// A clip from edges, kept inside the viewport.
function clip(page, { x0, y0, x1, y1 }) {
  const vp = page.viewportSize();
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(vp.width, Math.ceil(x1)); y1 = Math.min(vp.height, Math.ceil(y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const written = [];
async function save(page, name, area = null) {
  await page.screenshot({ path: path.join(OUT, name), ...(area ? { clip: area } : {}) });
  written.push(name);
}

const list = page => page.locator('.messages');
const toBottom = async page => { await list(page).evaluate(e => { e.scrollTop = e.scrollHeight; }); await sleep(300); };
const column = page => box(page.locator('.messages-container'));   // the conversation column, header excluded
async function quiet(page) { await page.mouse.move(1180, 780); await sleep(150); }   // the empty foot of the sidebar: no hover state

// Escape closes the top layer (GEN-17). A step that failed halfway must not leave a picker or a menu over the next one.
async function closeLayers(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => !!document.querySelector('.message-input-container[data-picker], .status-dropdown, .more-menu, .image-modal, .emoji-picker-wrapper'));
    if (!open) return;
    await page.keyboard.press('Escape');
    await sleep(250);
  }
}

// One picture: a step of the report. On a failure the note carries the lines of Playwright's call log that say why.
function picture(n, name, page, fn) {
  return step(n, name, async (check, notes) => {
    const p = page();
    need(p && !p.isClosed(), 'no page');
    await closeLayers(p);
    try { await fn(p, check, notes); }
    catch (e) {
      const why = e.message.replace(/\x1b\[\d+m/g, '').split('\n').filter(l => /intercepts|not visible|not stable|outside|detached|waiting for/.test(l)).slice(-3).map(l => l.trim());
      if (why.length) notes.push('call log: ' + why.join(' / '));
      throw e;
    }
  });
}

// ---- the run ----

const server = await startServer();
const browser = await chromium.launch();
const rooms = {};
let bobJoinedAt = 0;

await step(1, 'People, rooms and the GIF favourite', async (check, notes) => {
  people.alice = await open('alice');
  await signIn(people.alice.page, 'alice');   // the first account is the admin
  const A = people.alice.page;
  await api(A, 'PATCH', '/api/account', { theme: THEME });
  for (const name of ['general', 'random']) await api(A, 'POST', '/api/rooms', { name, description: null, adminOnly: false, historyLimit: 'oneMonth', sinceJoined: true });
  const boot = await api(A, 'GET', '/api/bootstrap');
  for (const r of boot.rooms) rooms[r.name] = r.id;
  check(rooms.lobby && rooms.general && rooms.random, `rooms ${boot.rooms.map(r => `${r.name}${r.description ? ` ("${r.description}")` : ''}`).join(', ')}`);

  // The library upload of Settings, target "user": the server stars it for the uploader.
  const info = await A.evaluate(async b64 => {
    const { uploadOne } = await import('/js/upload.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return uploadOne(new File([bytes], 'ridge.gif', { type: 'image/gif' }), '/api/tus', { kind: 'gif', target: 'user', folder: '' });
  }, fs.readFileSync(GIF).toString('base64'));
  check(info?.type === 'gif', `GIF upload: ${JSON.stringify(info)}`);

  people.bob = await open('bob');
  await signIn(people.bob.page, 'bob');
  bobJoinedAt = Date.now();
  await api(people.bob.page, 'PATCH', '/api/account', { displayName: 'Bob K.', bio: 'Trail runner, coffee snob, keeper of the good chocolate.', location: 'Brno', theme: THEME });
  for (const name of ['carol', 'dave']) { people[name] = await open(name); await signIn(people[name].page, name); }
  notes.push(`signed in: ${Object.keys(people).join(', ')}`);
});

// The lobby talk. A string is a text message; files go through the composer; replyTo names an earlier text.
const LOBBY = [
  ['bob', 'morning! anyone up?'],
  ['alice', 'barely ☕'],
  ['bob', 'same. the train was packed again'],
  ['alice', 'ugh. did you finish the slides for thursday?'],
  ['bob', 'almost. the trail map for saturday: https://example.com/'],
  ['alice', 'yes! the ridge trail, we start at 8'],
  ['bob', 'how long is it?'],
  ['alice', 'about 14 km, 5 hours with breaks'],
  ['bob', 'ok my legs will hate me but fine 😅'],
  ['alice', 'there is a hut at the top with really good soup'],
  ['carol', 'this is the hut, from last spring'],
  ['carol', { files: [HUT, VIEW] }],
  ['bob', 'is there cake?'],
  ['alice', 'of course, a whole one'],
  ['alice', 'we can eat it at the hut 🎂'],
  ['alice', 'if it survives the trail 😅'],
  ['bob', "I'll carry it like a baby"],
  ['alice', "I'll bring sandwiches"],
  ['alice', { files: [VIEW] }],
  ['alice', 'the view from the top, last year'],
  ['bob', 'wow ok, that sells it'],
  ['bob', 'should we ask Marek too?'],
  ['alice', 'already did, he is in if he can find his boots 😂'],
  ['bob', { text: 'no cucumber in mine please', replyTo: "I'll bring sandwiches" }],
  ['alice', 'noted, no cucumber'],
  ['bob', 'see you saturday then'],
  ['alice', 'see you! 🥾'],
];

await step(2, 'The lobby: messages, images, a reply, reactions', async (check, notes) => {
  const ids = {};
  for (const [who, item] of LOBBY) {
    const page = people[who].page;
    if (item.files) { await sendFiles(page, item.files); continue; }
    const body = typeof item === 'string' ? { text: item } : { text: item.text, replyToId: ids[item.replyTo] };
    const m = await api(page, 'POST', `/api/channels/${rooms.lobby}/messages`, { clientId: crypto.randomUUID(), replyToId: null, ...body });
    ids[body.text] = m.id;
  }
  const A = people.alice.page;
  check(await settled(A, 'see you!'), `alice sees the last row; rows ${await A.locator('.messages-container .message-group').count()}`);
  await react(people.bob.page, 'the view from the top, last year', HEART);
  await react(people.carol.page, 'no cucumber in mine please', THUMBS);
  await react(people.carol.page, 'no cucumber in mine please', LAUGH);
  await react(A, 'no cucumber in mine please', LAUGH);
  await react(A, 'this is the hut, from last spring', HEART);
  const card = await waitTrue(async () => (await row(A, 'the trail map').locator('.link-preview-card').count()) > 0, 10000, 250);
  notes.push(`link card for https://example.com/: ${card}`);
});

await step(3, 'Unread rooms and DMs, mutes, away and offline', async (check, notes) => {
  const B = people.bob.page, A = people.alice.page;
  // NT-19: a new account has every room muted by mode. Individual mode gives each conversation its own bell, so
  // the sidebar can show a counted room next to a muted one, and a counted DM next to a muted one (NT-18).
  await api(A, 'PUT', '/api/account/mutes', { roomMode: 'individual', dmMode: 'individual', newDmsMuted: false });
  for (const [room, muted] of [['lobby', false], ['general', false], ['random', true]]) await api(A, 'PUT', '/api/account/mutes', { channel: { channelId: rooms[room], muted } });
  for (const line of ['who is up for climbing on sunday?', 'the gym opens at 10']) await api(B, 'POST', `/api/channels/${rooms.general}/messages`, { clientId: crypto.randomUUID(), text: line });
  await api(B, 'POST', `/api/channels/${rooms.random}/messages`, { clientId: crypto.randomUUID(), text: 'look at this cat' });

  const C = people.carol.page;
  await C.goto(BASE + '/dm/alice');
  await C.waitForSelector('.message-input', { timeout: 10000 });
  await typeAndSend(C, 'are you driving on saturday?');
  await typeAndSend(C, 'I can bring the thermos');
  await C.goto(BASE + '/lobby');
  await C.waitForSelector('.message-input', { timeout: 10000 });
  await C.click('.status-button');
  await C.locator('.status-dropdown [data-status="away"]').click();

  const D = people.dave.page;
  await D.goto(BASE + '/dm/alice');
  await D.waitForSelector('.message-input', { timeout: 10000 });
  await typeAndSend(D, "can't make it this time, have fun");
  const boot = await api(A, 'GET', '/api/bootstrap');
  const daveDm = boot.dms.find(d => d.partner === 'dave');
  need(daveDm, 'no DM with dave');
  await api(A, 'PUT', '/api/account/mutes', { channel: { channelId: daveDm.channelId, muted: true } });
  await people.dave.ctx.close();   // PR-14: the last tab closed, offline 30 s later

  const daveDot = A.locator('.users-list .user-item', { hasText: 'dave' }).locator('.user-status-dot');
  const t0 = Date.now();
  const gone = await waitTrue(async () => !(await daveDot.getAttribute('class')).includes('online'), 90000, 500);
  check(gone, `dave offline in alice's list after ${Math.round((Date.now() - t0) / 1000)} s (dot "${await daveDot.getAttribute('class')}")`);

  // The bot greets every new account a minute after the first connection (SystemBotService); the viewers read
  // that DM first, so Ping carries no count in the pictures.
  const wait = bobJoinedAt + 65000 - Date.now();
  notes.push(`waiting ${Math.max(0, Math.round(wait / 1000))} s for the bot's welcome DMs`);
  if (wait > 0) await sleep(wait);
  for (const who of ['alice', 'bob']) {
    const page = people[who].page;
    await page.goto(BASE + '/dm/ping');
    await page.waitForSelector('.message-input', { timeout: 10000 });
    await sleep(1000);
    await page.goto(BASE + '/lobby');   // a fresh page also drops the lobby's join and leave lines (MR-73)
    await page.waitForSelector('.message-input', { timeout: 10000 });
    await settled(page, 'see you!');
  }
  await settle(A);
  const sidebar = async (sel, name) => text(A.locator(sel, { hasText: name }).locator('.unread-badge:visible'));
  const state = {
    general: await sidebar('.rooms-list .room-item', 'general'),
    random: await visible(A.locator('.rooms-list .room-item', { hasText: 'random' }).locator('.unread-dot')),
    carol: await sidebar('.users-list .user-item', 'carol'),
    dave: await visible(A.locator('.users-list .user-item', { hasText: 'dave' }).locator('.unread-dot')),
    ping: await sidebar('.users-list .user-item', 'Ping'),
    mailbox: await text(A.locator('.mailbox-badge')),
    count: await text(A.locator('.online-count')),
  };
  check(state.general === '2' && state.random && state.carol === '2' && state.dave && !state.ping && state.mailbox === '4', `alice's sidebar ${JSON.stringify(state)}`);
});

// ---- desktop, alice in the lobby ----

const A = people.alice?.page;

await picture(4, 'frame-desktop-room.png', () => A, async (A) => {
  await quiet(A); await toBottom(A); await settle(A);
  await save(A, 'frame-desktop-room.png');
});

await picture(5, 'notifications-desktop-sidebar.png', () => A, async (A) => {
  const controls = await box(A.locator('.header-controls'));
  const side = await box(A.locator('.users-sidebar'));
  const names = await box(A.locator('.users-list'));
  await save(A, 'notifications-desktop-sidebar.png', clip(A, { x0: Math.min(controls.x0, side.x0), y0: 0, x1: 1280, y1: names.y1 + 12 }));
});

await picture(6, 'presence-desktop-list.png', () => A, async (A) => {
  await save(A, 'presence-desktop-list.png', clip(A, await box(A.locator('.users-sidebar .sidebar-section').nth(1))));
});

await picture(7, 'timeline-desktop-open.png', () => A, async (A) => {
  const c = await column(A);
  await save(A, 'timeline-desktop-open.png', clip(A, { ...c, y0: c.y1 - 558 }));
});

await picture(8, 'message-row-desktop-reply-reactions.png', () => A, async (A, check) => {
  const r = row(A, 'no cucumber in mine please');
  const pills = await r.locator('.reaction-pill').evaluateAll(ps => ps.map(p => `${p.innerText.trim()}${p.classList.length > 1 ? ' [' + [...p.classList].slice(1).join(' ') + ']' : ''}`));
  check(pills.length === 2, `pills ${JSON.stringify(pills)}`);
  const own = await r.locator('.reaction-pill.reacted').evaluate(p => ({ count: getComputedStyle(p.querySelector('.reaction-count')).color, background: getComputedStyle(p).backgroundColor })).catch(() => null);
  check(true, `own pill colours ${JSON.stringify(own)}`);
  const c = await column(A), b = await box(r);
  await save(A, 'message-row-desktop-reply-reactions.png', clip(A, { x0: c.x0, x1: c.x1, y0: b.y0 - 10, y1: b.y1 + 10 }));
});

await picture(9, 'input-box-desktop-empty.png', () => A, async (A) => {
  const c = await column(A);
  const third = await box(await thirdLast(A));
  await save(A, 'input-box-desktop-empty.png', clip(A, { ...c, y0: third.y0 - 10 }));
});

await picture(10, 'input-box-desktop-text.png', () => A, async (A, check) => {
  await A.click('.message-input');
  await A.keyboard.type('hello');
  await sleep(300);
  check(await visible(A.locator('.send-button')), `send visible ${await visible(A.locator('.send-button'))}, GIF toggle visible ${await visible(A.locator('.gif-toggle-button'))}`);
  const c = await column(A);
  const third = await box(await thirdLast(A));
  await save(A, 'input-box-desktop-text.png', clip(A, { ...c, y0: third.y0 - 10 }));
  await A.fill('.message-input', '');
  await A.locator('.message-input').blur();
  await sleep(300);
});

await picture(11, 'pickers-desktop-emoji.png', () => A, async (A, check) => {
  await A.click('.emoji-toggle-button');
  const picker = A.locator('.message-input-container [data-picker-pane="emoji"] .emoji-picker');
  await picker.waitFor({ state: 'visible', timeout: 5000 });
  await quiet(A); await settle(A, 600);
  const active = await picker.locator('.emoji-sidebar .category-btn.active').getAttribute('data-category').catch(() => null);
  const recent = await picker.locator('[data-section="recent"] .emoji-btn').count();
  check(true, `active category "${active}", Recent cells ${recent}`);
  const c = await column(A), p = await box(picker);
  await save(A, 'pickers-desktop-emoji.png', clip(A, { x0: c.x0, x1: Math.max(c.x1, p.x1 + 12), y0: p.y0 - 12, y1: c.y1 }));
  await A.keyboard.press('Escape');
  need(await waitTrue(async () => (await A.locator('.message-input-container').getAttribute('data-picker')) === null, 2000), 'the emoji picker did not close');
});

await picture(12, 'pickers-desktop-gif-browse.png', () => A, async (A, check) => {
  await A.click('.gif-toggle-button');
  const picker = A.locator('.message-input-container [data-picker-pane="gif"] .gif-picker');
  await picker.waitFor({ state: 'visible', timeout: 5000 });
  need(await waitTrue(() => visible(picker.locator('.gif-folder-tile')), 5000), 'no Favorites tile');
  await quiet(A); await settle(A, 600);
  const tab = await picker.locator('.gif-sidebar .category-btn.active').getAttribute('data-tab');
  const tabs = await picker.locator('.gif-sidebar .category-btn:visible').evaluateAll(els => els.map(e => e.dataset.tab));
  check(tab === 'browse' && !tabs.includes('trending'), `active tab "${tab}", rail ${tabs.join(',')}, tile "${await text(picker.locator('.gif-folder-tile'))}", search "${await picker.locator('.gif-search > input[type=text]').getAttribute('placeholder')}"`);
  const c = await column(A), p = await box(picker);
  await save(A, 'pickers-desktop-gif-browse.png', clip(A, { x0: c.x0, x1: Math.max(c.x1, p.x1 + 12), y0: p.y0 - 12, y1: c.y1 }));
  await A.keyboard.press('Escape');
  need(await waitTrue(async () => (await A.locator('.message-input-container').getAttribute('data-picker')) === null, 2000), 'the GIF picker did not close');
});

await picture(13, 'frame-desktop-status-menu.png', () => A, async (A, check) => {
  await A.click('.status-button');
  const menu = A.locator('.status-dropdown');
  await menu.waitFor({ state: 'visible', timeout: 3000 });
  await sleep(300);
  check(true, `items: ${(await menu.locator('.dropdown-item:visible').allInnerTexts()).map(s => s.trim()).join(' | ')}`);
  const bells = await menu.locator('.bell, .bell-muted').evaluateAll(els => els.map(e => `${e.getAttribute('class')}: hidden attr ${e.hasAttribute('hidden')}, display ${getComputedStyle(e).display}`));
  check(true, `bells ${JSON.stringify(bells)}`);
  const m = await box(menu);
  await save(A, 'frame-desktop-status-menu.png', clip(A, { x0: m.x0 - 12, y0: 0, x1: 1280, y1: m.y1 + 12 }));
  await A.keyboard.press('Escape');
  await waitTrue(async () => (await A.locator('.status-dropdown').count()) === 0, 2000);
});

await picture(14, 'frame-desktop-profile-card.png', () => A, async (A, check) => {
  await A.locator('.users-list .user-item', { hasText: 'Bob K.' }).locator('.user-name').hover();
  const card = A.locator('.profile-popup .profile-card');
  await card.waitFor({ state: 'visible', timeout: 3000 });
  await settle(A);
  check(true, `card: "${await text(card)}"`);
  const p = await box(A.locator('.profile-popup')), head = await box(A.locator('.people-header'));
  await save(A, 'frame-desktop-profile-card.png', clip(A, { x0: p.x0 - 12, y0: Math.min(p.y0, head.y0) - 12, x1: 1280, y1: p.y1 + 12 }));
  await quiet(A);
});

await picture(15, 'message-row-desktop-hover-bar.png', () => A, async (A, check) => {
  const own = row(A, 'about 14 km, 5 hours with breaks');
  await own.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await own.locator('.message-content').hover();
  await sleep(300);
  const bar = own.locator('.message-actions');
  const titles = await bar.locator('.action-btn:visible').evaluateAll(bs => bs.map(b => b.title));
  check(await visible(bar) && titles.includes('Edit'), `bar buttons ${JSON.stringify(titles)}`);
  const c = await column(A), prev = await box(row(A, 'how long is it?')), b = await box(own);
  await save(A, 'message-row-desktop-hover-bar.png', clip(A, { x0: c.x0, x1: c.x1, y0: prev.y0 - 10, y1: b.y1 + 12 }));
  await quiet(A);
});

await picture(16, 'message-row-desktop-group.png', () => A, async (A, check) => {
  const first = row(A, 'of course, a whole one'), last = row(A, "I'll carry it like a baby");
  await row(A, 'if it survives the trail').evaluate(e => e.scrollIntoView({ block: 'center' }));
  await quiet(A); await settle(A);
  const headers = await Promise.all(['of course, a whole one', 'we can eat it at the hut', 'if it survives the trail', "I'll carry it like a baby"]
    .map(async t => (await row(A, t).getAttribute('class')).includes('has-header')));
  check(JSON.stringify(headers) === '[true,false,false,true]', `has-header per row ${JSON.stringify(headers)}`);
  const c = await column(A), a = await box(first), b = await box(last);
  await save(A, 'message-row-desktop-group.png', clip(A, { x0: c.x0, x1: c.x1, y0: a.y0 - 10, y1: b.y1 + 12 }));
});

await picture(17, 'timeline-desktop-history-start.png', () => A, async (A, check) => {
  await list(A).evaluate(e => { e.scrollTop = 0; });
  await quiet(A); await settle(A);
  const note = await text(A.locator('.history-start'));
  check(note === 'This is the beginning of #lobby', `note "${note}"`);
  const c = await column(A);
  await save(A, 'timeline-desktop-history-start.png', clip(A, { ...c, y1: c.y0 + 342 }));
  await toBottom(A);
});

// ---- Bob's Settings page ----

await picture(18, 'settings-desktop-top.png', () => people.bob?.page, async (B, check) => {
  await B.setViewportSize({ width: 1280, height: 1370 });   // the old image's height: the Profile and Appearance cards in one picture
  await B.click('.status-button');
  await B.locator('.status-dropdown [data-action="settings"]').click();
  await B.waitForSelector('.page-settings .theme-grid .theme-card', { timeout: 5000 });
  await quiet(B); await settle(B);
  await B.fill('#bio', 'Trail runner, coffee snob, keeper of the good chocolate.');   // an edit, so the heading shows the saved chip
  const chip = B.locator('.settings-header .save-status');
  need(await waitTrue(async () => (await visible(chip)) && (await text(chip)) === 'Saved', 3000, 50), `no Saved chip ("${await text(chip)}")`);
  await B.locator('#bio').blur();
  check(true, `selected theme "${await B.locator('.theme-grid .theme-card.selected').getAttribute('title')}"`);
  const preview = await B.locator('.theme-grid .theme-card .theme-card-preview').first().evaluate(e => ({ width: e.getBoundingClientRect().width, background: e.style.background, cardAlign: getComputedStyle(e.parentElement).alignItems }));
  check(true, `first theme preview ${JSON.stringify(preview)}`);
  await save(B, 'settings-desktop-top.png');
});

// ---- the login page, a fresh browser ----

await step(19, 'sessions-desktop-login.png', async (check) => {
  const L = await open('login');
  await L.ctx.addInitScript(theme => { try { localStorage.setItem('yap.theme', theme); } catch { /* no storage */ } }, THEME);
  const P = L.page;
  await P.goto(BASE + '/');
  await P.waitForSelector('.page-login .username-input', { timeout: 10000 });
  await P.fill('.username-input', 'marek');
  need(await waitTrue(async () => (await visible(P.locator('.new-account-hint'))) && !(await P.locator('.join-button').first().isDisabled()), 3000, 50), 'no hint for "marek"');
  await settle(P);
  check(true, `heading "${await text(P.locator('.login-heading'))}", button "${await text(P.locator('.join-button'))}", build "${await text(P.locator('.build-info'))}"`);
  // The heading, the card and the build time; the page centres them, so the picture spans heading to foot.
  const heading = await box(P.locator('.login-heading')), card = await box(P.locator('.username-form')), build = await box(P.locator('.page-login .build-info').first());
  await save(P, 'sessions-desktop-login.png', clip(P, { x0: card.x0 - 24, y0: heading.y0 - 16, x1: card.x1 + 24, y1: build.y1 + 12 }));
  await L.ctx.close();
});

// ---- the phone, alice's second device ----

let phone = null;
await step(20, 'frame-phone-sidebar.png', async (check) => {
  phone = await open('phone', PHONE);
  await phone.ctx.addCookies(await people.alice.ctx.cookies());   // the cookie only: the phone keeps its own device id
  const P = phone.page;
  await P.goto(BASE + '/lobby');
  await P.waitForSelector('.message-input', { timeout: 10000 });
  need(await settled(P, 'see you!'), 'the phone has no lobby');
  await settle(P);
  await P.tap('.users-toggle');
  need(await waitTrue(async () => (await P.locator('.users-sidebar').getAttribute('class')).includes('sidebar-open'), 2000), 'the sidebar did not open');
  await settle(P, 600);
  check(true, `theme "${await P.evaluate(() => document.documentElement.dataset.theme)}"`);
  await save(P, 'frame-phone-sidebar.png');
  await P.tap('.users-toggle');
  await waitTrue(async () => !(await P.locator('.users-sidebar').getAttribute('class')).includes('sidebar-open'), 2000);
  await sleep(400);
});

await picture(21, 'input-box-phone-sheet.png', () => phone?.page, async (P, check) => {
  await P.tap('.emoji-toggle-button');
  const sheet = P.locator('[data-picker-pane="emoji"] .combined-picker');
  await sheet.waitFor({ state: 'visible', timeout: 3000 });
  await settle(P, 700);
  check((await sheet.getAttribute('data-active-tab')) === 'emoji', `active tab "${await sheet.getAttribute('data-active-tab')}"`);
  await save(P, 'input-box-phone-sheet.png');
});

await picture(22, 'pickers-phone-sheet-gifs.png', () => phone?.page, async (P, check) => {
  await P.tap('.emoji-toggle-button');
  const sheet = P.locator('[data-picker-pane="emoji"] .combined-picker');
  await sheet.waitFor({ state: 'visible', timeout: 3000 });
  await sheet.locator('.combined-tab[data-combined-tab="gifs"]').tap();
  await sheet.locator('.gif-sidebar [data-tab="favorites"]').tap();
  const star = sheet.locator('.gif-card .gif-fav-btn.favorited');
  need(await waitTrue(() => visible(star), 5000), 'no starred card');
  await settle(P, 600);
  check(await visible(sheet.locator('.gif-manage-link')), `Settings link "${await text(sheet.locator('.gif-manage-link'))}"`);
  await save(P, 'pickers-phone-sheet-gifs.png');
  await P.keyboard.press('Escape');
  need(await waitTrue(async () => (await P.locator('.message-input-container').getAttribute('data-picker')) === null, 2000), 'the sheet did not close');
  await sleep(400);
});

await picture(23, 'message-row-phone-more-sheet.png', () => phone?.page, async (P, check) => {
  const r = row(P, 'noted, no cucumber');
  await r.locator('.message-content').tap();
  need(await waitTrue(async () => (await r.getAttribute('class')).includes('touched'), 2000), 'the tap did not show the bar');
  await r.locator('.action-more').tap();
  const menu = P.locator('.more-menu');
  await menu.waitFor({ state: 'visible', timeout: 3000 });
  await sleep(500);
  check(true, `items: ${(await menu.locator('.more-menu-item:visible').allInnerTexts()).map(s => s.trim()).join(' | ')}`);
  await save(P, 'message-row-phone-more-sheet.png');
  await P.keyboard.press('Escape');
  await waitTrue(async () => !(await visible(menu)), 2000);
  await sleep(300);
});

await picture(24, 'timeline-phone-gallery.png', () => phone?.page, async (P, check) => {
  const album = P.locator('.message-group:not(.pending) .image-gallery').filter({ has: P.locator('.gallery-row') }).first();
  await album.locator('.gallery-item').first().tap();
  const modal = P.locator('.image-modal');
  await modal.waitFor({ state: 'visible', timeout: 3000 });
  need(await waitTrue(async () => (await text(modal.locator('.modal-counter'))) === '1 / 2', 2000), `counter "${await text(modal.locator('.modal-counter'))}"`);
  need(await waitTrue(() => modal.locator('.modal-stage img').first().evaluate(i => i.complete && i.naturalWidth > 0), 5000), 'the photo did not load');
  await sleep(600);
  check(true, `counter "${await text(modal.locator('.modal-counter'))}"`);
  await save(P, 'timeline-phone-gallery.png');
  await P.keyboard.press('Escape');
  await waitTrue(async () => !(await visible(modal)), 2000);
});

await picture(25, 'offline-phone-pending.png', () => phone?.page, async (P, check) => {
  await toBottom(P);
  await phone.ctx.setOffline(true);
  need(await waitTrue(async () => !(await P.locator('.connection-dot').evaluate(e => e.hidden)), 45000, 100), 'no connection dot');
  await P.fill('.message-input', 'see you there');
  await P.tap('.send-button');
  need(await waitTrue(async () => (await P.locator('.message-group.pending', { hasText: 'see you there' }).count()) === 1, 3000), 'no pending row');
  await P.locator('.message-input').blur();
  await settle(P, 800);
  check(true, `dot class "${await P.locator('.connection-dot').getAttribute('class')}"`);
  await save(P, 'offline-phone-pending.png');
  await phone.ctx.close();   // the outbox dies with the context: the pending line never reaches the lobby
});

// ---- desktop again: the pill, then Admin ----

await picture(26, 'timeline-desktop-pill.png', () => A, async (A, check) => {
  await toBottom(A);
  await row(A, 'there is a hut at the top with really good soup').evaluate(e => e.scrollIntoView({ block: 'end' }));
  await sleep(500);
  await api(people.bob.page, 'POST', `/api/channels/${rooms.lobby}/messages`, { clientId: crypto.randomUUID(), text: 'who brings the cake knife?' });
  const pill = A.locator('.new-messages-pill');
  need(await waitTrue(() => visible(pill), 3000), 'no pill');
  await quiet(A); await settle(A);
  const p = await box(pill), input = await box(A.locator('.message-input-container')), strip = await box(A.locator('.typing-indicator-container'));
  check(true, `pill "${await text(pill)}" at y ${Math.round(p.y0)}..${Math.round(p.y1)}; typing strip y ${Math.round(strip.y0)}..${Math.round(strip.y1)}; input box y ${Math.round(input.y0)}..${Math.round(input.y1)}`);
  const c = await column(A);
  await save(A, 'timeline-desktop-pill.png', clip(A, { ...c, y0: c.y1 - 275 }));
});

await picture(27, 'admin-desktop-users.png', () => A, async (A, check) => {
  await A.click('.status-button');
  await A.locator('.status-dropdown [data-action="admin"]').click();
  await A.waitForSelector('.page-admin .users-table tbody tr', { timeout: 5000 });
  await quiet(A); await settle(A);
  const rows = (await A.locator('.page-admin .users-table tbody tr').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim().slice(0, 60));
  check(rows.length >= 5, `rows: ${rows.join(' | ')}`);
  const nav = await box(A.locator('.page-admin .admin-sidebar'));
  check(true, `admin navigation column y ${Math.round(nav.y0)}..${Math.round(nav.y1)} of ${A.viewportSize().height}`);
  await save(A, 'admin-desktop-users.png');
});

console.log(`\n==== IMAGES WRITTEN (${written.length}) to ${OUT} ====\n${written.join('\n')}`);
await finish(browser, server);
