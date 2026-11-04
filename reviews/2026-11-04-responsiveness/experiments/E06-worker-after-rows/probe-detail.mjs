// Prints the detail behind the probe's summary: the proxy's request lines from the worker script on, the worker's
// entries that went over the network, and when the install's last fetch ended. Run: node probe-detail.mjs <json>
import fs from 'node:fs';

const results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [key, r] of Object.entries(results)) {
  const origin = `http://127.0.0.1:${r.port + 100}`;
  const short = u => u.replace(origin, '').replace(/\?v=[^&]+/, '?v=…');
  const sw = r.proxyLines.find(l => /service-worker\.js/.test(l.line));
  console.log(`\n== ${key}: rows ${Math.round(r.marks.rows)} ms, socket ${Math.round(r.marks.socket)} ms`);
  console.log('proxy request lines from the worker script on:');
  for (const l of r.proxyLines.filter(l => sw && l.at >= sw.at)) console.log(`  ${Math.round(l.at)} ${short(l.line)}`);
  const entries = r.worker?.entries ?? [];
  const install = entries.filter(e => e.startInPage < (sw?.at ?? 0) + 5000);   // the install's burst, not later page fetches
  console.log(`worker entries: ${entries.length}; the first ${Math.round(Math.min(...entries.map(e => e.startInPage)))} ms, the last end ${Math.round(Math.max(...entries.map(e => e.endInPage)))} ms`);
  console.log('worker entries with bytes on the network:');
  for (const e of entries.filter(e => e.transfer > 0)) console.log(`  ${Math.round(e.startInPage)}-${Math.round(e.endInPage)} ${short(e.name)} ${e.initiator} ${Math.round(e.transfer / 102.4) / 10} KB`);
  const late = r.pageResources.filter(e => e.start > (sw?.at ?? Infinity));
  console.log(`page resources after the worker script request: ${late.length} (${late.slice(0, 6).map(e => `${Math.round(e.start)} ${short(e.name)}`).join(', ')})`);
  const names = r.pageResources.map(e => e.name);
  console.log(`page resources fetched twice: ${names.filter((n, i) => names.indexOf(n) !== i).length}; initiator types: ${[...new Set(r.pageResources.map(e => e.initiator))].join(', ')}`);
}
