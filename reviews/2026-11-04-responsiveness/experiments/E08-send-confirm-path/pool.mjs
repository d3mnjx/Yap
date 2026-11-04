// Pools the send samples of the two harness runs: medians, quartiles and a Mann-Whitney z per profile and metric.
import fs from 'node:fs';
const files = process.argv.slice(2);
const recs = files.flatMap((f, i) => JSON.parse(fs.readFileSync(f, 'utf8')).records.map(r => ({ ...r, run: i + 1 })));
const q = (v, p) => { const a = [...v].sort((x, y) => x - y); const i = (a.length - 1) * p, lo = Math.floor(i); return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo); };
function mw(a, b) {
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length;) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1; i = j + 1; }
  const ra = all.reduce((s, x, i) => s + (x[1] === 0 ? ranks[i] : 0), 0);
  const u = ra - a.length * (a.length + 1) / 2, mu = a.length * b.length / 2, sd = Math.sqrt(a.length * b.length * (a.length + b.length + 1) / 12);
  return (u - mu) / sd;
}
for (const profile of ['near', 'lan']) for (const metric of ['own row ms', 'confirmed ms']) {
  const pick = (side, run) => recs.filter(r => r.profile === profile && r.metric === metric && r.side === side && (!run || r.run === run)).map(r => r.value);
  const runs = files.map((_, i) => i + 1).map(run => `run${run} A ${q(pick('A', run), .5).toFixed(2)} B ${q(pick('B', run), .5).toFixed(2)}`).join(' | ');
  const a = pick('A'), b = pick('B');
  console.log(`${profile} ${metric}: pooled n=${a.length}/${b.length} A median ${q(a, .5).toFixed(2)} [p25 ${q(a, .25).toFixed(2)} p75 ${q(a, .75).toFixed(2)}] B median ${q(b, .5).toFixed(2)} [p25 ${q(b, .25).toFixed(2)} p75 ${q(b, .75).toFixed(2)}] delta ${(q(b, .5) - q(a, .5)).toFixed(2)} MW z(A>B) ${mw(a, b).toFixed(2)} ; ${runs}`);
}
