// Shared helpers for the browser scripts: a throwaway server, the collectors of browser errors, the step
// report and small waiting helpers. One script is one run, so the collectors are module-level singletons.
//
// Settings: change the constants below, or pass --dll=<path> --port=<n> --scratch=<folder> to a script.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const DLL = arg('dll') ?? path.join(REPO, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll');
export const PORT = Number(arg('port') ?? 5097);
export const SCRATCH = arg('scratch') ?? path.join(os.tmpdir(), 'yap-browser-tests');
export const BASE = `http://127.0.0.1:${PORT}`;
export const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));
fs.mkdirSync(SHOTS, { recursive: true });

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const short = url => url.replace(BASE, '');

// Polls fn until it returns true or the time is up. Errors inside fn count as "not yet".
export async function waitTrue(fn, ms = 5000, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* the element is not there yet */ }
    await sleep(every);
  }
  return false;
}

// The message row whose text contains `text`.
export const row = (page, text) => page.locator('.messages-container .message-group').filter({ has: page.locator('.message-content', { hasText: text }) });

// Files through the composer, as a person sends them: the pick lands in the tray, Send posts them (IB-33).
export async function sendFiles(page, files) {
  const count = Array.isArray(files) ? files.length : 1;
  const before = await page.locator('.attachment-tray .tray-item').count();
  await page.setInputFiles('.message-input-container input[type=file]', files);
  await page.locator('.attachment-tray .tray-item').nth(before + count - 1).waitFor({ timeout: 3000 });
  await page.click('.send-button');
}

// ---- the server ----

// Starts Yap.dll memory-only in a fresh temp content root (a copy of Yap/Data and a link to Yap/wwwroot), so a
// run never touches the repository's Data folder. Returns { root, stop() }; stop() returns the server's
// fail/crit/exception lines and removes the root.
export async function startServer() {
  // An old server on the port would answer instead of the new one, and the new one would die on the bind
  // error: the run would then test stale state without saying so.
  if (await answers(`${BASE}/login`)) throw new Error(`${BASE} already answers. Stop the old server first.`);
  if (!fs.existsSync(DLL)) throw new Error(`${DLL} not found. Run dotnet build first.`);

  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'root-'));
  const data = path.join(REPO, 'Yap', 'Data');
  fs.mkdirSync(path.join(root, 'Data'));
  for (const entry of fs.readdirSync(data, { withFileTypes: true })) {
    const keep = entry.isFile() ? entry.name.endsWith('.json') : ['welcome', 'branding', 'custom-emojis'].includes(entry.name);
    if (keep) fs.cpSync(path.join(data, entry.name), path.join(root, 'Data', entry.name), { recursive: true });
  }
  // 'junction' is what Windows allows without admin rights; other systems ignore the type.
  fs.symlinkSync(path.join(REPO, 'Yap', 'wwwroot'), path.join(root, 'wwwroot'), 'junction');

  const logFile = path.join(root, 'server.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn('dotnet', [DLL, '--contentRoot', root, '--urls', BASE,
    '--ChatSettings:Persistence:Enabled=false', '--ChatSettings:WelcomePageEnabled=false'],
  { cwd: root, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' }, stdio: ['ignore', out, out] });
  let exited = false;
  child.on('exit', () => { exited = true; });

  // A crash or Ctrl+C must not leave the server running or the root behind.
  const cleanup = () => { if (!exited) child.kill(); fs.rmSync(root, { recursive: true, force: true }); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));

  const up = await waitTrue(async () => !exited && await answers(`${BASE}/login`), 30000, 250);
  if (!up) {
    const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n');
    cleanup();
    throw new Error(`The server did not start. Last log lines:\n${tail}`);
  }
  console.log(`server: ${DLL} on ${BASE}, root ${root}`);

  return {
    root,
    async stop() {
      if (!exited) {
        child.kill();
        if (!await waitTrue(() => exited, 10000, 100)) child.kill('SIGKILL');
      }
      fs.closeSync(out);
      const issues = fs.readFileSync(logFile, 'utf8').split('\n')
        .filter(l => /^(fail|crit):|exception/i.test(l)).map(l => l.trim());
      fs.rmSync(root, { recursive: true, force: true });
      process.off('exit', cleanup);
      return issues;
    },
  };
}

async function answers(url) {
  try { return (await fetch(url)).status === 200; } catch { return false; }
}

// ---- the collectors ----

export const logs = [];   // { step, page, kind, text }
let currentStep = 0;

// Requests are collected on the context: with PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 the context also
// sees the service worker's requests (marked "/sw"); a page listener never does.
export function watchContext(ctx, name) {
  ctx.on('requestfailed', r => logs.push({ step: currentStep, page: name + (r.serviceWorker() ? '/sw' : ''), kind: 'requestfailed', text: `${r.method()} ${short(r.url())} ${r.failure()?.errorText}` }));
  ctx.on('response', r => { if (r.status() >= 400) logs.push({ step: currentStep, page: name + (r.request().serviceWorker() ? '/sw' : ''), kind: 'http', text: `${r.status()} ${r.request().method()} ${short(r.url())}` }); });
}

