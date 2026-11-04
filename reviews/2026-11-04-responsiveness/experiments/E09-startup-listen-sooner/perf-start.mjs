// How soon a restarted Yap answers, build A against build B (experiment E09, startup-listen-sooner).
//
// One start: spawn `dotnet Yap.dll` on a fresh copy of the perf seed with the database on (the server arguments of
// perf.mjs), and from the spawn poll three requests side by side, each every 20 ms with a 1 s limit per attempt, until
// each answers 200:
//   login      GET /login, no cookie: the first page a signed-out visitor gets.
//   shell      GET / with the measured person's yap_auth cookie: the page a returning person reloads.
//   bootstrap  GET /api/bootstrap with the cookie: the first data request of that page; it reads the loaded chat
//              (rooms, direct conversations, unread counts), so it is the request that needs the chat in memory.
// Then the start waits 15 s and counts the action-log rows (the cleanup runs after "Now listening" on B), stops the
// server by its PID, counts again, and removes its content root.
//
// The action log is inflated first, once: a copy of the seed's Data with 200,000 extra rows older than the cleanup's
// cut-off (6 months), so the cleanup has real work. Every start copies that copy, so the insert is never in the
// timed window. The seed itself is not touched.
//
// Run from the harness's tests/browser (it reads SERVER_ARGS and the seed from perf-seed.mjs there):
//   node <this file> --a=<worktree> --b=<worktree> --n=10 --port-a=5351 --port-b=5352 --out=<results dir>
// Options: --seed-dir (default /home/agent/yap-perf/seed), --runs-dir (default /home/agent/yap-perf/runs),
//   --rows=200000, --warmup=1 (uncounted starts per side before the counted ones), --hold=15000.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HARNESS_BROWSER = process.cwd();
const seedModule = path.join(HARNESS_BROWSER, 'perf-seed.mjs');
if (!fs.existsSync(seedModule)) throw new Error(`run from the harness's tests/browser: ${seedModule} not found`);
const { SERVER_ARGS, readSeed } = await import(pathToFileURL(seedModule));

const seedDir = path.resolve(arg('seed-dir', '/home/agent/yap-perf/seed'));
const runsDir = path.resolve(arg('runs-dir', '/home/agent/yap-perf/runs'));
const outDir = path.resolve(arg('out', '/home/agent/yap-perf/results/E09-startup-listen-sooner'));
const N = Number(arg('n', 10));
const WARMUP = Number(arg('warmup', 1));
const ROWS = Number(arg('rows', 200_000));
const HOLD_MS = Number(arg('hold', 15_000));
const POLL_MS = 20, ATTEMPT_MS = 1000, GIVE_UP_MS = 60_000;

// Fixed names under runs/, so the cleanup afterwards removes literal paths and nothing of another agent.
const inflatedDir = path.join(runsDir, 'e09-inflated');
const startRoot = path.join(runsDir, 'e09-start');

