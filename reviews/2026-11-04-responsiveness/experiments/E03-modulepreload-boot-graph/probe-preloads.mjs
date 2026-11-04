// Proof of mechanism for E03 (modulepreload boot graph): the signed-in shell of A and of B, as curl fetches it, and
// the count of its modulepreload links, import map entries and the worker's js entries. Each side runs on its own
// short-lived server (lib.mjs startServer, a copy of the perf seed, the database on, as perf.mjs starts them), the
// person is the seed's measured user, signed in through the API (perf-seed.mjs signInToken). stop() kills each
// server's own child process, so no other agent's server is touched.
//
// Run: node /home/agent/yap-perf/results/E03-modulepreload-boot-graph/probe-preloads.mjs
//   [--a=<worktree>] [--b=<worktree>] [--port-a=5323] [--port-b=5324]

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';
import { SERVER_ARGS, readSeed, copySeed, signInToken } from '/home/agent/yap-perf/harness/tests/browser/perf-seed.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const seedDir = path.join(os.homedir(), 'yap-perf', 'seed');
const runsDir = path.join(os.homedir(), 'yap-perf', 'runs');
const seed = readSeed(seedDir);
const sides = [
  { key: 'A', dir: arg('a', '/home/agent/yap-perf/harness'), port: Number(arg('port-a', 5323)) },
  { key: 'B', dir: arg('b', '/home/agent/yap-perf/exp/03-modulepreload-boot-graph'), port: Number(arg('port-b', 5324)) },
];

const preloads = {};
for (const s of sides) {
  const server = await startServer({
    dll: path.join(s.dir, 'Yap', 'bin', 'Debug', 'net10.0', 'Yap.dll'), wwwroot: path.join(s.dir, 'Yap', 'wwwroot'),
    port: s.port, scratch: runsDir, prepare: copySeed(seedDir), args: SERVER_ARGS,
  });
  try {
    const token = await signInToken(server.base, seed.measured);
    // curl, as a plain client: the shell the server writes, before any script of the page runs.
    const curl = extra => execFileSync('curl', ['-s', ...extra, '-H', `Cookie: yap_auth=${token}`, server.base + '/'], { encoding: 'utf8' });
    const status = curl(['-o', '/dev/null', '-w', '%{http_code}']);
    const html = curl([]);
    const worker = execFileSync('curl', ['-s', server.base + '/service-worker.js'], { encoding: 'utf8' });
    const hrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"?]+)\?v=[^"]*"/g)].map(m => m[1]);
    const map = JSON.parse(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html)?.[1] ?? '{"imports":{}}');
    const workerJs = [...new Set([...worker.matchAll(/"(\/js\/[^"?]+\.js)\?v=/g)].map(m => m[1]))];
    preloads[s.key] = hrefs;
    // The worker's install (cache.add of every shell URL) goes through the HTTP cache: a stamped module that the page
    // preloaded is a cache hit there, one it did not preload crosses the link. This header says which.
    const lazy = map.imports['/js/pages/admin.js'];
    const head = execFileSync('curl', ['-sI', server.base + lazy], { encoding: 'utf8' });
    console.log(`  ${lazy}: ${head.split('\r\n').filter(l => /^(HTTP|cache-control)/i.test(l)).join('; ')}`);
    console.log(`${s.key} ${s.dir} (port ${s.port}): GET / as ${seed.measured} -> ${status}, ${html.length} B; ` +
      `rel="modulepreload" ${(html.match(/rel="modulepreload"/g) ?? []).length}; import map ${Object.keys(map.imports).length} entries; ` +
      `worker list ${workerJs.length} js modules`);
  } finally {
    const issues = await server.stop();
    if (issues.length) console.log(`  server ${s.key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
  }
}
const gone = preloads.A.filter(h => !preloads.B.includes(h));
const added = preloads.B.filter(h => !preloads.A.includes(h));
console.log(`preloaded on A, not on B (${gone.length}): ${gone.join(', ') || 'none'}`);
console.log(`preloaded on B, not on A (${added.length}): ${added.join(', ') || 'none'}`);
