// Per-run cold-open phases from runs.json: scripts, socket, rows, and the gaps rows - socket and rows - scripts, so a
// shift of the whole boot (before any changed byte is asked for) can be told from a shift after the sprites load.
import fs from 'node:fs';
const { records } = JSON.parse(fs.readFileSync('/home/agent/yap-perf/results/E05-sprites-webp-mp3/runs.json', 'utf8'));
const median = v => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
for (const profile of ['far', 'near']) {
  console.log(`\n${profile} cold-open, per run`);
  const gaps = { A: { rs: [], rsc: [] }, B: { rs: [], rsc: [] } };
  for (const side of ['A', 'B']) {
    for (let rep = 1; rep <= 5; rep++) {
      const v = m => records.find(r => r.profile === profile && r.journey === 'cold-open' && r.side === side && r.rep === rep && r.metric === m)?.value;
      const [sc, so, ro, kb] = [v('scripts ms'), v('socket ms'), v('rows ms'), v('wire KB')];
      gaps[side].rs.push(ro - so); gaps[side].rsc.push(ro - sc);
      console.log(`  ${side}#${rep}: scripts ${sc}  socket ${so}  rows ${ro}  rows-socket ${(ro - so).toFixed(0)}  rows-scripts ${(ro - sc).toFixed(0)}  wire KB ${kb}`);
    }
  }
  for (const k of ['rs', 'rsc']) {
    const a = median(gaps.A[k]), b = median(gaps.B[k]);
    console.log(`  median ${k === 'rs' ? 'rows-socket' : 'rows-scripts'}: A ${a.toFixed(0)}  B ${b.toFixed(0)}  delta ${(b - a).toFixed(0)}  (A ${Math.min(...gaps.A[k]).toFixed(0)}..${Math.max(...gaps.A[k]).toFixed(0)}, B ${Math.min(...gaps.B[k]).toFixed(0)}..${Math.max(...gaps.B[k]).toFixed(0)})`);
  }
}
