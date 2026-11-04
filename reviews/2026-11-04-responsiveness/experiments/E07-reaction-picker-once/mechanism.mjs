// The proof of mechanism for E07, from the harness's own samples (runs.json of picker-reaction and
// phone-picker-reaction): the cell buttons each page built during its five opens, and per side the ratio of open 1 to
// the later opens. Run: node mechanism.mjs [runs.json] (default: the runs.json next to this file).
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'runs.json');
const { records } = JSON.parse(fs.readFileSync(file, 'utf8'));
const median = v => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const pick = (profile, journey, side, metric) => records.filter(r => r.profile === profile && r.journey === journey && r.side === side && r.metric === metric);

for (const profile of [...new Set(records.map(r => r.profile))]) {
  for (const journey of [...new Set(records.filter(r => r.profile === profile).map(r => r.journey))]) {
    console.log(`\n${profile} ${journey}`);
    for (const side of ['A', 'B']) {
      const cells = pick(profile, journey, side, 'cells built').map(r => r.value);
      const first = median(pick(profile, journey, side, 'open 1: grid').map(r => r.value));
      const later = median(pick(profile, journey, side, 'later opens: grid').map(r => r.value));
      const ratio = first != null && later ? (first / later).toFixed(2) : '—';
      console.log(`  ${side}: cells built per page ${JSON.stringify(cells)}; open 1 ${first} ms, later opens ${later} ms, open 1 / later ${ratio}`);
    }
  }
}