const side = (key, dir, port) => ({ key, dir, port,
  dll: path.join(dir, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll'), wwwroot: path.join(dir, 'Yap', 'wwwroot'), repoData: path.join(dir, 'Yap', 'Data') });
const A = side('A', path.resolve(arg('a', '/home/agent/yap-perf/harness')), Number(arg('port-a', 5351)));
const B = side('B', path.resolve(arg('b', '/home/agent/yap-perf/exp/09-startup-listen-sooner')), Number(arg('port-b', 5352)));
for (const s of [A, B]) if (!fs.existsSync(s.dll)) throw new Error(`${s.dll} not found. Run dotnet build first.`);

const seed = readSeed(seedDir);
const token = seed.people.find(p => p.username === seed.measured).token;
const cookie = `yap_auth=${token}`;

// The logging overrides only add two lines: "Now listening" (Microsoft.Hosting.Lifetime) and the cleanup's summary.
// Development sets Default to Warning, which hides both.
const LOG_ARGS = ['--Logging:LogLevel:Microsoft.Hosting.Lifetime=Information', '--Logging:LogLevel:Yap.Services.Admin.UserActionLogService=Information'];

fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true });

// ---- the inflated copy of the seed's Data ----

function inflate() {
  const marker = path.join(inflatedDir, 'inflated.json');
  if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.rmSync(inflatedDir, { recursive: true, force: true });
  fs.mkdirSync(inflatedDir, { recursive: true });
  fs.cpSync(path.join(seedDir, 'Data'), path.join(inflatedDir, 'Data'), { recursive: true });
  const file = path.join(inflatedDir, 'Data', 'yap.db');
  const db = new DatabaseSync(file);
  const before = db.prepare('select count(*) n from UserActionLogs').get().n;
  const uids = db.prepare("select distinct UserUid u from UserActionLogs where UserUid <> ''").all().map(r => r.u);
  // Spread over the year before the cut-off (UtcNow minus 6 months, 2026-05-04 on the day of the run), in EF's
  // text format, so `Date < cutoff` takes them all. A quarter anonymous, the rest the seed's people; mostly requests.
  const from = Date.parse('2025-05-01T00:00:00Z'), to = Date.parse('2026-04-30T00:00:00Z');
  const actions = ['HTTP_REQUEST', 'HTTP_REQUEST', 'HTTP_REQUEST', 'HTTP_REQUEST', 'HTTP_REQUEST', 'HTTP_REQUEST', 'VISIT', 'JOIN', 'LOGIN'];
  const urls = ['/api/bootstrap', '/api/messages', '/lobby', '/api/gifs/recent', '/login'];
  const insert = db.prepare('insert into UserActionLogs (Date, UserUid, Action, Url, Info, IP, UserAgent) values (?, ?, ?, ?, ?, ?, ?)');
  db.exec('begin');
  for (let i = 0; i < ROWS; i++) {
    const at = new Date(from + Math.floor((to - from) * i / ROWS)).toISOString().replace('T', ' ').replace('Z', '0000');
    const uid = i % 4 === 0 ? '' : uids[i % uids.length];
    insert.run(at, uid, actions[i % actions.length], urls[i % urls.length], null, '127.0.0.1', 'node');
  }
  db.exec('commit');
  const after = db.prepare('select count(*) n from UserActionLogs').get().n;
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  const info = { seedRows: before, inserted: ROWS, rows: after, bytes: fs.statSync(file).size, madeAt: new Date().toISOString() };
  fs.writeFileSync(marker, JSON.stringify(info, null, 2));
  return info;
}

// ---- one start ----

// The root as startServer (lib.mjs) builds it: the build's own settings files, a link to its wwwroot, then the seed
// (here the inflated copy of its Data) over them, and the seed's uploads.
function makeRoot(s) {
  fs.rmSync(startRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(startRoot, 'Data'), { recursive: true });
  for (const entry of fs.readdirSync(s.repoData, { withFileTypes: true })) {
    const keep = entry.isFile() ? entry.name.endsWith('.json') : ['welcome', 'branding', 'custom-emojis'].includes(entry.name);
    if (keep) fs.cpSync(path.join(s.repoData, entry.name), path.join(startRoot, 'Data', entry.name), { recursive: true });
  }
  fs.symlinkSync(s.wwwroot, path.join(startRoot, 'wwwroot'), 'junction');
  fs.cpSync(path.join(inflatedDir, 'Data'), path.join(startRoot, 'Data'), { recursive: true });
  fs.cpSync(path.join(seedDir, 'uploads'), path.join(startRoot, 'uploads'), { recursive: true });
}

function countRows() {
  const db = new DatabaseSync(path.join(startRoot, 'Data', 'yap.db'));
  try { db.exec('pragma busy_timeout = 5000'); return db.prepare('select count(*) n from UserActionLogs').get().n; }
  finally { db.close(); }
}

// One GET on a new connection. Resolves { status, body }; status 0 on a refused connection or the 1 s limit.
function get(port, urlPath, withCookie) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false, headers: withCookie ? { cookie } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', e => { clearTimeout(timer); resolve({ status: 0, error: e.code ?? e.message }); });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), ATTEMPT_MS);
    req.on('error', e => { clearTimeout(timer); resolve({ status: 0, error: e.message === 'timeout' ? 'timeout' : (e.code ?? e.message) }); });
    req.end();
  });
}

