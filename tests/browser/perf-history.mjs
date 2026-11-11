// The memory of perf.mjs. `perf.mjs --record` measures one build and hands the result to saveRecord: one JSON file per
// run in perf-history/, and perf-history/README.md written again from all of them (the tables a person reads).
//
// Why files in the repo: the numbers are compared weeks apart, and neither the sandbox that measured them nor its
// ~/yap-perf folder lives that long (the results of the review of 2026-11-04 were deleted the same day). One file per
// run keeps an old record out of every later diff.
//
// A record is one build on the full plan (perf.mjs refuses --record with a narrower one), so every record holds the
// same rows and two of them compare cell by cell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HISTORY = fileURLToPath(new URL('./perf-history/', import.meta.url));

// The columns of the history tables: [title, journey, metric, what it is]. One number per thing a person feels; every
// other metric of a run stays in its JSON file. The metric is a prefix, because the room change carries the room's
// size in its name ("to lobby (20000) ms").
const HEADLINE = [
  ['first visit', 'cold-open', 'rows ms', 'A new device opens the app. From the navigation start to the server\'s rows on screen.'],
  ['first visit KB', 'cold-open', 'wire KB', 'The bytes of that first visit on the link, both ways. Not a time: it changes only when the app\'s files change. `lan` has no proxy to count them.'],
  ['warm open', 'warm-open', 'rows ms', 'A device that holds the app opens it again. From the navigation start to the server\'s rows on screen.'],
  ['resume', 'resume', 'return to rows ms', 'The app comes back after 35 s in the background with a dead socket. From the return to a message that arrived in between.'],
  ['send: own row', 'send', 'own row ms', 'From the Enter key to the own message in the list.'],
  ['send: confirmed', 'send', 'confirmed ms', 'From the Enter key to the server\'s confirmation on that message.'],
  ['to the lobby', 'switch-room', 'to lobby', 'From the click on the busiest room (20,000 messages) to its rows, with no loading mark left.'],
  ['older page', 'older', 'page landed ms', 'From the scroll to the top to the older messages in the list. It includes the 200 ms the app waits for a still view.'],
  // The fifth entry is this column's own noise: the images come from the real CDN, outside the proxy, and off `far`
  // the CDN is most of the number (two records of one build an hour apart: -17% on `near`, +84% on `lan`).
  ['emoji picker', 'picker-emoji', 'first: images ms', 'The first open on a device. From the click to every visible emoji image complete. The images come from the real CDN, outside the proxy, so on `near` and `lan` this number follows the CDN and not the app.', { near: 100, lan: 100 }],
  ['GIF picker', 'picker-gif', 'first: grid ms', 'The first open on a device. From the click to the grid.'],
  ['machine check', 'machine', 'fixed work ms', 'Not the app: a fixed piece of work on a blank page, at the start of the profile. It says how fast the machine was at that minute. It moves by 20% inside one quiet run, so only a larger difference between two records means a faster or a slower machine.'],
];

// How far a number moves between two records of the same build on the same machine, in percent. A change below it
// is noise. Measured on 2026-11-11 with two records of one build, an hour apart, the sandbox quiet both times: `far`
// moved 0.2% at most (the link is the number), `near` 3% but for the warm open (9%), `lan` up to 18%. Inside one run
// the noise is much smaller (A against A: 0.4%, 1.5%, 5 to 17%), which is why a question about one change is an A/B
// run and not two records.
const NOISE = { far: 1, near: 10, lan: 20 };
const SMALL = 100;   // ms: below it a value moves like `lan`, whatever the link
const FLOOR = 2;     // ms: a smaller change is never a finding (the own row of a send takes 1.3 to 2.2 ms)

export const machine = () => `${os.platform()} ${os.arch()}, ${os.cpus().length} x ${os.cpus()[0]?.model.trim() ?? 'unknown CPU'}`;

const fmt = x => x == null ? '—' : Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 10) / 10);
const value = (record, profile, [, journey, metric]) => record.rows.find(r => r[0] === profile && r[1] === journey && r[2].startsWith(metric))?.[3] ?? null;
const name = record => `${record.commit}${record.dirty ? '*' : ''}`;

export function readRecords() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readdirSync(HISTORY).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')));
}

