// The proof of mechanism of E01 (compression at Optimal): the bytes on the wire of four responses, A against B, and
// the server time of a compressed response (the cost side). Two short-lived servers started as lib.mjs starts them
// (memory-only, a temp content root), A on 5313 and B on 5314, both up at the same time. Each stop() kills only the
// child process that its own start spawned, never a process found by name.
//
// Run from the harness: cd /home/agent/yap-perf/harness/tests/browser && node /home/agent/yap-perf/results/E01-compression-optimal/probe.mjs

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startServer } from '/home/agent/yap-perf/harness/tests/browser/lib.mjs';

const SIDES = [
  { key: 'A', dir: '/home/agent/yap-perf/harness', port: 5313 },
  { key: 'B', dir: '/home/agent/yap-perf/exp/01-compression-optimal', port: 5314 },
];
// app.css lives at the root of wwwroot (index.html links "app.css?v="); /css/app.css does not exist.
const PATHS = ['/app.css', '/js/main.js', '/lib/signalr.min.js', '/login'];
const SCRATCH = '/tmp/claude-1000/-d-PROJECTS-Yap/6e990ba7-f0bf-4ee7-802f-7a4cb4edeb8e/scratchpad/measure-01-compression-optimal/probe-roots';
const WARM = 50, TIMED = 200;

// The command of the brief, byte for byte, plus the time of the whole request.
const curl = (url, encoding) => execFileSync('curl', ['-s', '-H', `Accept-Encoding: ${encoding}`, '-o', '/dev/null',
  '-w', '%{size_download} %{http_code} %{time_total}', url], { encoding: 'utf8' }).trim().split(' ');

const pct = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

const servers = [];
try {
  for (const s of SIDES) {
    servers.push(s.server = await startServer({ dll: path.join(s.dir, 'Yap/bin/Debug/net10.0/Yap.dll'), wwwroot: path.join(s.dir, 'Yap/wwwroot'), port: s.port, scratch: SCRATCH }));
  }
  // The first requests run the server's tier-0 code; they are not counted.
  for (const s of SIDES) for (const p of PATHS) for (let i = 0; i < WARM; i++) curl(s.server.base + p, 'br');

  const sizes = {};
  for (const s of SIDES) {
    for (const p of PATHS) {
      const url = s.server.base + p;
      const [br, code] = curl(url, 'br');
      const [gz] = curl(url, 'gzip');
      const [raw] = curl(url, 'identity');
      sizes[`${s.key} ${p}`] = { br: Number(br), code, gzip: Number(gz), identity: Number(raw) };
    }
  }
  console.log('Bytes downloaded (curl -s -H "Accept-Encoding: <enc>" -o /dev/null -w "%{size_download} %{http_code}")\n');
  console.log('| path | status A/B | identity bytes | br A (Fastest) | br B (Optimal) | br delta | gzip A | gzip B |');
  console.log('| --- | --- | --: | --: | --: | --: | --: | --: |');
  for (const p of PATHS) {
    const a = sizes[`A ${p}`], b = sizes[`B ${p}`];
    console.log(`| ${p} | ${a.code}/${b.code} | ${a.identity} | ${a.br} | ${b.br} | ${b.br - a.br} (${((b.br - a.br) / a.br * 100).toFixed(1)}%) | ${a.gzip} | ${b.gzip} |`);
  }
  const sum = (k, f) => PATHS.reduce((t, p) => t + sizes[`${k} ${p}`][f], 0);
  console.log(`| total | | ${sum('A', 'identity')} | ${sum('A', 'br')} | ${sum('B', 'br')} | ${sum('B', 'br') - sum('A', 'br')} (${((sum('B', 'br') - sum('A', 'br')) / sum('A', 'br') * 100).toFixed(1)}%) | ${sum('A', 'gzip')} | ${sum('B', 'gzip')} |`);

  // The cost side: the time of a whole request on loopback, A and B alternating, with br and without compression.
  console.log(`\nRequest time on loopback, ms (curl time_total; ${TIMED} requests per cell, A and B alternating, after ${WARM} warm-up requests per path)\n`);
  console.log('| path | encoding | A median | B median | delta | A p90 | B p90 |');
  console.log('| --- | --- | --: | --: | --: | --: | --: |');
  for (const p of ['/login', '/app.css']) {
    for (const enc of ['br', 'identity']) {
      const t = { A: [], B: [] };
      for (let i = 0; i < TIMED; i++) {
        for (const s of i % 2 ? SIDES : [...SIDES].reverse()) t[s.key].push(Number(curl(s.server.base + p, enc)[2]) * 1000);
      }
      const a = pct(t.A, 0.5), b = pct(t.B, 0.5);
      console.log(`| ${p} | ${enc} | ${a.toFixed(2)} | ${b.toFixed(2)} | ${b - a >= 0 ? '+' : ''}${(b - a).toFixed(2)} | ${pct(t.A, 0.9).toFixed(2)} | ${pct(t.B, 0.9).toFixed(2)} |`);
    }
  }
} finally {
  for (const [i, server] of servers.entries()) {
    const issues = await server.stop();
    if (issues.length) console.log(`server ${SIDES[i].key}: ${issues.length} fail/crit/exception lines, first: ${issues[0]}`);
  }
}
