# E01 compression-optimal: measurement

Branch `perf/01-compression-optimal`, commit 9c623d93, against A = the harness worktree (main 7f149be4 plus the test files, cb074cfa). Measured 2026-11-04.

## The change

`Yap/Program.cs` sets the Brotli and gzip providers of the response-compression middleware to `CompressionLevel.Optimal` (Brotli quality 4, gzip level 6) instead of the framework default `Fastest` (quality 1, level 1). Compressed bodies get smaller, and each compressed response costs more server CPU.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/01-compression-optimal perf/01-compression-optimal
cd /home/agent/yap-perf/exp/01-compression-optimal/Yap && dotnet build
cd /home/agent/yap-perf/harness/tests/browser && node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/01-compression-optimal:E01-compression-optimal --n=5 --profiles=far,near,lan --journeys=cold-open,warm-open --out=/home/agent/yap-perf/results/E01-compression-optimal --port-a=5311 --port-b=5312
cd /home/agent/yap-perf/harness/tests/browser && node /home/agent/yap-perf/results/E01-compression-optimal/probe.mjs
rm -rf /home/agent/yap-perf/exp/01-compression-optimal/Yap/bin /home/agent/yap-perf/exp/01-compression-optimal/Yap/obj
cd /d/PROJECTS/Yap && git worktree remove --force /home/agent/yap-perf/exp/01-compression-optimal
```

The harness run took 4 min 13 s. All 60 runs ended, with no failed runs, no reruns and no port changes. The browser log is empty.

## Result

Medians of 5 runs per side, in ms unless named. "Overlap" says whether the A and B sample ranges (min to max) overlap.

### far (900 ms round trip, 1 Mbit/s)

| journey | metric | A | B | Δ | Δ % | A min-max | B min-max | overlap |
| --- | --- | --: | --: | --: | --: | --: | --: | --- |
| cold-open | html ms | 1190 | 1094 | -95.6 | -8.0% | 1189-1192 | 1093-1099 | no |
| cold-open | scripts ms | 13481 | 13217 | -263 | -2.0% | 13423-13560 | 13202-13292 | no |
| cold-open | socket ms | 16700 | 16308 | -392 | -2.3% | 16646-16783 | 16289-16374 | no |
| cold-open | rows ms | 17996 | 17673 | -322 | -1.8% | 17949-18078 | 17575-17685 | no |
| cold-open | requests (files) | 60 | 60 | 0 | 0% | | | |
| cold-open | KB (page, transferSize) | 815 | 739 | -75.5 | -9.3% | | | |
| cold-open | wire KB | 1006 | 914 | -92.6 | -9.2% | 1005-1006 | 914-914 | no |
| warm-open | paint ms | 92.3 | 71.0 | -21.3 | -23.1% | 66.1-118 | 57-111 | yes |
| warm-open | rows ms | 3016 | 3024 | +7.5 | +0.2% | 3002-3044 | 2999-3050 | yes |

### near (60 ms round trip, 20 Mbit/s)

| journey | metric | A | B | Δ | Δ % | A min-max | B min-max | overlap |
| --- | --- | --: | --: | --: | --: | --: | --: | --- |
| cold-open | html ms | 78.5 | 76.7 | -1.8 | -2.3% | 77.8-81.9 | 76.4-78.9 | yes |
| cold-open | scripts ms | 935 | 858 | -77.1 | -8.2% | 892-974 | 850-880 | no |
| cold-open | socket ms | 1199 | 1118 | -80.7 | -6.7% | 1114-1212 | 1083-1138 | yes |
| cold-open | rows ms | 1345 | 1277 | -67.6 | -5.0% | 1252-1353 | 1225-1317 | yes |
| cold-open | requests (files) | 60 | 60 | 0 | 0% | | | |
| cold-open | wire KB | 1007 | 914 | -92.6 | -9.2% | | | |
| warm-open | paint ms | 59.3 | 58.5 | -0.8 | -1.3% | 55.8-77.9 | 55.9-103 | yes |
| warm-open | rows ms | 295 | 299 | +4.0 | +1.4% | 283-305 | 281-327 | yes |

### lan (no proxy): the cost side

| journey | metric | A | B | Δ | Δ % | A min-max | B min-max | overlap |
| --- | --- | --: | --: | --: | --: | --: | --: | --- |
| cold-open | html ms | 3.3 | 4.7 | +1.4 | +42.4% | 3.1-4.3 | 4.3-4.8 | touch at 4.3 |
| cold-open | scripts ms | 70.9 | 71.8 | +0.9 | +1.3% | 65.8-75.8 | 65.2-87.9 | yes |
| cold-open | socket ms | 118 | 135 | +16.6 | +14.1% | 114-130 | 117-142 | yes |
| cold-open | rows ms | 156 | 164 | +8.2 | +5.3% | 147-171 | 149-188 | yes |
| cold-open | requests (files) | 60 | 60 | 0 | 0% | | | |
| cold-open | KB (page) | 815 | 739 | -75.5 | -9.3% | | | |
| warm-open | paint ms | 64.8 | 86.0 | +21.2 | +32.7% | 57.6-97.7 | 66.9-112 | yes |
| warm-open | rows ms | 83.7 | 96.0 | +12.3 | +14.7% | 75.8-130 | 86.7-153 | yes |

### Which deltas are inside the noise

- far, cold open: every delta is above the 1% threshold, and every B sample beats every A sample on html, scripts, socket and rows. The html gain (95.6 ms) equals the byte time of the page's saving (12,185 bytes at 125,000 B/s is 97.5 ms). The rows gain (322 ms) is 42% of the byte time of the whole wire saving (92.6 KB is about 760 ms at 1 Mbit/s). The rest of the saved bytes cross the link while the page waits on round trips, so they do not shorten the path.
- near, cold open: scripts (-8.2%), socket (-6.7%) and rows (-5.0%) are above the 3% threshold, and the scripts ranges do not overlap. But 92.6 KB at 20 Mbit/s is only 37 ms of byte time, and the measured gain is about twice that. Part of the near gain is probably drift. A careful reading is 40 to 80 ms.
- warm open, every profile: inside the noise. The ranges overlap fully, and the sign changes from profile to profile (paint -23% on far, +33% on lan). The worker's cache answers 59 of the 60 files, so the compression level cannot move the warm paint. The warm rows wait for the server's JSON, which shrinks a little (page KB 2.9 to 2.3), with no time effect above the noise.
- lan, cold open: html +1.4 ms is above the noise in relative terms (B is at or above every A sample), and it agrees with the probe below (+0.5 ms per 100 KB page on an idle server). The socket (+14.1%) and rows (+5.3%) deltas are inside the 15% lan noise.
- The file count does not change (60 page requests, 72 wire requests on both sides), as expected for a change of the compression level.

## Proof of mechanism

Probe: `/home/agent/yap-perf/results/E01-compression-optimal/probe.mjs`, output in `probe-output.txt` next to it. It starts two short-lived memory-only servers with `startServer()` of `lib.mjs` (A on 5313, B on 5314, both up at once), and stops them by their own child process. Each byte count is the brief's `curl -s -H "Accept-Encoding: br" -o /dev/null -w "%{size_download} %{http_code}\n"`. The stylesheet lives at `/app.css` (index.html links `app.css?v=`). `/css/app.css` does not exist, so the probe uses `/app.css`.

| path | status A/B | uncompressed | br A (Fastest) | br B (Optimal) | Δ |
| --- | --- | --: | --: | --: | --: |
| /app.css | 200/200 | 27,302 | 10,328 | 8,922 | -1,406 (-13.6%) |
| /js/main.js | 200/200 | 9,362 | 4,093 | 3,673 | -420 (-10.3%) |
| /lib/signalr.min.js | 200/200 | 47,953 | 18,230 | 14,370 | -3,860 (-21.2%) |
| /login | 200/200 | 102,599 | 34,576 | 22,391 | -12,185 (-35.2%) |

The byte counts match the commit message exactly.

The cost of a compressed response on loopback (curl `time_total`, 200 requests per cell, A and B alternating, after 50 warm-up requests per path):

| path | Accept-Encoding | A median | B median | Δ | A p90 | B p90 |
| --- | --- | --: | --: | --: | --: | --: |
| /login | br | 1.51 | 2.00 | +0.49 | 3.88 | 4.65 |
| /login | identity | 0.96 | 0.86 | -0.09 | 1.92 | 1.61 |
| /app.css | br | 0.54 | 0.77 | +0.23 | 0.81 | 1.04 |
| /app.css | identity | 0.40 | 0.39 | -0.01 | 0.64 | 0.53 |

The uncompressed control is equal on both sides, so the +0.49 ms and +0.23 ms are the extra Brotli work of quality 4.

Per request or cached: the compression runs on every request. `app.UseResponseCompression()` (Program.cs line 276) wraps each response body before the `UseStaticFiles` handlers, and nothing keeps the compressed bytes (no `MapStaticAssets` with precompressed files, no output cache). Every compressible response pays the quality 4 cost again.

## Verdict

A clear gain for the far user on a cold open. On `far` the rows arrive 322 ms sooner (-1.8%), the page itself 96 ms sooner (-8.0%), and the wire carries 92.6 KB less (-9.2%). All of these are above the noise, with no overlap between the A and B samples. On `near` the cold open gains about 68 ms to the rows (-5.0%), above the 3% threshold, but the byte arithmetic supports only about 37 ms of it. On `lan` the cost is about 0.5 to 1.4 ms per page response, which no user can feel. The warm open does not change on any profile, because the worker's cache serves the shell. The people who feel the gain are far users on a first visit, and every device when the worker fetches the shell again after a deploy (the `?v=` URLs change per build).

## Caveats

- The server compresses on every request with no cache, so the CPU cost scales with the number of responses. The probe measures one request at a time on an idle server: +0.49 ms for the 100 KB page and +0.23 ms for app.css. Under many parallel first visits (for example after a deploy) the extra CPU adds up. A compress-once step (precompressed static files) would keep the smaller bytes without the per-request cost.
- The harness serves HTTP/1.1 without TLS through a TCP proxy, so the numbers compare the two builds and are not production numbers.
- Other measurement agents ran on this machine at the same time. That adds CPU noise, mostly to `lan`.
- The probe servers run memory-only without the seed. The byte counts of static files and the login page do not depend on the seed.
- A first version of the timing probe (servers started one after the other, 15 requests each) showed B faster than A. Tier-0 JIT code of the server dominated those few requests. The final probe warms both servers with 50 requests per path and alternates A and B, and it replaces that first result.
