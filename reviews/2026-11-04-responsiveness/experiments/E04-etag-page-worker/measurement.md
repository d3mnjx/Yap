# E04 etag-page-worker: measurement

Branch `perf/04-etag-page-worker`, commit b8d5199f (main 7f149be4 plus one commit, `Yap/Endpoints/ShellEndpoints.cs` only).
Measured on 2026-11-04 against the harness worktree (`perf/harness`, cb074cfa) as side A.

## The change

`ShellEndpoints.cs` gives the shell page (`/`, `/login`, `/lobby` and the other shell routes) and `/service-worker.js` a
weak ETag (`W/"<16 hex of SHA-256>"`) through `Results.Bytes(..., entityTag:)`, so a revalidation with `If-None-Match`
gets a 304 with no body. The welcome page keeps no ETag.

The switch from `Results.Content(string)` to `Results.Bytes(byte[])` has a second effect that the commit does not name.
The Brotli answer of the page is 8.9 KB smaller on every 200 (see "Proof of mechanism").

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/04-etag-page-worker perf/04-etag-page-worker
cd /home/agent/yap-perf/exp/04-etag-page-worker/Yap && dotnet build

cd /home/agent/yap-perf/harness/tests/browser
node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/04-etag-page-worker:E04-etag \
  --n=5 --profiles=far,near --journeys=warm-open,cold-open \
  --out=/home/agent/yap-perf/results/E04-etag-page-worker --port-a=5311 --port-b=5312

