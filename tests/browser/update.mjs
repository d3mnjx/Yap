// A deploy, replayed: build A is served, the browser stores the shell through the worker, then build B takes the
// same port and the page is reloaded, as an installed app is at its next launch. The script watches the worker's
// registration for 20 s and then taps the new-version strip's Reload, up to three times, and says whether the page
// ends on build B with no strip. --stuckworker makes build B serve build A's worker bytes, so the browser never sees
// a new worker: the installed app on an iPhone did that after the 2026-10-30 deploy, and only the page's own move
// through '/' got it the new build (main.js reloadForNewBuild). --signin runs it on the settings page of an account
// and checks that the route survives the move.
//
// The two builds: build twice in different minutes (the stamp is yyyy-MM-dd-HHmm) and copy bin/Debug/net10.0 each
// time, for example to /tmp/yapA and /tmp/yapB. Then:
//   npm run update -- --dllA=/tmp/yapA --dllB=/tmp/yapB [--signin] [--stuckworker] [--browser=chromium] [--port=5098]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pw from 'playwright';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const browserName = arg('browser') ?? 'chromium';
const PORT = Number(arg('port') ?? 5098);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = arg('out') ?? path.join(os.tmpdir(), 'yap-browser-tests', 'update');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(OUT, `${browserName}.log`), line + '\n'); };

async function answers() { try { return (await fetch(`${BASE}/login`)).status === 200; } catch { return false; } }
async function waitTrue(fn, ms, every = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(every); } return false; }

// One content root for both builds: the database in it keeps the account across the "deploy".
const root = fs.mkdtempSync(path.join(OUT, 'root-'));
fs.mkdirSync(path.join(root, 'Data'));
for (const f of fs.readdirSync(path.join(REPO, 'Yap', 'Data'))) if (f.endsWith('.json')) fs.cpSync(path.join(REPO, 'Yap', 'Data', f), path.join(root, 'Data', f));
fs.symlinkSync(path.join(REPO, 'Yap', 'wwwroot'), path.join(root, 'wwwroot'));
async function startServer(dir) {
  if (await answers()) throw new Error(`${BASE} already answers`);
  const out = fs.openSync(path.join(root, 'server.log'), 'a');
  const child = spawn('dotnet', [path.join(dir, 'Yap.dll'), '--contentRoot', root, '--urls', BASE,
    '--ChatSettings:Persistence:Enabled=true', '--ChatSettings:WelcomePageEnabled=false'],
  { cwd: root, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production' }, stdio: ['ignore', out, out] });
  let exited = false; child.on('exit', () => { exited = true; });
  if (!await waitTrue(async () => !exited && await answers(), 30000)) throw new Error('server did not start: ' + fs.readFileSync(path.join(root, 'server.log'), 'utf8').slice(-2000));
  const build = (await (await fetch(`${BASE}/login`)).text()).match(/data-build="([^"]*)"/)?.[1];
  log(`server up from ${dir}, build ${build}`);
  return { build, async stop() { child.kill(); await waitTrue(() => exited, 10000, 100); if (!exited) child.kill('SIGKILL'); await waitTrue(async () => !await answers(), 10000); fs.closeSync(out); } };
}

// What the page sees: its own build, the strip, the registration and the caches.
async function snapshot(page) {
  return page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.getRegistration(), new Promise(r => setTimeout(() => r('TIMEOUT'), 3000))]);
    const w = x => x ? `${x.scriptURL.replace(location.origin, '')}:${x.state}` : null;
    const strip = document.getElementById('notice');
    return {
      path: location.pathname + location.hash,
      build: document.documentElement.dataset.build,
      strip: strip.hidden ? 'hidden' : `"${strip.querySelector('.notice-text').textContent}" [${strip.querySelector('.notice-action').textContent}${strip.querySelector('.notice-action').disabled ? ' disabled' : ''}]`,
      controller: navigator.serviceWorker.controller?.scriptURL.replace(location.origin, '') ?? null,
      reg: reg === 'TIMEOUT' ? 'getRegistration TIMEOUT' : reg ? { installing: w(reg.installing), waiting: w(reg.waiting), active: w(reg.active) } : null,
      caches: (await caches.keys()).filter(k => k.startsWith('yap-shell')),
      nav: (() => { const [n] = performance.getEntriesByType('navigation'); return n ? `transfer=${n.transferSize} type=${n.type}` : null; })(),
    };
  });
}
const show = async (page, label) => { const s = await snapshot(page); log(label, JSON.stringify(s)); return s; };

