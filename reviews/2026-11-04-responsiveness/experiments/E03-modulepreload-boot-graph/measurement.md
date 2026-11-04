# E03 modulepreload boot graph: measurement

Measured 2026-11-04, 11:47 to 11:52 UTC. A = main (harness worktree, cb074cfa = main 7f149be4 plus the test files).
B = branch `perf/03-modulepreload-boot-graph`, commit c3a3bbde (on top of 7f149be4).

## The change

`Yap/Endpoints/ShellAssets.cs` adds a hand-kept list `LazyModules` of six modules that only a page opened from
inside the app needs (pages/admin, pages/settings, pages/settings-debug, pages/channel-settings, ui/gif-library,
ui/tooltip), and leaves them out of the shell's `modulepreload` links: 42 links become 36. The import map and the
worker's shell list keep all 43 modules, so the pages still import them on first use.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/03-modulepreload-boot-graph perf/03-modulepreload-boot-graph
cd /home/agent/yap-perf/exp/03-modulepreload-boot-graph/Yap && bash -l -c "dotnet build"      # 0 warnings, 0 errors
cd /home/agent/yap-perf/harness/tests/browser && node perf.mjs --a=/home/agent/yap-perf/harness:main \
  --b=/home/agent/yap-perf/exp/03-modulepreload-boot-graph:E03-modulepreload --n=5 --profiles=far,near,lan \
  --journeys=cold-open,warm-open --out=/home/agent/yap-perf/results/E03-modulepreload-boot-graph --port-a=5321 --port-b=5322
