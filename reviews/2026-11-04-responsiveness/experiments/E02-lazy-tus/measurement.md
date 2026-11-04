# E02 lazy-tus: measurement

2026-11-04. A = main (harness worktree, cb074cfa on 7f149be4). B = `perf/02-lazy-tus` (fdb8b933).

## The change

`index.html` no longer loads `/lib/tus.min.js` as a parser-blocking classic script before `main.js`. `js/upload.js`
appends the script at the first upload (`loadTus()`, one shared promise, reset on error), with the same stamped URL that
the worker precaches.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/02-lazy-tus perf/02-lazy-tus
cd /home/agent/yap-perf/exp/02-lazy-tus/Yap && bash -l -c "dotnet build"
cd /home/agent/yap-perf/harness/tests/browser && node perf.mjs --a=/home/agent/yap-perf/harness:main \
  --b=/home/agent/yap-perf/exp/02-lazy-tus:E02-lazy-tus --n=5 --profiles=far,near,lan --journeys=cold-open,warm-open \
  --out=/home/agent/yap-perf/results/E02-lazy-tus --port-a=5321 --port-b=5322
# the proof: own servers on 5323 (A) and 5324 (B), proxies on 5423 and 5424, far link
node probe-tus.mjs /home/agent/yap-perf/results/E02-lazy-tus               # the shell (curl) and the attach, worker allowed
node probe-tus.mjs /home/agent/yap-perf/results/E02-lazy-tus --no-worker   # the bound: service workers blocked
```

The harness run took 4 min 15 s. All runs ended, the browser log is empty, and no port change was necessary. The probe
script is `probe-tus.mjs` in this folder. It needs the B worktree at `/home/agent/yap-perf/exp/02-lazy-tus`, built.

## Result

Times in ms, medians of 5. "requests" and "KB" are the page's own files up to the rows. "wire" is every byte and request
that crossed the proxy, the worker's included.

### far (900 ms round trip, 1 Mbit/s)

| journey | metric | A | B | Δ ms | Δ % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts | 13723 | 12952 | -772 | -5.6% | 13445..13866 | 12833..13059 |
| cold-open | bootstrap | 14754 | 13972 | -781 | -5.3% | 14467..14891 | 13867..14083 |
| cold-open | socket | 16950 | 16231 | -719 | -4.2% | 16664..17088 | 16152..16541 |
| cold-open | rows | 18252 | 17814 | -438 | -2.4% | 18050..18469 | 17733..17945 |
| cold-open | requests | 60 | 59 | -1 | | 60..60 | 59..59 |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% | 815..815 | 784..784 |
| cold-open | wire requests | 72 | 72 | 0 | 0.0% | 72..72 | 72..72 |
| cold-open | wire KB | 1006 | 1007 | +0.6 | +0.1% | 1006..1006 | 1007..1007 |
| warm-open | paint | 65.1 | 69.8 | +4.7 | +7.2% | 55..116 | 63.9..86 |
| warm-open | rows | 3007 | 3006 | -1 | -0.0% | 2997..3041 | 3000..3025 |

### near (60 ms round trip, 20 Mbit/s)

| journey | metric | A | B | Δ ms | Δ % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts | 991 | 980 | -11.4 | -1.2% | 927..1009 | 911..1012 |
| cold-open | bootstrap | 1090 | 1059 | -31.3 | -2.9% | 1046..1127 | 1016..1140 |
| cold-open | socket | 1240 | 1199 | -41.5 | -3.3% | 1190..1269 | 1160..1297 |
| cold-open | rows | 1383 | 1340 | -42.6 | -3.1% | 1330..1409 | 1318..1439 |
| cold-open | requests | 60 | 59 | -1 | | 60..60 | 59..59 |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% | 770..815 | 784..784 |
| cold-open | wire requests | 72 | 72 | 0 | 0.0% | 72..72 | 71..72 |
| cold-open | wire KB | 1007 | 1007 | +0.4 | +0.0% | 1007..1007 | 1006..1013 |
| warm-open | paint | 64.2 | 67.7 | +3.5 | +5.5% | 57.2..210 | 58.7..127 |
| warm-open | rows | 285 | 292 | +6.2 | +2.2% | 282..414 | 286..354 |

### lan (no proxy)

| journey | metric | A | B | Δ ms | Δ % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| cold-open | scripts | 77.3 | 78.9 | +1.6 | +2.1% | 74.5..107 | 75.1..97.1 |
| cold-open | bootstrap | 97.8 | 97.2 | -0.6 | -0.6% | 91.4..126 | 90.9..118 |
| cold-open | socket | 128 | 130 | +2.6 | +2.0% | 120..169 | 120..167 |
| cold-open | rows | 167 | 173 | +5.6 | +3.3% | 155..223 | 156..230 |
| cold-open | requests | 60 | 59 | -1 | | 60..60 | 59..59 |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% | 815..815 | 784..784 |
| warm-open | paint | 87.7 | 61.8 | -25.9 | -29.5% | 64.5..107 | 58.1..121 |
| warm-open | rows | 97 | 79.5 | -17.5 | -18.0% | 90.1..139 | 75.8..121 |

Inside the noise (A/A limits: far 0.4% above 1 s, near 1.5%, lan and anything under 100 ms 5 to 17%): every lan row,
every warm-open row, near cold-open `scripts`. At the edge: near cold-open `bootstrap`, `socket` and `rows` (2.9 to
3.3%, the spreads overlap), lan warm-open `rows` (-18%, the spreads overlap, and far and near show no such move). Above
the noise: far cold-open `scripts`, `bootstrap`, `socket`, `rows` (the A and B spreads do not overlap). The page's
`requests` and `KB` are exact (min equals max).

## Proof of mechanism

### 1. The signed-in shell (curl `/` with the cookie of `ada`, from `signInToken`)

| side | status, bytes | `<script src>` tags | tus.min.js tag |
| --- | --- | --- | --- |
| A | 200, 102,599 | `lib/signalr.min.js?v=…`, `lib/tus.min.js?v=2026-11-04-0917`, `js/main.js?v=…` (module) | present |
| B | 200, 102,672 | `lib/signalr.min.js?v=…`, `js/main.js?v=…` (module) | absent |

`/lib/tus.min.js?v=<stamp>` is 87,020 B raw, 31,784 B gzip, 32,312 B br (the same on both servers). Over the harness's
plain HTTP, Chromium asks for gzip only; the page's transfer is 32,612 B with headers, which is the 31.2 KB drop in the
page's `KB`. The commit message says 22 to 27 KB: this server's br output is larger than its gzip, so production over
HTTPS also moves about 32 KB.

### 2. Why the wire did not change on the cold open

The probe counted the request lines on the proxy from the navigation to the rows. `tus.min.js` crossed the link once
in every cold open on both sides (6 of 6). On A the page requested it (the tag). On B the page did not request it; the
worker's install (`cache.add` of every shell URL) fetched it. So the link carries the same 72 requests and 1,006 KB.
What B changes is the order: on A the module `main.js` waits for the blocking classic script; on B the 32 KB move into
the worker's precache, which starts only after `main.js` runs. That is the 772 ms of `scripts` on `far`.

### 3. The cost of the first upload (probe, `far`, 3 repetitions per side, order A B, B A, A B)

A fresh context with the cookie opens `/`, waits for the `rows` mark, and sends one 2x2 PNG through the composer
(`sendFiles`). Then the page waits for the worker (`ready`, controller, network idle), reloads, waits for `rows`, and
sends again. Times are in the page's clock from the Send click.

| attach | metric | A | B | B - A |
| --- | --- | --: | --: | --: |
| first page | click to the first `/api/tus` request | 10 | 16 | +6 |
| first page | click to the POST's response | 954 | 947 | -7 |
| first page | click to the row confirmed | 3722 | 3832 | +111 |
| warm page | click to the first `/api/tus` request | 3 | 11 | +8 |
| warm page | click to the POST's response | 918 | 926 | +7 |
| warm page | click to the row confirmed | 3710 | 3726 | +16 |

Samples, click to the first tus request: A first 14, 10, 10; B first 16, 15, 28; A warm 3, 3, 4; B warm 8, 11, 13.
The +111 ms of "confirmed" comes from one B sample (4080; its POST took 1281 ms against about 930 elsewhere). The other
two B samples (3832, 3724) sit inside A's range (3687 to 3824).

Did `/lib/tus.min.js` cross the proxy at the attach? No, in 12 of 12 attaches:

- First page, B: the page requested the script 3 of 3 times. It was not under the worker yet (controller absent in 6 of
  6 first attaches, both sides). The entry took 1 to 2 ms (5..7, 5..6, 8..10 ms after the click), transfer 0 B, no proxy
  line. The HTTP cache served it: the worker's install had fetched the same URL before the rows.
- Warm page, B: the worker answered it 3 of 3 times (`fromServiceWorker` true), 1 to 3 ms, transfer 0 B, no proxy line.
- A: the script was in the page from the boot (`tus` defined at both attaches), no request.

### 4. The bound: no worker (`--no-worker`, service workers blocked, first page only)

Without a worker, nothing fetched the file before the attach, so B's lazy load crossed the link.

| metric | A | B | B - A |
| --- | --: | --: | --: |
| click to the first `/api/tus` request | 8 | 1180 | +1172 |
| click to the POST's response | 925 | 2093 | +1168 |
| click to the row confirmed | 3715 | 4903 | +1188 |

B's script entry ran from 5 to 1175 ms after the click, 32,612 B, and crossed the proxy 3 of 3 times. The calculation
for `far`: one round trip (900 ms) plus 32,612 B at 125,000 B/s (261 ms) is 1,161 ms. The same runs show B's rows sooner
without a worker too (A 17429, 17525, 17486; B 16927, 17171, 16890).

## Verdict

A clear gain on the `far` cold open. The `scripts` phase is 772 ms (5.6%) shorter, the socket is 719 ms sooner, and the
rows arrive 438 ms (2.4%) sooner. These deltas are 6 to 14 times the 0.4% noise of `far`, and the A and B spreads do
not overlap. On `near` the cold-open rows are 43 ms (3.1%) sooner, which is at the edge of the noise. `lan` and every
warm open show no change that is above the noise. The person who feels it is the far user at the first open of a new
device (or after the browser data is cleared): the rows come about 0.4 s sooner. The change does not reduce the bytes or
requests on the link at a cold open, because the worker downloads the same file in the same window. It only removes the
file from the path before `main.js`.

The cost that the prompt expected (one round trip plus the script's bytes at the first upload on a fresh device) did
not occur with the worker in place: +6 ms on the first page and +8 ms on a warm page, from the Send click to the start
of the upload. The worker's install filled the HTTP cache before the rows, so the lazy load never went to the network.
The cost occurs only when no cache holds the file: a browser without a service worker, or an attach before the install
reached the file. Then it is +1.17 s on `far`, which matches one round trip plus 32 KB.

## Caveats

- The low first-upload cost depends on two facts that this run did not vary. First, the worker's install fetched
  `tus.min.js` before the rows in 6 of 6 `far` cold opens. Second, the HTTP cache keeps `/lib/*.js?v=<stamp>`. If E06
  (the worker after the rows) lands, the install starts later, and a person who attaches right after the rows on `far`
  can pay up to the 1.17 s bound. Measure these two experiments together before both land.
- The first page was never under the worker at the attach (0 of 6, about 18 s after the navigation on `far`). The lazy
  load on that page relies on the HTTP cache, not on the worker's cache.
- The proxy model is HTTP/1.1 without TLS (six connections, no br). Over h2 in production, a blocking script waits less
  in the connection queue, so the `far` gain can be smaller there.
- The script is 32 KB on the wire, not 22 to 27 KB as the commit message says: this server's br is larger than its gzip
  for this file (E01 works on the compression level).
- 3 repetitions per side in the probe. The +6 and +8 ms deltas are small against the 900 ms round trip, and the bound
  of 1.17 s was stable to 2 ms over its three B samples.
- No failed runs, no reruns, no port changes. My probe servers (PIDs 615350, 615421, then 619016, 619085) stopped
  through `stop()` of `startServer`, and each PID was checked gone afterwards.