const dirA = arg('dllA'), dirB = arg('dllB');
if (!dirA || !dirB) { console.error('usage: npm run update -- --dllA=<dir> --dllB=<dir> [--signin] [--stuckworker]'); process.exit(2); }
const userDataDir = fs.mkdtempSync(path.join(OUT, `${browserName}-profile-`));
const ctx = await pw[browserName].launchPersistentContext(userDataDir, { headless: true, viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log('console', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', e => log('pageerror', String(e).slice(0, 200)));

let server = await startServer(dirA);
const A = server.build;
const signedIn = process.argv.includes('--signin');
if (signedIn) { const { signIn } = await import('./lib.mjs'); await signIn(page, 'wrenupdate', BASE); log('signed in as wrenupdate'); }
await page.goto(`${BASE}/settings`, { waitUntil: 'load' });
log('first load of /settings on build', A);
await waitTrue(() => page.evaluate(() => !!navigator.serviceWorker.controller), 20000);
await waitTrue(() => page.evaluate(async () => (await caches.keys()).some(k => k.startsWith('yap-shell'))), 20000);
await sleep(1500);
await show(page, 'after first load:');
await page.reload({ waitUntil: 'load' });
await sleep(1500);
const s1 = await show(page, 'after a reload on build A (expect the shell from the cache):');
if (s1.build !== A) log('WARNING: the document is not build A after the reload');

log('--- deploy: stop A, start B ---');
// --stuckworker: build B serves build A's worker bytes, so the browser never sees a new worker. This is the phone's
// case: the page the old worker serves is old, the server is new, and only the page's own move to '/' can help.
const stuck = process.argv.includes('--stuckworker');
const workerA = stuck ? await (await fetch(`${BASE}/service-worker.js`)).text() : null;
await server.stop();
if (stuck) {
  fs.rmSync(path.join(root, 'wwwroot'));
  fs.cpSync(path.join(REPO, 'Yap', 'wwwroot'), path.join(root, 'wwwroot'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wwwroot', 'service-worker.js'), workerA);
  log('build B will serve build A\'s worker bytes');
}
server = await startServer(dirB);
const B = server.build;
if (A === B) throw new Error('both builds carry the same stamp');

await page.reload({ waitUntil: 'load' });
log('reloaded after the deploy; polling the registration for 20 s');
for (let i = 0; i < 20; i++) { await sleep(1000); const s = await show(page, `t+${i + 1}s:`); if (s.controller?.includes('?v=') && s.reg?.active?.includes(':activated') && !s.reg.installing && !s.reg.waiting && s.caches.includes(`yap-shell-${B}`)) { log('the new worker is active and has its cache'); break; } }

for (let attempt = 1; attempt <= 3; attempt++) {
  const before = await show(page, `before Reload tap ${attempt}:`);
  if (before.build === B && before.strip === 'hidden') { log('RESULT: the page runs build B with no strip'); break; }
  if (before.strip === 'hidden') { log('no strip to tap; plain reload instead'); await page.reload({ waitUntil: 'load' }); }
  else {
    const t0 = Date.now();
    await page.click('#notice .notice-action');
    await page.waitForEvent('load', { timeout: 30000 }).catch(() => log('no load event within 30 s after the tap'));
    log(`tap ${attempt}: the page reloaded after ${Date.now() - t0} ms`);
  }
  await sleep(2000);
  const after = await show(page, `after Reload tap ${attempt}:`);
  if (after.build === B && after.strip === 'hidden') { log(`RESULT: build B with no strip after tap ${attempt}`); break; }
  if (attempt === 3) log(`RESULT: STUCK on build ${after.build} with strip ${after.strip} after 3 taps`);
  await sleep(5000);
}
const fin = await show(page, 'final:');
if (signedIn) log(fin.path === '/settings' ? 'ROUTE KEPT: /settings' : `ROUTE LOST: ${fin.path}`);
await ctx.close();
await server.stop();
fs.rmSync(root, { recursive: true, force: true });   // the content root and its database, like lib.mjs does
fs.rmSync(userDataDir, { recursive: true, force: true });
log('done');
