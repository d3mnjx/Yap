// The upload run (input-box.md IB-28 and IB-34, offline.md OF-10): a text that goes out while a picture uploads,
// the state of each file and the limit of three at one time, an upload that goes on after a reload from the bytes
// the server has, a last chunk whose answer was lost (with a reload and without one), a message that loses a
// file the server refused, a half-sent file the server no longer has, and a proxy that answers 502 for a server
// that restarts. Whose an upload and its result are, and what an error in the server's work on a finished file
// gives, are server tests (Yap.Tests/SecurityTests.cs). Run: npm run uploads (see README.md).

import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { waitTrue, row, step, finish, startServer, signIn, watchContext, watchPage, fixture, makePng, writePng, sendFiles } from './lib.mjs';

const CHUNK = 5 * 1024 * 1024;   // the chunk size of js/upload.js
const colours = [[220, 30, 30], [30, 60, 220], [40, 200, 90], [230, 200, 40], [160, 60, 200]];
const P = colours.map((c, i) => makePng(fixture(`p${i + 1}.png`), c));
// Noise does not compress: about 12 MB, three chunks.
const BIG = writePng(fixture('big.png'), 2000, 2000, crypto.randomBytes(2000 * 2000 * 3));

const server = await startServer();
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxA, 'A');
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } }); watchContext(ctxB, 'B');
const A = await ctxA.newPage(); watchPage(A, 'A');
const B = await ctxB.newPage(); watchPage(B, 'B');
await signIn(A, 'boss');
await signIn(B, 'guest');

// ---- what A's uploads do on the wire ----

const lastPart = url => new URL(url).pathname.split('/').pop();
const names = new Map();     // upload id -> file name, from the create request
const results = new Map();   // file name -> the URL the server gave the processed file
let wire = [];               // { method, path, offset, name }: every request to /api/tus since the last clear
const posted = [];           // the body of every message POST
ctxA.on('request', req => {
  const path = new URL(req.url()).pathname;
  if (path.startsWith('/api/tus')) wire.push({ method: req.method(), path, offset: Number(req.headers()['upload-offset'] ?? -1), name: names.get(lastPart(req.url())) ?? null });
  if (req.method() === 'POST' && /\/api\/channels\/[^/]+\/messages$/.test(path)) posted.push(req.postDataJSON());
});
ctxA.on('response', async res => {
  const req = res.request(), path = new URL(req.url()).pathname;
  if (req.method() === 'POST' && path === '/api/tus' && res.headers().location) names.set(lastPart(new URL(res.headers().location, req.url()).href), nameOf(req));
  if (req.method() === 'GET' && path.startsWith('/api/tus/info/') && res.ok()) { const info = await res.json().catch(() => null); if (info?.url) results.set(names.get(lastPart(req.url())), info.url); }
});
// The file name of a create request, from its Upload-Metadata header ("filename <base64>,filetype <base64>").
const nameOf = req => Buffer.from(/filename ([^,]+)/.exec(req.headers()['upload-metadata'] ?? '')?.[1] ?? '', 'base64').toString();

// Holds the PATCH requests (the bytes of the files) until release(); the creates and the polls pass. release(match)
// lets the uploads go whose file name matches, now and from then on.
async function holdUploads() {
  let waiting = [], open = () => false;
  const handler = async route => {
    const name = names.get(lastPart(route.request().url()));
    if (route.request().method() === 'PATCH' && !open(name)) await new Promise(go => waiting.push({ name, go }));
    await route.continue().catch(() => {});
  };
  await ctxA.route('**/api/tus/*', handler);
  return {
    release(match = () => true) {
      const before = open; open = name => before(name) || match(name);
      waiting = waiting.filter(w => { if (!match(w.name)) return true; w.go(); return false; });
    },
    stop: () => ctxA.unroute('**/api/tus/*', handler),
  };
}

const pendingWith = name => A.locator('.message-group.pending').filter({ has: A.locator(`.pending-thumb[title^="${name}"]`) });
const states = r => r.locator('.pending-thumb').evaluateAll(list => list.map(t => t.dataset.state));
const pictures = page => page.locator('.message-group:not(.pending) img.gallery-image').count();
// The rows of the timeline in their order: 'picture' for a row with pictures, else its text.
const order = page => page.locator('.messages-container .message-group').evaluateAll(list => list.map(e => e.querySelector('img.gallery-image') ? 'picture' : e.querySelector('.message-content')?.textContent.trim()));