// Polls one request from t0 until it answers 200. Returns the ms from the spawn to the end of that answer.
async function poll(port, urlPath, withCookie, t0, alive) {
  let attempts = 0, timeouts = 0, other = 0;
  while (alive() && performance.now() - t0 < GIVE_UP_MS) {
    attempts++;
    const sent = performance.now();
    const r = await get(port, urlPath, withCookie);
    if (r.status === 200) return { ms: Math.round(performance.now() - t0), requestMs: Math.round(performance.now() - sent), attempts, timeouts, other, body: r.body };
    if (r.error === 'timeout') timeouts++; else if (r.status !== 0) other++;
    await sleep(POLL_MS);
  }
  return { ms: null, attempts, timeouts, other };
}

function portAnswers(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

let running = null;   // the child of the current start, so a crash of this script does not leave it behind
process.on('exit', () => { if (running && running.exitCode === null && running.signalCode === null) running.kill('SIGKILL'); });
process.on('SIGINT', () => process.exit(130));

async function start(s, label, warmup) {
  if (await portAnswers(s.port)) throw new Error(`port ${s.port} is taken. Stop that server first (by its PID).`);
  makeRoot(s);
  const rowsBefore = countRows();
  const logFile = path.join(outDir, 'logs', `${label}.log`);
  const log = fs.openSync(logFile, 'w');
  const base = `http://127.0.0.1:${s.port}`;

  const t0 = performance.now();
  const child = spawn('dotnet', [s.dll, '--contentRoot', startRoot, '--urls', base, ...SERVER_ARGS, '--ChatSettings:WelcomePageEnabled=false', ...LOG_ARGS],
    { cwd: startRoot, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  running = child;
  let exited = false;
  const exitedAt = new Promise(resolve => child.on('exit', (code, signal) => { exited = true; resolve({ code, signal, ms: performance.now() }); }));

  // Every output line goes to the log with its arrival time since the spawn; two lines are timed for the report.
  const marks = { listenMs: null, cleanupMs: null, cleanupText: null, issues: [] };
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', chunk => {
      const at = Math.round(performance.now() - t0);
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        fs.writeSync(log, `+${at} ${line}\n`);
        if (marks.listenMs === null && /Now listening on/.test(line)) marks.listenMs = at;
        if (marks.cleanupMs === null && /Action log cleanup|Failed to clean up action logs/.test(line)) { marks.cleanupMs = at; marks.cleanupText = line.trim(); }
        if (/^(fail|crit):|exception/i.test(line)) marks.issues.push(line.trim());
      }
    });
  }

  const alive = () => !exited;
  const [login, shell, bootstrap] = await Promise.all([
    poll(s.port, '/login', false, t0, alive),
    poll(s.port, '/', true, t0, alive),
    poll(s.port, '/api/bootstrap', true, t0, alive),
  ]);
  let signedIn = null;
  try { signedIn = JSON.parse(bootstrap.body ?? 'null')?.user?.username ?? null; } catch { /* not JSON */ }
  const rowsAtAnswer = exited ? null : countRows();

  await sleep(HOLD_MS);
  const rowsAtHold = exited ? null : countRows();

  // Stopped by its PID only: other agents run Yap.dll servers on this machine.
  const termAt = performance.now();
  if (!exited) process.kill(child.pid, 'SIGTERM');
  const end = await Promise.race([exitedAt, sleep(30_000).then(() => null)]);
  if (!end) { process.kill(child.pid, 'SIGKILL'); await exitedAt; }
  running = null;
  fs.closeSync(log);
  const rowsAfterExit = countRows();
  fs.rmSync(startRoot, { recursive: true, force: true });

  const sample = { label, side: s.key, warmup, port: s.port,
    loginMs: login.ms, shellMs: shell.ms, bootstrapMs: bootstrap.ms,
    listenLineMs: marks.listenMs, cleanupLineMs: marks.cleanupMs,
    cleanupAfterListenMs: marks.cleanupMs !== null && marks.listenMs !== null ? marks.cleanupMs - marks.listenMs : null,
    cleanupText: marks.cleanupText,
    requestMs: { login: login.requestMs, shell: shell.requestMs, bootstrap: bootstrap.requestMs },
    attempts: { login: login.attempts, shell: shell.attempts, bootstrap: bootstrap.attempts },
    timeouts: { login: login.timeouts, shell: shell.timeouts, bootstrap: bootstrap.timeouts },
    non200: { login: login.other, shell: shell.other, bootstrap: bootstrap.other },
    bootstrapUser: signedIn,
    rowsBefore, rowsAtAnswer, rowsAtHold, rowsAfterExit,
    stopMs: end ? Math.round(end.ms - termAt) : null, exit: end ? { code: end.code, signal: end.signal } : 'SIGKILL',
    issues: marks.issues, log: logFile };
  console.log(`${label}: login ${sample.loginMs} shell ${sample.shellMs} bootstrap ${sample.bootstrapMs} listen-line ${sample.listenLineMs} ` +
    `cleanup-line ${sample.cleanupLineMs} rows ${rowsBefore} -> ${rowsAtAnswer} -> ${rowsAtHold} -> ${rowsAfterExit} user ${signedIn} issues ${marks.issues.length}`);
  return sample;
}