// `head`: { date ("2026-11-11 14:05", UTC), commit, subject, dirty, machine, chromium, n, failed, minutes }.
// `rows`: [profile, journey, metric, median, min, max, samples] for every metric of the run.
// `describe`: profile -> its link in words, in the order of the tables.
// Returns the comparison against the record before this one, as markdown for the run's report.
export function saveRecord(head, rows, describe) {
  const earlier = readRecords();
  const record = { ...head, rows };
  fs.mkdirSync(HISTORY, { recursive: true });
  // One metric per line: a record reads and diffs as a table, which JSON.stringify's indent would turn into 1,500 lines.
  const text = `{\n${Object.entries(head).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n "rows": [\n${rows.map(r => `  ${JSON.stringify(r)}`).join(',\n')}\n ]\n}\n`;
  fs.writeFileSync(path.join(HISTORY, `${head.date.replace(' ', '-').replace(':', '')}-${head.commit}.json`), text);
  writeReadme([...earlier, record], describe);
  // The same machine first: a faster or slower one moves `lan` and `near` without any change in the app.
  const previous = earlier.findLast(r => r.machine === record.machine) ?? earlier.at(-1);
  return previous ? against(previous, record, describe) : '## The first record\n\nNo earlier record to compare with.\n';
}

function against(previous, record, describe) {
  const cell = (profile, column) => {
    const was = value(previous, profile, column), now = value(record, profile, column);
    if (was == null || now == null) return fmt(now);
    const pct = was ? (now - was) / was * 100 : 0;
    const noise = column[4]?.[profile] ?? (Math.min(was, now) < SMALL ? NOISE.lan : NOISE[profile] ?? NOISE.lan);
    const text = `${fmt(was)} → ${fmt(now)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    return Math.abs(pct) > noise && Math.abs(now - was) >= FLOOR ? `**${text}**` : text;
  };
  const profiles = Object.keys(describe);
  const lines = [
    `## Against the record of ${previous.date} (${name(previous)})`, '',
    `Medians, ms. Bold: a change above the noise between two records (${profiles.map(p => `${p} ${NOISE[p]}%`).join(', ')}; ${NOISE.lan}% for any time under ${SMALL} ms; never a change under ${FLOOR} ms).`,
    ...(previous.machine === record.machine ? [] : [`That record comes from another machine (${previous.machine}), and a machine's speed moves \`lan\` and \`near\` without any change in the app.`]),
    '', `| | ${profiles.join(' | ')} |`, `| --- | ${profiles.map(() => '--:').join(' | ')} |`,
    ...HEADLINE.map(column => `| ${column[0]} | ${profiles.map(p => cell(p, column)).join(' | ')} |`), '',
  ];
  return lines.join('\n');
}

// Exported for the one case outside a record: a change to HEADLINE or NOISE, after which the page is written again
// from the files (`writeReadme(readRecords(), describe)`).
export function writeReadme(records, describe) {
  const lines = [
    '# Responsiveness over time', '',
    '`npm run perf -- --record` writes this page and one JSON file per run. Do not edit the page by hand; "The performance',
    'harness" in `../README.md` says how to add a record.', '',
    'Each row is one run of `perf.mjs` on one build: one person on a server with 50,000 messages, through three links.',
    'The numbers are medians of the run\'s repetitions, in ms. The JSON file of a run holds every metric with its min',
    'and max. A `*` after a commit marks a build with uncommitted changes to the app.', '',
  ];
  for (const [profile, link] of Object.entries(describe)) {
    lines.push(`## ${profile} (${link})`, '', `| date (UTC) | commit | ${HEADLINE.map(c => c[0]).join(' | ')} |`, `| --- | --- | ${HEADLINE.map(() => '--:').join(' | ')} |`);
    for (const r of records) lines.push(`| ${r.date} | ${name(r)} | ${HEADLINE.map(c => fmt(value(r, profile, c))).join(' | ')} |`);
    lines.push('');
  }
  lines.push('## The columns', '', ...HEADLINE.map(c => `- **${c[0]}**: ${c[3]}`), '',
    `How far a number moves between two records of one build on one machine: ${Object.entries(NOISE).map(([p, pct]) => `${pct}% on \`${p}\``).join(', ')}, and ${NOISE.lan}% for any time under ${SMALL} ms. A smaller change is noise. The two records of 2026-11-11 are the same build, an hour apart, and show it.`,
    'For a question about one change, measure the two builds side by side in one run (`--a` and `--b`): the noise inside a run is much smaller.', '',
    '## The runs', '', '| date (UTC) | commit | its subject | machine | Chromium | repetitions | failed runs | minutes |', '| --- | --- | --- | --- | --- | --: | --: | --: |',
    ...records.map(r => `| ${r.date} | ${name(r)} | ${r.subject.replaceAll('|', '\\|')} | ${r.machine} | ${r.chromium} | ${r.n} | ${r.failed} | ${r.minutes ?? '—'} |`), '');
  fs.writeFileSync(path.join(HISTORY, 'README.md'), lines.join('\n'));
}
