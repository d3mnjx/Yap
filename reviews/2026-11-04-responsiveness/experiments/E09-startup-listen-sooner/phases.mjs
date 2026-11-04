// Splits each counted start of starts.json into phases, from the arrival times (ms since the spawn) that
// perf-start.mjs wrote before every server log line. It shows where B's earlier "Now listening" comes from.
//   prefix   spawn to "Loaded link preview settings": the runtime, the migrations check, users, links, mutes
//   probes   to the last of the three probe lines (video ffmpeg, GIF ffmpeg, yt-dlp): side by side on B
//   chat     to "Loaded N channels": the chat load
//   tail     to "Now listening": GIFs, pins, push, bot, and on A the action-log cleanup
// Run: node phases.mjs [starts.json]

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'starts.json');
const { samples } = JSON.parse(fs.readFileSync(file, 'utf8'));

function at(lines, re) {
  const line = lines.find(l => re.test(l));
  return line ? Number(/^\+(\d+)/.exec(line)[1]) : null;
}

const rows = samples.filter(s => !s.warmup).map(s => {
  const lines = fs.readFileSync(s.log, 'utf8').split('\n');
  const preview = at(lines, /Loaded link preview settings/);
  const probes = [/FFmpeg detected and available|FFmpeg not found/, /ffmpeg detected for GIF pipeline|GIF transcoding will be unavailable/, /yt-dlp detected|yt-dlp not found/]
    .map(re => at(lines, re));
  const probesEnd = probes.includes(null) ? null : Math.max(...probes);
  const chat = at(lines, /Loaded \d+ channels/);
  const listen = at(lines, /Now listening on/);
  const d = (a, b) => a !== null && b !== null ? b - a : null;
  return { side: s.side, label: s.label, prefix: preview, probes: d(preview, probesEnd), chat: d(probesEnd, chat), tail: d(chat, listen), listen };
});

const median = xs => { const v = xs.filter(x => x !== null).sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
console.log('phase    A median  B median  delta ms   A min..max   B min..max');
for (const k of ['prefix', 'probes', 'chat', 'tail', 'listen']) {
  const a = median(rows.filter(r => r.side === 'A').map(r => r[k])), b = median(rows.filter(r => r.side === 'B').map(r => r[k]));
  const span = side => { const v = rows.filter(r => r.side === side).map(r => r[k]).filter(x => x !== null); return `${Math.min(...v)}..${Math.max(...v)}`.padStart(12); };
  console.log(`${k.padEnd(8)} ${String(a).padStart(8)}  ${String(b).padStart(8)}  ${String(b - a).padStart(8)}  ${span('A')}  ${span('B')}`);
}