await step(1, 'A text goes out while a picture uploads (IB-28)', async (check) => {
  const hold = await holdUploads();
  await sendFiles(A, P[0]);
  const has = await waitTrue(async () => (await pendingWith('p1.png').count()) === 1, 3000);
  await A.fill('.message-input', 'sent after the picture');
  await A.press('.message-input', 'Enter');
  const text = await waitTrue(async () => (await row(A, 'sent after the picture').count()) === 1 && !(await row(A, 'sent after the picture').getAttribute('class')).includes('pending'), 5000, 50);
  check(has && text && (await pendingWith('p1.png').count()) === 1, `picture row pending: ${has}; text row accepted while it uploads: ${text}`);
  const onB = await waitTrue(async () => (await row(B, 'sent after the picture').count()) === 1, 5000);
  check(onB && (await pictures(B)) === 0, `B has the text: ${onB}; pictures on B before the release: ${await pictures(B)}`);
  hold.release();
  const done = await waitTrue(async () => (await pictures(A)) === 1 && (await pictures(B)) === 1, 15000, 200);
  const [a, b] = [await order(A), await order(B)];
  check(done && a.at(-1) === 'picture' && a.at(-2) === 'sent after the picture' && b.at(-1) === 'picture' && b.at(-2) === 'sent after the picture',
    `picture arrived: ${done}; the last rows on A: ${JSON.stringify(a.slice(-2))}, on B: ${JSON.stringify(b.slice(-2))}`);
  await hold.stop();
});

await step(2, 'Each file shows its state, three upload at one time, the pictures keep the order of the pick (IB-34)', async (check) => {
  const hold = await holdUploads();
  const before = await pictures(A);
  await sendFiles(A, P);
  const r = pendingWith('p1.png');
  const three = await waitTrue(async () => (await states(r)).join() === 'uploading,uploading,uploading,waiting,waiting', 5000);
  check(three, `states with the bytes held: ${(await states(r)).join()}`);
  const titles = await r.locator('.pending-thumb').evaluateAll(list => list.map(t => `${t.title}|${t.getAttribute('aria-label')}`));
  check(titles[0] === 'p1.png — uploading|p1.png — uploading' && titles[4] === 'p5.png — waiting|p5.png — waiting', `title and label: ${JSON.stringify([titles[0], titles[4]])}`);
  check((await r.locator('.pending-files').count()) === 0 && (await r.locator('.pending-cancel').count()) === 1, `no file names, one Cancel upload: ${await r.locator('.pending-cancel').count()}`);
  hold.release(name => name !== 'p1.png');   // the first file of the pick ends last
  const four = await waitTrue(async () => (await states(r)).join() === 'uploading,done,done,done,done', 15000, 200);
  check(four && (await r.count()) === 1, `states with only p1 held: ${(await states(r).catch(() => [])).join()}; row still pending: ${await r.count()}`);
  hold.release();
  const done = await waitTrue(async () => (await pictures(A)) === before + 5, 15000, 200);
  const want = P.map((_, i) => results.get(`p${i + 1}.png`));
  check(done && JSON.stringify(posted.at(-1)?.images) === JSON.stringify(want), `five pictures: ${done}; posted in the order of the pick: ${JSON.stringify(posted.at(-1)?.images) === JSON.stringify(want)}`);
  await hold.stop();
});

await step(3, 'An upload goes on after a reload from the bytes the server has (OF-10)', async (check) => {
  const before = await pictures(A);
  let patches = 0, cut = true;
  const handler = route => (cut && route.request().method() === 'PATCH' && ++patches > 1) ? route.abort('connectionfailed') : route.continue();   // the first chunk arrives, the next ones do not
  await ctxA.route('**/api/tus/*', handler);
  await sendFiles(A, BIG);
  const stopped = await waitTrue(() => patches > 1, 20000, 100);
  check(stopped, `chunks tried before the reload: ${patches}`);
  cut = false; wire = [];
  await A.reload();
  await A.waitForSelector('.message-input', { timeout: 10000 });
  const done = await waitTrue(async () => (await pictures(A)) === before + 1, 30000, 200);
  const creates = wire.filter(w => w.method === 'POST' && w.path === '/api/tus').length;
  const first = wire.find(w => w.method === 'PATCH');
  check(done, `the picture arrived after the reload: ${done}`);
  check(creates === 0 && first?.offset >= CHUNK, `creates after the reload: ${creates}; the first chunk after it starts at byte ${first?.offset}`);
  await ctxA.unroute('**/api/tus/*', handler);
});

