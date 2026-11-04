# E05 sprites-webp-mp3: measurement

Branch `perf/05-sprites-webp-mp3`, commit e46721a3. A = the harness worktree (main 7f149be4 plus the test files, cb074cfa). B = the experiment. Measured 2026-11-04, 12:01 to 12:09 UTC.

## The change

The two emoji-toggle sprites `emoji_selection_color` and `emoji_selection_greys` go from PNG to lossless WebP (84,998 to 31,548 bytes together, identical pixels). `composer.css` points at the `.webp` files, `ShellAssets.cs` adds root `*.webp` to the worker's precache list, and `notif.mp3` loses its cover art (43,860 to 32,435 bytes, identical audio). The sum is 64,875 bytes (63.4 KiB) less, about 0.52 s of a 1 Mbit/s link.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/05-sprites-webp-mp3 perf/05-sprites-webp-mp3
cd /home/agent/yap-perf/exp/05-sprites-webp-mp3/Yap && dotnet build

# the probe (servers on 5343 and 5344, proxies on 5443 and 5444, `far`)
node /home/agent/yap-perf/results/E05-sprites-webp-mp3/probe-sprites.mjs

# the harness
cd /home/agent/yap-perf/harness/tests/browser
node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/05-sprites-webp-mp3:E05-sprites-mp3 --n=5 --profiles=far,near --journeys=cold-open,picker-emoji --out=/home/agent/yap-perf/results/E05-sprites-webp-mp3 --port-a=5341 --port-b=5342