cd /home/agent/yap-perf/harness/tests/browser && node /home/agent/yap-perf/results/E03-modulepreload-boot-graph/probe-preloads.mjs
rm -rf /home/agent/yap-perf/exp/03-modulepreload-boot-graph/Yap/bin /home/agent/yap-perf/exp/03-modulepreload-boot-graph/Yap/obj
cd /d/PROJECTS/Yap && git worktree remove --force /home/agent/yap-perf/exp/03-modulepreload-boot-graph
```

Wall time of the harness run: 4 min 18 s. All 60 runs ended. The browser log is empty (0 lines, 0 page errors).
The probe ran after the harness run, so its two servers did not load the machine during the measured runs.

## Result

Times in ms from the navigation start, medians of 5 runs per side. "B lower" counts the pairs (same repetition)
where B is below A.

### Cold open (a new device: no HTTP cache, no worker)

| profile | metric | A | B | Δ ms | Δ % | A min to max | B min to max | B lower |
| --- | --- | --: | --: | --: | --: | --: | --: | --: |
| far | scripts ms | 13492 | 12269 | -1223 | -9.1% | 13398 to 13686 | 12144 to 12298 | 5/5 |
| far | bootstrap ms | 14515 | 13291 | -1223 | -8.4% | 14420 to 14726 | 13167 to 13331 | 5/5 |
| far | socket ms | 16721 | 15859 | -862 | -5.2% | 16624 to 16950 | 15744 to 15923 | 5/5 |
| far | rows ms | 18102 | 17033 | -1069 | -5.9% | 17933 to 18321 | 16910 to 17090 | 5/5 |
| far | requests (files) | 60 | 54 | -6 | -10.0% | 60 | 54 | |
| far | KB (page) | 815 | 755 | -59.5 | -7.3% | 815 | 755 | |
| far | wire requests | 72 | 69 | -3 | -4.2% | 72 | 69 | |
| far | wire KB | 1006 | 959 | -47.4 | -4.7% | 1006 | 959 | |
| near | scripts ms | 972 | 871 | -101 | -10.4% | 933 to 1388 | 823 to 1347 | 5/5 |
| near | bootstrap ms | 1092 | 996 | -96 | -8.8% | 1053 to 1521 | 945 to 1506 | 5/5 |
| near | socket ms | 1350 | 1212 | -138 | -10.2% | 1199 to 1845 | 1098 to 1774 | 4/5 |
| near | rows ms | 1539 | 1389 | -149 | -9.7% | 1334 to 1989 | 1242 to 1916 | 4/5 |
| near | requests (files) | 60 | 54 | -6 | -10.0% | 60 | 54 | |
| near | wire requests | 71 | 65 | -6 | -8.5% | 65 to 72 | 62 to 69 | 4/5 |
| near | wire KB | 1004 | 938 | -66.5 | -6.6% | 939 to 1007 | 930 to 1002 | 4/5 |
| lan | scripts ms | 80.1 | 82.1 | +2.0 | +2.5% | 74.3 to 85.9 | 64.5 to 112 | 3/5 |
| lan | bootstrap ms | 101 | 105 | +3.5 | +3.5% | 95.4 to 110 | 84.8 to 136 | 3/5 |
| lan | socket ms | 142 | 143 | +0.9 | +0.6% | 132 to 158 | 118 to 180 | 4/5 |
| lan | rows ms | 182 | 182 | 0 | 0.0% | 172 to 224 | 150 to 220 | 3/5 |
| lan | requests (files) | 60 | 54 | -6 | -10.0% | 60 | 54 | |

`lan` has no proxy, so it has no wire rows.

### Warm open (the control: the worker's cache holds every module)

| profile | metric | A | B | Δ ms | Δ % | A min to max | B min to max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| far | paint ms | 69.3 | 60.4 | -8.9 | -12.8% | 58.3 to 99.8 | 57.2 to 96.1 |
| far | rows ms | 3002 | 3002 | +0.3 | 0.0% | 2964 to 3052 | 2998 to 3041 |
| near | paint ms | 58.1 | 61.9 | +3.8 | +6.5% | 54.8 to 99.5 | 53.4 to 91.8 |
| near | rows ms | 291 | 298 | +6.8 | +2.3% | 284 to 327 | 289 to 325 |
| lan | paint ms | 61.0 | 64.1 | +3.1 | +5.1% | 56.5 to 96 | 59.6 to 86.9 |
| lan | rows ms | 79.9 | 81.9 | +2.0 | +2.5% | 75.5 to 123 | 77.6 to 113 |

The warm page reads 54 files instead of 60 (53 from the cache instead of 59) on every profile. The wire does not
change (far 3 requests and 35.7 KB, near 2 and 28.7 KB, on both sides).

### Noise

The A/A noise of the instrument: `far` within 0.4% above 1 s, `near` within 1.5%, `lan` and values under 100 ms
within 5 to 17%.

- Far cold open: every phase from `scripts` on is 5.2% to 9.1% lower. The ranges do not overlap (A's fastest
  `scripts` is 13398, B's slowest is 12298). This is far above the noise.
- Near cold open: 8.8% to 10.4% lower, above the 3% bar. The ranges overlap because of one slow pair (repetition 5:
  A 1989, B 1916 for `rows`). B is lower in 5 of 5 pairs for `scripts` and `bootstrap`, 4 of 5 for `socket` and
  `rows`. This is a gain above the noise, less firm than on far.
- Lan cold open: every delta is 0% to 3.5%, inside the noise.
- Warm open, all profiles: `rows` moves 0.0% to 2.5%, inside the noise. `paint` is under 100 ms, and its -12.8%
  (far) to +6.5% (near) sit inside the 5 to 17% band, with the ranges fully overlapping. The control holds.

## Proof of mechanism

`probe-preloads.mjs` (in this folder; its output is `probe-output.txt`) starts A on 5323 and B on 5324 with
`lib.mjs` `startServer` on a copy of the seed, signs in the seed's measured user (`ada`) with `perf-seed.mjs`
`signInToken`, and fetches `/` with `curl -s` and the `yap_auth` cookie. It stops each server through its own
child process (`server.stop()`), so it touched no other agent's server.

| | A (main) | B (E03) |
| --- | --: | --: |
| GET / as ada | 200, 102,545 B | 200, 102,058 B |
| `rel="modulepreload"` links | **42** | **36** |
| import map entries | 43 | 43 |
| worker list, js modules | 43 | 43 |
| cold-open files (report.md `requests`, all profiles) | 60 | 54 |

Preloaded on A and not on B (6): `/js/pages/admin.js`, `/js/pages/channel-settings.js`,
`/js/pages/settings-debug.js`, `/js/pages/settings.js`, `/js/ui/gif-library.js`, `/js/ui/tooltip.js`. Nothing is
preloaded on B that A does not preload. The six missing links are exactly the six missing files of the cold-open
count.

A stamped module answers `Cache-Control: public, max-age=31536000, immutable` on both sides.

## Why far saves 6 files but only 3 wire requests

The worker's install calls `cache.add` for every URL of its shell list, all 43 modules among them, through the HTTP
cache. On A the page preloaded the six modules, so the install finds them in the HTTP cache (immutable) and nothing
crosses the link. On B the page did not preload them, so the install fetches them over the link. On far, 3 of those
6 fetches cross before `rows`, so the wire at `rows` shows -3 requests and -47 KB, not -6 and -60. On near the
install's timing varies (65 to 72 wire requests on A, 62 to 69 on B), and the median shows -6.

This is an inference from the counts and the header. The proxy's request lines are not saved per run, so the run does
not list which files crossed. It means a first visit still downloads the six modules (about 60 KB), once, through
the worker. B moves them out of the page's boot graph and into the worker's install. The bytes of a whole first
visit stay about the same; the bytes before the first rows fall.

## Verdict

A clear gain on the cold open for a person on a slow link. On `far` (900 ms round trip, 1 Mbit/s) the first visit
shows the lobby's rows 1.07 s sooner (18.10 s to 17.03 s, -5.9%), and `scripts` and `bootstrap` end 1.22 s sooner
(-9.1%, -8.4%), in 5 of 5 pairs, far above the 0.4% noise. On `near` the first visit is about 150 ms sooner (-9.7%),
above the noise but with overlapping ranges. On `lan` it is inside the noise, as expected: there the six files cost
almost nothing. The warm open, which is every start after the first, does not move on any profile: the control holds.
The person who feels it is a new user, or a user on a new device, on a slow or mobile link, once per device and once
after each deploy (a new build stamp is a new set of URLs).

## Caveats

- The harness speaks HTTP/1.1 without TLS, so the browser has six connections. Six fewer requests in a queue of 42
  remove about one wave of round trips on far (about 0.9 s) plus about 60 KB of link time (about 0.5 s at
  1 Mbit/s). Production speaks h2, where a file count costs less: expect a smaller gain there, nearer the byte part.
- The trade-off of the commit is not measured: a load that starts on `/settings`, `/admin` or a channel's settings
  (a reload there, or the first load after a deploy) now imports that page after `main.js` runs. No journey of the
  harness starts on those routes.
- The phone rows (`phone-cold-open` on near) were not in this run.
- The six modules still download on a first visit, through the worker's install (see above). The gain is in the
  order of the downloads, not in their total.
- If E06 (worker after rows) lands too, the worker's install would start after `rows`, and the far wire saving
  before `rows` would likely grow from 3 to 6 requests. The two experiments touch the same first-visit window and
  are best measured together before both land.
- `ss` is not installed in this sandbox. I checked my ports with `curl` after the run (5321 to 5324 answer
  nothing). No port change was needed.