// The last chunk reaches the server, which processes the file, and its answer never reaches the client. Until
// open() every later request to the upload endpoint fails; from then the first two polls for the result get the
// 202 of a server that still works on the file.
async function loseLastAnswer(file) {
  let lost = false, opened = false, early = 2;
  const bytes = async route => {
    if (opened) return route.continue();
    if (lost || route.request().method() !== 'PATCH') return route.abort('connectionfailed');
    await route.fetch();   // the server has the file now
    lost = true;
    await route.abort('connectionfailed');
  };
  const poll = route => !opened ? route.abort('connectionfailed') : early-- > 0 ? route.fulfill({ status: 202, body: '' }) : route.continue();
  await ctxA.route('**/api/tus/*', bytes);
  await ctxA.route('**/api/tus/info/*', poll);
  await sendFiles(A, file);
  await waitTrue(() => lost, 10000, 50);
  return { lost: () => lost, open() { opened = true; }, async stop() { await ctxA.unroute('**/api/tus/*', bytes); await ctxA.unroute('**/api/tus/info/*', poll); } };
}

await step(4, 'A last chunk whose answer was lost is not sent again after a reload', async (check) => {
  const before = await pictures(A);
  const net = await loseLastAnswer(makePng(fixture('lost.png'), [20, 20, 20]));
  check(net.lost(), `the server took the last chunk and the answer was dropped: ${net.lost()}`);
  wire = [];
  await A.reload();
  await A.waitForSelector('.message-input', { timeout: 10000 });
  net.open();
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a wake-up, as the hub's reconnect is one
  const done = await waitTrue(async () => (await pictures(A)) === before + 1, 20000, 200);
  const sent = wire.filter(w => w.method === 'PATCH' || (w.method === 'POST' && w.path === '/api/tus'));
  check(done && sent.length === 0, `the picture arrived: ${done}; creates and chunks after the reload: ${sent.length} (${JSON.stringify(wire.map(w => `${w.method} ${w.path.replace(/[0-9a-f]{64}/, 'id')}`))})`);
  await net.stop();
});

await step(5, 'A last chunk whose answer was lost is not sent again in the same session', async (check) => {
  const before = await pictures(A);
  const net = await loseLastAnswer(makePng(fixture('lost2.png'), [90, 90, 90]));
  wire = [];
  net.open();   // no reload: tus asks at once how far the upload is, and the server says 404
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const done = await waitTrue(async () => (await pictures(A)) === before + 1, 20000, 200);
  const sent = wire.filter(w => w.method === 'PATCH' || (w.method === 'POST' && w.path === '/api/tus'));
  check(done && sent.length === 0, `the picture arrived: ${done}; creates and chunks after the lost answer: ${sent.length}`);
  await net.stop();
});

await step(6, 'A message goes out without the file the server refused, and the file stays as a failed row', async (check) => {
  const before = await pictures(A);
  const OK = makePng(fixture('fine.png'), [10, 120, 120]), NO = makePng(fixture('refused.png'), [120, 10, 120]);
  const handler = route => route.request().method() === 'POST' && nameOf(route.request()) === 'refused.png'
    ? route.fulfill({ status: 400, contentType: 'text/plain', body: 'No such pictures today' }) : route.continue();
  await ctxA.route('**/api/tus', handler);
  await sendFiles(A, [OK, NO]);
  const went = await waitTrue(async () => (await pictures(A)) === before + 1, 15000, 200);
  const failed = A.locator('.message-group.pending.failed');
  const left = await waitTrue(async () => (await failed.count()) === 1, 5000);
  const reason = left ? await failed.locator('.pending-reason').innerText() : '';
  check(went && left && reason.includes('refused.png') && reason.includes('No such pictures today'), `the message has one picture: ${went}; failed row: ${left}, reason "${reason}"`);
  check(left && (await failed.locator('.pending-retry').count()) === 1 && (await failed.locator('.pending-remove').count()) === 1, 'the failed row has Retry and Remove');
  await ctxA.unroute('**/api/tus', handler);
  if (left) await failed.locator('.pending-retry').click();
  const again = await waitTrue(async () => (await pictures(A)) === before + 2 && (await A.locator('.message-group.pending').count()) === 0, 15000, 200);
  check(again && (await waitTrue(async () => (await pictures(B)) >= 2, 5000)), `Retry sent the file as a second message: ${again}; pending rows left: ${await A.locator('.message-group.pending').count()}`);
});