# the per-run gaps (rows minus socket, rows minus scripts) from runs.json
node /home/agent/yap-perf/results/E05-sprites-webp-mp3/pairs.mjs
```

The harness run took 7 min 52 s. All 40 runs ended. The browser log has no page errors. Its `requestfailed` lines are emoji images that the picker journey aborts when it closes the page, on both sides.

## Result

Times in ms. Delta = B minus A, medians of 5 runs per side.

### far (900 ms round trip, 1 Mbit/s)

| journey | metric | A | B | delta | delta % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts ms | 13481 | 13526 | +44 | +0.3% | 13423..13658 | 13448..13676 |
| cold-open | socket ms | 16727 | 16758 | +32 | +0.2% | 16684..16884 | 16669..16895 |
| cold-open | rows ms | 18111 | 17923 | -188 | -1.0% | 17996..18177 | 17844..18063 |
| cold-open | rows minus socket (pairs.mjs) | 1377 | 1168 | -210 | -15% | 1293..1384 | 1164..1180 |
| cold-open | requests (files) | 60 | 60 | 0 | 0% | | |
| cold-open | KB (page files to rows) | 815 | 763 | -52.2 | -6.4% | 815..815 | 763..763 |
| cold-open | wire KB | 1006 | 943 | -62.8 | -6.2% | 1006..1006 | 942..943 |
| picker-emoji | first: grid ms | 26.6 | 27.6 | +1.0 | +3.8% | 24.7..40.8 | 23.4..32.4 |
| picker-emoji | first: images ms | 8649 | 8649 | -0.5 | 0.0% | 8647..8665 | 8648..8662 |
| picker-emoji | first: requests in 2 s | 408 | 408 | 0 | 0% | | |
| picker-emoji | again: images ms | 531 | 544 | +13 | +2.4% | 508..549 | 506..592 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 0 | 0% | | |

### near (60 ms round trip, 20 Mbit/s)

| journey | metric | A | B | delta | delta % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts ms | 990 | 940 | -50 | -5.0% | 961..1043 | 920..970 |
| cold-open | socket ms | 1238 | 1187 | -51 | -4.2% | 1195..1316 | 1170..1194 |
| cold-open | rows ms | 1381 | 1331 | -50 | -3.6% | 1332..1466 | 1305..1341 |
| cold-open | rows minus socket (pairs.mjs) | 140 | 138 | -2 | -1% | 137..150 | 135..154 |
| cold-open | requests (files) | 60 | 60 | 0 | 0% | | |
| cold-open | KB (page files to rows) | 815 | 763 | -52.2 | -6.4% | | |
| cold-open | wire KB | 1007 | 943 | -63.4 | -6.3% | 1007..1007 | 942..943 |
| picker-emoji | first: grid ms | 25.5 | 24.5 | -1.0 | -3.9% | 22.1..34.8 | 22.1..27.9 |
| picker-emoji | first: images ms | 969 | 948 | -22 | -2.2% | 894..1036 | 917..1138 |
| picker-emoji | first: requests in 2 s | 435 | 435 | 0 | 0% | | |
| picker-emoji | again: images ms | 536 | 553 | +17 | +3.2% | 494..561 | 488..595 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 0 | 0% | | |

The full tables are in `report.md`, every sample in `runs.json`.

Inside the noise (A/A: `far` 0.4% above 1 s, `near` 1.5%, under 100 ms 5 to 17%): far scripts, socket and every picker row; near every picker row. The near rows, socket and scripts deltas (-3.6 to -5.0%) are above the near threshold, but they are not this change (see the verdict).

## Proof of mechanism

### Byte counts

- Wire KB at the rows: -62.8 KB on far and -63.4 KB on near, the same in all 5 runs per side (A 1006.2 every run, B 942.4 to 943.4). The expected saving is 64,875 B = 63.4 KiB.
- Page KB (same-origin resource entries up to the rows): -52.2 KB. That is the two sprites alone (26,847 + 26,603 B = 52.2 KiB). The mp3 is not in this count, because the page does not ask for it during the boot. The worker does (below).

### The probe (`probe-sprites.mjs`, output in `probe-output.txt` and `probe-sprites.json`)

One cold open per side through the harness proxy on `far`, with the keeper page of perf.mjs. Then 20 s idle, a click on `.emoji-toggle-button`, and 5 s more. Requests come from Playwright's context events (with `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`, so the worker's fetches show), from the page's and the worker's resource timing, and from the proxy's request lines (what crossed the link). Times are ms from the navigation start.

| side | file | who asked | asked at | crossed the link at | before rows | bytes on the wire |
| --- | --- | --- | --: | --: | --- | --: |
| A | emoji_selection_color.png | worker install 14,458 and page (CSS) 14,535 | 14,458 | 14,544, once | yes (rows 18,080) | 46,187 (page); worker 0 |
| A | emoji_selection_greys.png | worker install 14,458 and page (CSS mask) 14,535 | 14,458 | 14,544, once | yes | 39,411 (page); worker 0 |
| A | notif.mp3 | worker install only, 14,458 | 14,458 | 16,497 | yes, done at 17,839 | 44,160 (worker) |
| A | notif.mp3 at the click | page (audio, `bytes=0-`) at 38,168 | | not at all | after | 0, the worker's cache |
| B | emoji_selection_color.webp | worker install 14,471 and page (CSS) 14,577 | 14,471 | 14,587, once | yes (rows 17,979) | 19,340 (page); worker 0 |
| B | emoji_selection_greys.webp | worker install 14,472 and page (CSS mask) 14,577 | 14,472 | 14,587, once | yes | 12,808 (page); worker 0 |
| B | notif.mp3 | worker install only, 14,472 | 14,472 | 16,100 | yes, done at 17,253 | 32,735 (worker) |
| B | notif.mp3 at the click | page (audio, `bytes=0-`) at 38,066 | | not at all | after | 0, the worker's cache |

What this shows:

- The worker installs during the boot on `far`: its first fetch is at 14.45 s, its precache list has 66 URLs, and the rows come at 18.0 s. So the install shares the link with the boot.
- Each sprite crosses the link once, before the rows. The page (CSS of the toggle in `index.html`) and the worker's install ask within 80 ms of each other. The browser sends one request and the worker's copy comes from the HTTP cache (its transfer size is 0). The sprites load after the `scripts` mark (13.5 s), because the composer shows only after the boot code runs.
- `notif.mp3` crosses the link only in the worker's install, before the rows. The page asks for it at the first pointer or key input (`notify.js`, `ensureAudio`). At the probe's click the worker was in control and answered from its cache, with 0 bytes on the wire.
- The served `service-worker.js` precache list: A names `/emoji_selection_color.png`, `/emoji_selection_greys.png` and `/notif.mp3`. B names `/emoji_selection_color.webp`, `/emoji_selection_greys.webp` and `/notif.mp3`, and no sprite PNG.
- Proxy totals of the probe, from the navigation to 5 s after the click: A 1,218 KB, B 1,155 KB (-63 KB). At the rows: A 1,005 KB, B 943 KB (-62 KB). So no changed byte crossed after the rows.

### Where the rows gain comes from (`pairs.mjs`)

On far, the `scripts` and `socket` phases do not move (+44 and +32 ms, 0.3% and 0.2%). The whole gain is between the socket and the rows: 1,377 ms on A, 1,168 ms on B. The ranges do not overlap (A 1,293 to 1,384, B 1,164 to 1,180). The rows' answer comes down the same link as the worker's install. It waits behind fewer bytes on B. The gain (210 ms) is about 40% of the 0.52 s of link time that the 63.4 KB cost. A likely reason for the smaller share: part of those bytes crossed while the boot waited on round trips (the socket's handshake), not on the link. This run does not prove that reason.

On near, the rows minus the socket does not change (140 against 138 ms). The near deltas of rows, socket and scripts (all about -50 ms) start at the `scripts` mark. That mark comes before any changed file is asked for (`main.js` marks `scripts` before it registers the worker, and the composer shows after the boot code). So the change cannot cause them. They are drift between the runs: A#5 is the slowest run (scripts 1,043, rows 1,466). The most the change can give on near is 64,875 B at 2.5 MB/s, which is 26 ms.

## Verdict

A clear gain on `far`, on a cold open only. Every first visit carries 63.4 KB less (exact, in all 10 runs). On `far` the rows come 188 ms sooner (median, -1.0%, at the trust threshold of 1%). The cleaner measure is the time from the socket to the rows: 210 ms less, with no overlap between the five A runs and the five B runs. The user who feels it is the far user (a slow mobile link) at a first visit, or at any open without the worker's cache. On `near` the gain is at most 26 ms and inside the noise; the measured -50 ms is drift, not the change. The emoji picker does not change on either profile: the sprites and the sound come from the worker's cache there. The probe shows that the sprites are the page's own boot requests (shared with the install) and that the mp3 loads only in the worker's install. Both cross the link before the rows on `far`.

## Caveats

- The proxy is one FIFO queue per direction for every connection, and the server speaks HTTP/1.1. The share of the 0.52 s that reaches the rows depends on that queue. A real link with TCP windows and HTTP/2 can give a different share.
- The saving for a returning device after a deploy is not measured. The sprite and mp3 URLs carry no build stamp, so a new worker's install can take them from the HTTP cache or get a 304. Then the new files give nothing at that install.
- The probe ran once per side, with `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` (the harness runs without it). Its times are single samples. Its byte counts agree with the harness's (-62 against -62.8 KB at the rows).
- Another agent changed `tests/browser/perf-journeys.mjs` in the harness worktree at 13:09 CET (uncommitted). This run started at 13:01 CET and had the file loaded already, so it used the committed version (cb074cfa).
- Other measurement agents ran on this machine at the same time. The runs alternate A, B, B, A, so drift hits both sides. The near scripts delta shows that drift of about 50 ms still remains at n=5.
- No failed runs, no reruns, no port changes (ports 5341/5342, proxies 5441/5442; the probe on 5343/5344, proxies 5443/5444). The probe's servers were stopped by `stop()`; afterwards nothing listened on their ports.
