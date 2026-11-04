# E06 worker-after-rows: measurement

2026-11-04. A = main (harness worktree, cb074cfa = 7f149be4 plus the test files). B = `perf/06-worker-after-rows`, commit 273573e8.

## The change

`js/main.js` registers the service worker at once only when a worker already controls the page. On a first visit it waits for `hub.firstSync()` (on the chat page this settles after the server's rows) or for 10 s, so the worker's install (9 fetches, 117 KB, over the network; the other shell files come from the HTTP cache) no longer shares the link with the boot.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/06-worker-after-rows perf/06-worker-after-rows
cd /home/agent/yap-perf/exp/06-worker-after-rows/Yap && dotnet build
cd /home/agent/yap-perf/harness/tests/browser && node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/06-worker-after-rows:E06-worker-after-rows --n=5 --profiles=far,near,lan --journeys=cold-open,warm-open --out=/home/agent/yap-perf/results/E06-worker-after-rows --port-a=5331 --port-b=5332
node probe-worker.mjs --a=/home/agent/yap-perf/harness --b=/home/agent/yap-perf/exp/06-worker-after-rows --port-a=5333 --port-b=5334 --out=<folder>/probe-result.json
node probe-detail.mjs probe-result.json
```

Harness wall time 4 min 15 s. All runs ended (no failed run), browser log empty. Ports as planned (5331/5332, proxies 5431/5432; probe 5333/5334, proxies 5433/5434).

## Result (medians, n = 5 per side, times in ms)

### far (900 ms round trip, 1 Mbit/s)

| journey | metric | A | B | Δ ms | Δ % | A min-max | B min-max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | html | 1191 | 1190 | -0.7 | -0.1% | 1189-1201 | 1188-1194 |
| cold-open | scripts | 13480 | 13449 | -30 | -0.2% | 13403-13692 | 13407-13705 |
| cold-open | bootstrap | 14500 | 14451 | -49 | -0.3% | 14427-14715 | 14428-14718 |
| cold-open | socket | 16705 | 16277 | -428 | -2.6% | 16659-16912 | 16254-16544 |
| cold-open | paint | 18081 | 17443 | -638 | -3.5% | 18004-18292 | 17422-17709 |
| cold-open | rows | 18081 | 17443 | -638 | -3.5% | 18004-18292 | 17422-17709 |
| cold-open | wire requests | 72 | 63 | -9 | -12.5% | 72-72 | 63-63 |
| cold-open | wire KB | 1006 | 879 | -127 | -12.6% | 1005-1006 | 878-879 |
| warm-open | paint | 97.1 | 76.4 | -20.7 | -21.3% | 68.6-107 | 56-88.8 |
| warm-open | rows | 3018 | 3019 | +0.8 | +0.0% | 3014-3043 | 2994-3025 |

### near (60 ms round trip, 20 Mbit/s)

| journey | metric | A | B | Δ ms | Δ % | A min-max | B min-max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts | 984 | 955 | -29 | -2.9% | 961-1023 | 898-991 |
| cold-open | bootstrap | 1103 | 1045 | -57 | -5.2% | 1063-1145 | 982-1111 |
| cold-open | socket | 1258 | 1184 | -74 | -5.9% | 1210-1286 | 1126-1250 |
| cold-open | rows | 1399 | 1329 | -70 | -5.0% | 1361-1456 | 1260-1393 |
| cold-open | wire requests | 72 | 63 | -9 | -12.5% | 72-72 | 62-63 |
| cold-open | wire KB | 1007 | 879 | -127 | -12.7% | 1007-1007 | 879-879 |
| warm-open | paint | 60.3 | 61.4 | +1.1 | +1.8% | 52.3-104 | 55.9-93.1 |
| warm-open | rows | 296 | 290 | -6.2 | -2.1% | 287-339 | 289-324 |

### lan (no proxy)

| journey | metric | A | B | Δ ms | Δ % | A min-max | B min-max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts | 76.5 | 66.1 | -10.4 | -13.6% | 70.7-82.5 | 62.9-78.8 |
| cold-open | bootstrap | 93.5 | 79.7 | -13.8 | -14.8% | 86.5-98.1 | 78.2-93.6 |
| cold-open | socket | 121 | 105 | -16.8 | -13.8% | 120-134 | 101-124 |
| cold-open | rows | 152 | 135 | -17.3 | -11.4% | 148-164 | 133-150 |
| warm-open | paint | 90 | 93.6 | +3.6 | +4.0% | 64.7-93.7 | 66.6-142 |
| warm-open | rows | 113 | 123 | +10.1 | +8.9% | 85.6-120 | 85.5-142 |

Inside the noise (thresholds of the brief: far 1%, near 3%, lan about 15%, every value under 100 ms 5 to 17%): far cold-open html, scripts and bootstrap; every warm-open row on every profile; every lan row. The far warm-open paint (-21%) is a value under 100 ms with overlapping ranges, and the change has no effect on a page with a controller, so it is noise. Above the noise: far cold-open socket (-2.6%) and rows (-3.5%), with no overlap of the ranges. Near cold-open rows (-5.0%) is above the 3% threshold, but the ranges overlap.

### The wire window

The harness reads the proxy's counters at the `rows` mark (`load()` in `perf-journeys.mjs`), not at the end of the run. On A the worker script and the install's 9 network fetches start before the rows, so they are inside the window. On B they start after the rows, so they are outside. The -127 KB and -9 requests are bytes that moved out of the window, not bytes saved. The probe shows it: at rows + 20 s both sides carried the same total (A 1012 KB and 72 requests, B 1012 KB and 72 requests; second run 1013 and 1013).

## Proof of mechanism (probe-worker.mjs, far settings, one cold open per side, two runs)

A fresh context with only the seed's cookie loads `/` through the harness's proxy, waits for `rows`, then 20 s more. The install's fetches are fetches of the worker (`cache.add`), so they are never resource entries of the page (the page showed 0 URLs fetched twice). The probe reads the worker's own resource entries (through `ctx.serviceWorkers()`, converted to the page's clock through the two `timeOrigin` values) and time-stamps every request line at the proxy.

| | run | rows mark | worker script request | first install fetch | install fetches end | wire at rows | wire at rows + 20 s | controller at the end |
| --- | --- | --: | --: | --: | --: | --: | --: | --- |
| A | 1 | 18142 | 13431 | 14452 (`/login`) | 18795 | 1005 KB, 72 req | 1012 KB, 72 req | yes (activated) |
| B | 1 | 17444 | 17464 | 18469 (`/login`) | 22077 | 877 KB, 62 req | 1012 KB, 72 req | yes (activated) |
| A | 2 | 17960 | 13449 | 14415 (`/login`) | - | 1006 KB, 72 req | 1013 KB, 72 req | yes (activated) |
| B | 2 | 17518 | 17530 | 18534 (first network fetch `/login` at 18540) | - | 879 KB, 63 req | 1013 KB, 72 req | yes (activated) |

- On A the install starts 3.5 to 3.7 s before the rows. Its 9 network fetches (`/login` 34 KB, `notif.mp3` 43 KB, `emoji-list.js` 19 KB, `icon-512.png` 11 KB, `icon-192.png` 8 KB, four small images; 117 KB) run from 14.45 s to 18.8 s. The hub's socket request (14552 ms) and the page's second bootstrap call go out in the same seconds.
- On B the worker script request comes 12 to 20 ms after the rows mark, and the first install fetch about 1.0 s later (one round trip for the worker script). The same 9 fetches, 117 KB, run from 18.5 s to 22.1 s.
- The worker installs and takes control on both sides. The harness confirms it: B's warm opens passed 5/5 on every profile, with 59 of 60 files from the cache, as on A.
- The gain lands where the install used to compete. Scripts and bootstrap do not move (the bootstrap request leaves at 13436 ms, before the install's first fetch). The socket (-428 ms) and the rows (-638 ms) move.

## Verdict

A clear gain on `far`: the server's rows of a first visit land 638 ms earlier (18.08 s to 17.44 s, -3.5%), well above the 1% noise, with no overlap of the five samples. The socket is 428 ms earlier. On `near` the rows land 70 ms earlier (-5.0%), above the 3% threshold, but the ranges overlap, so this is a probable small gain. On `lan` the 17 ms (-11.4%) is inside the noise. The far user on a first visit (a new device or a cleared browser) feels it. A returning visitor and a new build do not feel it, because a controller exists and the registration is immediate on both sides. Warm opens are flat on every profile.

## Caveats

- The test server speaks HTTP/1.1 through the proxy, so the browser has six connections. The install's 9 fetches also took connection slots from the page here. Over h2 in production that part goes away, and the bandwidth part stays (117 KB is about 0.94 s of a 1 Mbit/s link).
- The cost of B: on far the install finishes about 3.3 s later (22.1 s against 18.8 s from the navigation). A person who closes the tab within about 4.6 s of the rows leaves without an installed worker, and the next open is cold again. A page that never connects registers after 10 s.
- The far "wire KB" row of cold-open is a moved window, not a saving (see "The wire window").
- The first probe attempt failed: A's page did not reach the `rows` mark within 120 s, and that version of the probe printed no diagnostics. I added a screenshot and a log of the marks and the request lines on such a timeout, and ran the probe twice more. Both runs passed on both sides with consistent numbers. The cause of the first failure is unknown. The harness itself had no failed run.
- Files here: `probe-worker.mjs` (the probe), `probe-detail.mjs` (the per-request detail), `probe-result.json` and `probe.log` (run 1), `probe-result-2.json` and `probe-2.log` (run 2), `harness.log` (stdout of the harness run).