# proof of mechanism: servers on 5313 (A) and 5314 (B), proxies on 5413 and 5414, link `far`
node /home/agent/yap-perf/results/E04-etag-page-worker/probe-etag.mjs --out=<dir>/probe-etag.json
```

Harness wall time 4 min 11 s. All runs ended, no failed run, no rerun, no port change. The browser log is empty.
Files here: `report.md`, `runs.json`, `browser-log.txt`, `harness-run.log` (the harness's stdout), `probe-etag.mjs`,
`probe.log` (its stdout), `probe-etag.json`.

## Results (harness, n=5 per side)

Times in ms from the navigation start. Wire KB and wire requests are the proxy's view up to the `rows` mark.

| profile | journey | metric | A main | B E04 | Δ | Δ % | A min–max | B min–max | in the noise? |
| --- | --- | --- | --: | --: | --: | --: | --: | --: | --- |
| far | warm-open | paint | 64 | 68.9 | +4.9 | +7.7% | 58.6–160 | 61.3–143 | yes (under 100 ms) |
| far | warm-open | rows | 3008 | 3007 | −1.3 | −0.0% | 3000–3085 | 3002–3085 | yes |
| far | warm-open | wire requests | 3 | 3 | 0 | 0% | 3–3 | 3–3 | equal |
| far | warm-open | wire KB | 35.7 | 29.4 | −6.3 | −17.6% | 35.7–35.7 | 29.4–29.4 | no: the same in every sample |
| near | warm-open | paint | 58.3 | 68.1 | +9.8 | +16.8% | 57.3–97.9 | 52.6–79.7 | yes (under 100 ms) |
| near | warm-open | rows | 292 | 296 | +3.7 | +1.3% | 286–328 | 281–317 | yes (near: 1.5%) |
| near | warm-open | wire requests | 2 | 2 | 0 | 0% | 2–2 | 2–2 | equal |
| near | warm-open | wire KB | 28.7 | 28.7 | 0 | 0% | 28.7–28.7 | 28.7–28.7 | equal |
| far | cold-open | html | 1194 | 1122 | −72 | −6.0% | 1190–1200 | 1119–1126 | no: the ranges are apart |
| far | cold-open | rows | 18258 | 18149 | −109 | −0.6% | 18031–18318 | 18093–18185 | at the edge: above 0.4%, the ranges overlap |
| far | cold-open | KB (page's files) | 815 | 806 | −8.7 | −1.1% | 815–815 | 806–806 | no |
| far | cold-open | wire requests | 72 | 72 | 0 | 0% | 72–72 | 72–72 | equal |
| far | cold-open | wire KB | 1007 | 988 | −18.4 | −1.8% | 1006–1007 | 987–988 | no |
| near | cold-open | rows | 1379 | 1350 | −28.8 | −2.1% | 1352–1476 | 1303–1447 | yes (near: 3%) |
| near | cold-open | wire KB | 1007 | 988 | −18.4 | −1.8% | 1007–1007 | 988–989 | no |

On `near` the worker's update check lands after `rows`, so the warm-open wire window does not see it (2 requests
against 3 on `far`). The bytes still cross, after the window.

## Proof of mechanism (probe-etag.mjs)

Two short-lived servers, started as `lib.mjs` does with the seed and `SERVER_ARGS`, plus
`--Logging:LogLevel:Microsoft.AspNetCore.Hosting.Diagnostics=Information`. The hosting log's `Request finished` line
carries the status code. Each server is behind the harness proxy on `far`. One fresh context per side with the seed's
cookie. Each step waits for `rows`, then pauses 2 s, then reads the proxy's counters and the new log lines. The servers
were stopped by PID (A 617287, B 617354), and both were gone at the end.

The first load at `/` replaces the address with `/lobby` (router.js). So the three reloads reload `/lobby`. The worker
answers `/lobby` from its cache (a ROUTES path), and only `/`, `/login`, `/verify/*` and `/invite/*` go to the
network first (SERVER_FIRST in service-worker.js). For that reason the probe also does three navigations to `/`.

Status codes of every GET of a shell route and of `/service-worker.js`, in order, from the server logs:

| step | A: server log | A rows ms | A wire KB | B: server log | B rows ms | B wire KB |
| --- | --- | --: | --: | --- | --: | --: |
| open `/` (fresh) | `/` 200, `/service-worker.js` 200, `/login` 200 | 18150 | 1391 | `/` 200, `/service-worker.js` 200, `/login` 200 | 18228 | 1374 |
| reload 1 (of `/lobby`) | `/service-worker.js` 200 | 3049 | 35.7 | `/service-worker.js` 304 | 3034 | 29.4 |
| reload 2 | `/service-worker.js` 200 | 2994 | 35.7 | `/service-worker.js` 304 | 2996 | 29.4 |
| reload 3 | `/service-worker.js` 200 | 2992 | 35.7 | `/service-worker.js` 304 | 2994 | 29.4 |
| goto `/` 1 (extra) | `/` 200, `/service-worker.js` 200 | 4190 | 70.6 | `/` 304, `/service-worker.js` 304 | 3875 | 30.3 |
| goto `/` 2 | `/` 200, `/service-worker.js` 200 | 4165 | 70.6 | `/` 304, `/service-worker.js` 304 | 3920 | 30.3 |
| goto `/` 3 | `/` 200, `/service-worker.js` 200 | 4183 | 70.6 | `/` 304, `/service-worker.js` 304 | 3907 | 30.3 |

- A answers 200 every time. B answers 200 once (the first load and the worker's install fetch of `/login`), then 304.
- Proxy bytes for the three reloads: A 35.7 + 35.7 + 35.7 = 107.1 KB, B 29.4 + 29.4 + 29.4 = 88.2 KB (−18.9 KB, −6.3 KB per reload).
- Navigations to `/`: A 70.6 KB, B 30.3 KB each (−40.3 KB). The `rows` median falls from 4183 ms to 3907 ms (−276 ms,
  −6.6%; n=3, the ranges 4165–4190 and 3875–3920 are apart). The worker fetches `/` on the critical path, so the page's
  34.6 KB at 1 Mbit/s (about 280 ms) leaves the path. The round trip of the 304 stays.

The raw answers without a browser (`node:http`, straight to the server; body bytes as they cross, still compressed):

| path | Accept-Encoding | A | B | B with `If-None-Match` |
| --- | --- | --: | --: | --- |
| `/` and `/login` | gzip, deflate | gzip 32,701 B | gzip 32,709 B | 304, 0 B |
| `/` and `/login` | gzip, deflate, br | br 34,576 B | br 25,673 B | 304, 0 B |
| `/service-worker.js` | gzip, deflate | gzip 6,843 B | gzip 6,838 B | 304, 0 B |
| `/service-worker.js` | gzip, deflate, br | br 6,368 B | br 5,662 B | 304, 0 B |

Chromium sends `Accept-Encoding: gzip, deflate, br, zstd` on `http://127.0.0.1`, and both servers answered `br`. A's
Brotli page is larger than its gzip page. B's Brotli page is 8,903 B smaller than A's, with the same source bytes. The
only difference is the write: one byte buffer (B) against a string written by the framework (A). The framework's
reason is not checked here. This explains the cold-open control: page −8.9 KB, the worker's precache of `/login`
−8.9 KB, the worker script −0.7 KB, total −18.5 KB against −18.4 KB measured. The cold-open `html` phase on `far` is
−72 ms, which is 8.9 KB at 125 KB/s.

## Verdict

The warm open of the harness (a reload of `/lobby`) gains bytes only: 6.3 KB less per open on `far`, all of it the
worker's update check, which is now a 304. Its critical path does not move: `rows` −1.3 ms on `far` and +3.7 ms on
`near`, both inside the noise, and the `paint` deltas are under 100 ms and inside the noise. The ETag gives a time gain
only where the worker goes to the network for the page, at `/`, `/login`, `/verify/*` and `/invite/*`. The probe
measured `rows` 276 ms sooner on `far` for a navigation to `/` on a device with the worker, and 40 KB less on the wire
(n=3, outside the noise). This is the person on a slow link who opens the root: a typed address, a bookmark of the
root, or an app installed before sign-in (its start URL is `/`). On `near` the same 34.6 KB is about 14 ms of link
time. A side effect also helps every first visit: B's Brotli page is 8.9 KB smaller, so a cold open on `far` gets its
HTML 72 ms sooner (clear) and its rows 109 ms sooner (−0.6%, at the edge of the noise). The cold open on `near` is
inside the noise.

## Caveats

- The harness's warm-open journey reloads `/lobby`, which the worker serves from its cache. It never meets the page's
  304. The time gain at `/` comes from the probe (three samples per side, no A/B alternation, one run), not from the
  harness. A harness journey "warm open at `/`" would measure it with n=5 and alternation.
- The cold open is not a clean control. It moved by the Brotli size effect of `Results.Bytes`, not by the ETag.
- The servers ran in Development, where the shell is read and hashed per request. Production caches the bytes and the
  tag once per process. The size effect was not checked in Production.
- HTTP/1.1 without TLS through the proxy. Production uses h2 over TLS, where the browser also sends `br`.
- The probe had no keeper page, so its first load can carry the person's join line and the italic font (not checked).
  This can affect only the `open /` row, on both sides.
- The worktree, its `bin` and `obj` are removed. The branch `perf/04-etag-page-worker` stays.