// Console errors and warnings, page errors, and dialogs. Every dialog is accepted and recorded, so a step reads
// its confirms from the log instead of adding a second handler (two handlers on one dialog throw).
const names = new WeakMap();   // page -> its name in the logs
export function watchPage(page, name) {
  names.set(page, name);
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const at = m.location()?.url ? ` @ ${short(m.location().url)}:${m.location().lineNumber}` : '';
    logs.push({ step: currentStep, page: name, kind: 'console.' + m.type(), text: (m.text() + at).slice(0, 240) });
  });
  page.on('pageerror', e => logs.push({ step: currentStep, page: name, kind: 'pageerror', text: e.message + ' | ' + ((e.stack || '').split('\n')[1]?.trim() ?? '') }));
  page.on('dialog', async d => { logs.push({ step: currentStep, page: name, kind: 'dialog', text: d.message() }); await d.accept(); });
}

// The sign-out confirmations are Yap's own dialogs (SH-15), not the browser's. This presses their red button while
// one shows, up to `ms` after the last, and records each text as a 'dialog' log line, so a step reads them as before.
export async function acceptDialogs(page, ms = 600) {
  const name = names.get(page) ?? '?';
  for (;;) {
    const overlay = page.locator('.delete-confirm-overlay');
    if (!await waitTrue(async () => (await overlay.count()) > 0, ms, 50)) return;
    logs.push({ step: currentStep, page: name, kind: 'dialog', text: await overlay.locator('.delete-confirm-text').innerText().catch(() => '') });
    await overlay.locator('.confirm-delete').click().catch(() => {});
    await waitTrue(async () => (await overlay.count()) === 0, 1000, 50);
  }
}

export const stepLogs = (n, page) => logs.filter(l => l.step === n && (!page || l.page.startsWith(page)));
export const fmt = list => list.map(l => `${l.page} ${l.kind}: ${l.text}`).join(' ; ');

// ---- the report ----

const results = [];

// Runs one step. fn(check, notes): check(condition, text) records a line and fails the step when the
// condition is false; notes.push(text) records a line only. An exception fails the step and the run goes on.
export async function step(n, title, fn) {
  currentStep = n;
  const notes = [];
  let ok = true;
  const check = (cond, msg) => { notes.push((cond ? '' : '!! ') + msg); if (!cond) ok = false; };
  try { await fn(check, notes); } catch (e) { ok = false; notes.push('EXC: ' + e.message.split('\n')[0]); }
  results.push({ n, title, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n}. ${title}\n    ${notes.join('\n    ')}`);
}

// Closes the browser, prints the collected logs (deduplicated, with the steps where each line was seen),
// stops the server, prints its problem lines and the summary. The exit code is 1 when a step failed.
export async function finish(browser, server) {
  await browser.close();
  console.log('\n==== BROWSER LOG (deduplicated; [steps] where seen) ====');
  const seen = new Map();
  for (const l of logs) {
    const key = `${l.page}|${l.kind}|${l.text}`;
    const v = seen.get(key) ?? { n: 0, steps: new Set() };
    v.n++; v.steps.add(l.step); seen.set(key, v);
  }
  for (const [key, v] of seen) console.log(`${v.n}x [${[...v.steps].join(',')}] ${key}`);
  if (!seen.size) console.log('(none)');

  const issues = await server.stop();
  console.log('\n==== SERVER LOG: fail/crit/exception lines ====');
  console.log(issues.length ? issues.join('\n') : '(none)');

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${failed.length ? ': ' + failed.map(r => r.n).join(', ') : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

// ---- sign-in and fixtures ----

// Signs a page in with a new username. Returns the time of the submit (step 3 of smoke measures from it).
// base: update.mjs runs its own server on its own port (5098) and passes its own base. With this module's BASE
// (5097), its sign-in went to a port where no server answered, unless --port set both.
export async function signIn(page, name, base = BASE) {
  await page.goto(base + '/');
  await page.waitForSelector('.page-login .username-input', { timeout: 10000 });
  await page.fill('.username-input', name);
  await page.waitForSelector('.username-form .join-button:not([disabled])', { timeout: 5000 });   // the server's check of the name
  const t = Date.now();
  await page.press('.username-input', 'Enter');
  await page.waitForSelector('.message-input', { timeout: 10000 });
  await waitTrue(async () => new URL(page.url()).pathname === '/lobby', 3000);
  return t;
}

// fetch from the page, with its cookie: the same requests the client makes.
export function api(page, method, url, body = null) {
  return page.evaluate(async ([method, url, body]) => {
    const init = { method, credentials: 'same-origin' };
    if (body !== null) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
    const res = await fetch(url, init);
    const reply = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${reply.slice(0, 200)}`);
    return reply ? JSON.parse(reply) : null;
  }, [method, url, body]);
}

// A path in the scratch folder for a generated input file.
export function fixture(name) {
  const dir = path.join(SCRATCH, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// Writes a size x size PNG in one RGB colour.
export function makePng(file, [r, g, b], size = 2) {
  return writePng(file, size, size, Buffer.from(Array.from({ length: size * size }, () => [r, g, b]).flat()));
}

// Writes a width x height PNG from `rgb`, three bytes per pixel, row by row (no library: IHDR, one IDAT, IEND).
export function writePng(file, width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8 bits per channel, RGB; compression, filter and interlace stay 0
  const stride = width * 3;
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), rgb.subarray(y * stride, (y + 1) * stride)])));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(file, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

// zlib.crc32 exists only from Node 22.2; the table keeps older Node versions working.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