// ---- the run ----

const wall0 = Date.now();
const inflated = inflate();
console.log(`inflated copy: ${JSON.stringify(inflated)}`);

const samples = [];
for (let w = 0; w < WARMUP; w++) for (const s of [A, B]) samples.push(await start(s, `warmup${w + 1}-${s.key}`, true));
// A, B, B, A, A, B, B, A ...: drift of the machine hits both sides alike.
const order = Array.from({ length: 2 * N }, (_, i) => [A, B, B, A][i % 4]);
const seen = { A: 0, B: 0 };
for (const s of order) {
  seen[s.key]++;
  samples.push(await start(s, `${String(samples.filter(x => !x.warmup).length + 1).padStart(2, '0')}-${s.key}${seen[s.key]}`, false));
  await sleep(1000);
}

const median = xs => { const v = xs.filter(x => x !== null).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const METRICS = ['loginMs', 'shellMs', 'bootstrapMs', 'listenLineMs', 'cleanupLineMs', 'cleanupAfterListenMs', 'stopMs'];
const summary = {};
for (const m of METRICS) {
  const row = {};
  for (const k of ['A', 'B']) {
    const v = samples.filter(x => !x.warmup && x.side === k).map(x => x[m]).filter(x => x !== null);
    row[k] = { n: v.length, median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
  }
  row.deltaMs = row.A.median !== null && row.B.median !== null ? row.B.median - row.A.median : null;
  row.deltaPct = row.deltaMs !== null && row.A.median ? Math.round(1000 * row.deltaMs / row.A.median) / 10 : null;
  summary[m] = row;
}
const wallMs = Date.now() - wall0;
fs.writeFileSync(path.join(outDir, 'starts.json'), JSON.stringify({
  experiment: 'E09 startup-listen-sooner', at: new Date(wall0).toISOString(), wallMs,
  config: { a: A, b: B, n: N, warmup: WARMUP, pollMs: POLL_MS, attemptMs: ATTEMPT_MS, holdMs: HOLD_MS, serverArgs: [...SERVER_ARGS, '--ChatSettings:WelcomePageEnabled=false', ...LOG_ARGS], inflated },
  summary, samples }, null, 2));

console.log('\nmetric                 A median (min..max)        B median (min..max)        delta ms  delta %');
for (const [m, r] of Object.entries(summary)) {
  const cell = x => `${x.median} (${x.min}..${x.max})`.padEnd(27);
  console.log(`${m.padEnd(22)} ${cell(r.A)}${cell(r.B)}${String(r.deltaMs).padStart(8)}  ${r.deltaPct}`);
}
console.log(`\nwall time ${(wallMs / 60000).toFixed(1)} min; starts.json in ${outDir}`);
