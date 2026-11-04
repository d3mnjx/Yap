// The reconnect after the outage without the retry tick: from the start of the attempt that opened (the negotiate
// request on main, the direct socket on the branch) to connected(). Reads runs.json of the probe.
import fs from 'node:fs';
const runs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const median = v => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rows = {};
for (const d of runs.details) {
  const ok = d.attempts.map(a => /^(\d+) ms (negotiate: 200|ws direct: 101|ws negotiated: 101)/.exec(a)).filter(Boolean);
  const first = Number(ok[0][1]);
  const connectedAt = d.stopToBack + d.backToConnected;
  (rows[`${d.profile} ${d.side}`] ??= []).push({ tickToConnected: connectedAt - first, tick: first, stopToBack: d.stopToBack });
}
for (const [k, v] of Object.entries(rows)) {
  const t = v.map(x => x.tickToConnected);
  console.log(`${k}: attempt-to-connected median ${median(t)} ms, min ${Math.min(...t)}, max ${Math.max(...t)}; ticks ${v.map(x => x.tick).join(' ')}; stop-to-back ${v.map(x => x.stopToBack).join(' ')}`);
}
// The resume samples per side, for the record.
for (const p of runs.profiles) for (const m of ['resume after outage: rows ms', 'control resume: rows ms']) for (const s of ['A', 'B']) {
  const v = runs.records.filter(r => r.profile === p && r.metric === m && r.side === s);
  console.log(`${p} ${m} ${s}: ${v.map(r => `${r.value}(${r.negotiate})`).join(' ')}`);
}