await step(7, 'A half-sent file the server does not know starts again from zero at once', async (check) => {
  const before = await pictures(A);
  // 'cut': the first chunk arrives, the next ones do not. 'block': nothing arrives, so the page that is about to
  // go cannot act on what follows. 'gone': the next offset request gets the 404 of an upload the server removed
  // (the one-day expiry), then everything passes.
  let patches = 0, mode = 'cut';
  const handler = route => {
    const method = route.request().method();
    if (mode === 'block' || (mode === 'cut' && method === 'PATCH' && ++patches > 1)) return route.abort('connectionfailed');
    if (mode === 'gone' && method === 'HEAD') { mode = 'open'; return route.fulfill({ status: 404, body: 'File not found' }); }
    return route.continue();
  };
  await ctxA.route('**/api/tus/*', handler);
  await sendFiles(A, writePng(fixture('big2.png'), 2000, 2000, crypto.randomBytes(2000 * 2000 * 3)));
  await waitTrue(() => patches > 1, 20000, 100);
  mode = 'block';
  await A.reload();
  await A.waitForSelector('.message-input', { timeout: 10000 });
  mode = 'gone'; wire = [];
  const t0 = Date.now();
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a wake-up, as the hub's reconnect is one
  const created = await waitTrue(() => wire.some(w => w.method === 'POST' && w.path === '/api/tus'), 10000, 100);
  const wait = Date.now() - t0;
  const done = await waitTrue(async () => (await pictures(A)) === before + 1, 30000, 200);
  const first = wire.find(w => w.method === 'PATCH');
  check(created && first?.offset === 0, `a new upload was created ${wait} ms after the server said 404: ${created}; its first chunk starts at byte ${first?.offset}`);
  check(done, `the picture arrived: ${done}`);
  await ctxA.unroute('**/api/tus/*', handler);
});

await step(8, 'A file waits while a proxy answers 502 for the server, then goes on from the bytes the server has (OF-10)', async (check) => {
  const before = await pictures(A);
  // 'first': the first chunk arrives. 'down': the server restarts, and the reverse proxy in front of it answers
  // each request with a 502. 'up': everything passes.
  let patches = 0, mode = 'first';
  const handler = route => {
    if (mode === 'first' && route.request().method() === 'PATCH' && ++patches > 1) mode = 'down';
    return mode === 'down' ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.continue();
  };
  await ctxA.route('**/api/tus/*', handler);
  await sendFiles(A, writePng(fixture('big3.png'), 2000, 2000, crypto.randomBytes(2000 * 2000 * 3)));
  const r = pendingWith('big3.png');
  // tus tries again for about nine seconds; then the file waits, and it is not a refused file
  const waits = await waitTrue(async () => mode === 'down' && (await states(r)).join() === 'waiting', 20000, 200);
  const failed = await A.locator('.message-group.pending.failed').count();
  check(waits && failed === 0, `the file waits: ${waits} (states: ${(await states(r)).join()}); failed rows: ${failed}`);
  mode = 'up'; wire = [];
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a wake-up, as the hub's reconnect is one
  const done = await waitTrue(async () => (await pictures(A)) === before + 1, 30000, 200);
  const creates = wire.filter(w => w.method === 'POST' && w.path === '/api/tus').length;
  const first = wire.find(w => w.method === 'PATCH');
  check(done && creates === 0 && first?.offset === CHUNK, `the picture arrived: ${done}; creates after the 502s: ${creates}; the first chunk after them starts at byte ${first?.offset}`);
  await ctxA.unroute('**/api/tus/*', handler);
});

await finish(browser, server);
