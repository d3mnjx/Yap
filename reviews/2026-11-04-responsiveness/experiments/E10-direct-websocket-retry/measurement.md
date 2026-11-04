# E10 direct-websocket-retry: measurement

2026-11-04. Measured with a standalone probe (`probe-ws-retry.mjs` in this folder), not with a `perf.mjs` run, because the journey stops and starts its server in the middle.

## The change

On main, `hub.js` `connect()` sets its `negotiate` flag when the direct WebSocket fails. The flag stays on for the life of the page, also when the negotiated attempt fails too (the server is down for a deploy). After that, every connect of that page (each reconnect, each resume after a long background) sends `POST /hub/negotiate` before the socket, which is one more round trip. On branch `perf/10-direct-websocket-retry` (920c7405), a double failure sets the flag back, so the next connect goes direct again.

## Sides

- A: `/home/agent/yap-perf/harness`, the main app code of 7f149be4. The harness branch moved to 345de009 during the day (another agent added a journey); `git diff 7f149be4 HEAD -- Yap` is empty, so A's app is main.
- B: `/home/agent/yap-perf/exp/10-direct-websocket-retry`, 920c7405. Against 7f149be4 it changes only `Yap/wwwroot/js/hub.js`.
- Servers: `startServer` of `lib.mjs`, a fresh copy of `/home/agent/yap-perf/seed` per start, `SERVER_ARGS` of `perf-seed.mjs` (persistence on). A on 5361, B on 5362. Proxies of `proxy.mjs` on 5461 and 5462 with the `PROFILES` of `perf.mjs`: `far` 900 ms round trip, 1 Mbit/s; `near` 60 ms round trip, 20 Mbit/s. A keeper page on Settings per side, off the proxy, as in `perf.mjs`.
- The person: `ada` with the seed's token (the account's token, so it stays valid on each fresh seed copy). The poster of the resume message: `ben`.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/10-direct-websocket-retry perf/10-direct-websocket-retry
cd /home/agent/yap-perf/exp/10-direct-websocket-retry/Yap && bash -l -c "dotnet build"      # 0 warnings, 0 errors

# shake-outs (scratch output, not kept)
node probe-ws-retry.mjs --profiles=near --n=1 --control=1 --out=<scratch>/shake            # failed, see Caveats
node probe-ws-retry.mjs --profiles=near --n=1 --control=0 --out=<scratch>/shake            # passed

# the measurement: 23 min 37 s wall time, every run ended
node probe-ws-retry.mjs --profiles=far,near --n=5 --control=2 --out=/home/agent/yap-perf/results/E10-direct-websocket-retry
node post-ws-retry.mjs /home/agent/yap-perf/results/E10-direct-websocket-retry/runs.json   # attempt to connected
```

## The probe, per profile (`far`, then `near`) and per repetition, both sides in parallel

1. A fresh context opens the quiet room `/room/f9ef334e-…` (`pets`, 200 messages), not the lobby. After the outage the person's own join line can show in the lobby in italics, and the 380 KB italic font would cross the link. The page is prepared as `perf.mjs` `prepared()` does it: the load runs through the proxy without delay, the probe waits for the `rows` mark, the worker in control and the stored tail and bootstrap, and then the profile's link applies.
2. The outage: the probe stops the side's server through its own child process (by PID, `server.stop()`). It waits until the page makes a direct socket attempt and a `POST /hub/negotiate` that both fail. Then it starts the server again on the same port from a fresh seed copy.
3. The probe waits for `connected()` and records `server back to connected` and the `/hub/negotiate` requests that got a 200 during that reconnect.
4. Two resumes on that page, with the pause, thaw and timing lines of `resumeAll` in `perf-journeys.mjs`: hidden, debugger pause, the proxy's blackhole, 35 s, a message from `ben` in the room, thaw, then the time from the return to visible until that message is in the rows. For each resume, the probe records the `/hub/negotiate` count and every request line that crossed the proxy until the rows and in the 1.5 s after.
5. The context closes.

Control: the same page and the same two resumes, with no outage, n=2 per side and profile.

The sockets are observed through CDP `Network.webSocketCreated` (see Caveats), the negotiate requests through Playwright's request events.

## Results

Times in ms. n = 5 outage runs per side and profile, two resumes each; controls n = 2, two resumes each. "negotiate" lists the `POST /hub/negotiate` count of each sample in run order (for the reconnect, the ones answered 200).

### far (900 ms round trip, 1 Mbit/s)

| metric | A median | B median | A min | A max | B min | B max | Δ ms | Δ % | negotiate A | negotiate B |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --- | --- |
| resume after outage: rows (both resumes, n=10) | 4005 | 3086 | 3999 | 4025 | 3077 | 3098 | -919 | -22.9% | 1 1 1 1 1 1 1 1 1 1 | 0 0 0 0 0 0 0 0 0 0 |
| resume after outage: rows, resume 1 | 4006 | 3084 | 4003 | 4025 | 3077 | 3098 | -922 | -23.0% | 1 1 1 1 1 | 0 0 0 0 0 |
| resume after outage: rows, resume 2 | 4004 | 3088 | 3999 | 4012 | 3078 | 3090 | -915 | -22.9% | 1 1 1 1 1 | 0 0 0 0 0 |
| control resume, no outage: rows (n=4) | 3085 | 3080 | 3073 | 3090 | 3073 | 3093 | -5 | -0.2% | 0 0 0 0 | 0 0 0 0 |
| server back to connected (secondary) | 5034 | 4195 | 4279 | 5322 | 3169 | 4613 | -839 | -16.7% | 1 1 1 1 1 | 0 0 0 0 0 |
| reconnect attempt to connected (secondary) | 2797 | 1892 | 2763 | 2824 | 1865 | 1913 | -905 | -32.4% | | |

### near (60 ms round trip, 20 Mbit/s)

| metric | A median | B median | A min | A max | B min | B max | Δ ms | Δ % | negotiate A | negotiate B |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --- | --- |
| resume after outage: rows (both resumes, n=10) | 358 | 303 | 334 | 389 | 261 | 311 | -55 | -15.4% | 1 1 1 1 1 1 1 1 1 1 | 0 0 0 0 0 0 0 0 0 0 |
| resume after outage: rows, resume 1 | 369 | 306 | 349 | 373 | 297 | 311 | -63 | -17.1% | 1 1 1 1 1 | 0 0 0 0 0 |
| resume after outage: rows, resume 2 | 344 | 274 | 334 | 389 | 261 | 310 | -71 | -20.5% | 1 1 1 1 1 | 0 0 0 0 0 |
| control resume, no outage: rows (n=4) | 273 | 271 | 269 | 286 | 267 | 287 | -3 | -1.0% | 0 0 0 0 | 0 0 0 0 |
| server back to connected (secondary) | 3060 | 2871 | 329 | 3074 | 140 | 3179 | -189 | -6.2% | 1 1 1 1 1 | 0 0 0 0 0 |
| reconnect attempt to connected (secondary) | 265 | 215 | 233 | 283 | 140 | 236 | -50 | -18.9% | | |

`reconnect attempt to connected` is the time from the start of the attempt that opened (the negotiate request on A, the direct socket on B) to `connected()`, from the attempt log in `runs.json` (`post-ws-retry.mjs`). It removes the wait for the retry tick from `server back to connected`.

All samples: `runs.json`. The probe's own table: `probe-report.md`. The per-run log with the attempts and the requests of every resume: `probe-log.txt`.

## Proof of mechanism

- The outage, every run on both sides: the first retry tick (about 1,005 ms after the stop) makes a direct socket attempt and then a `POST /hub/negotiate`, and both fail. A's second tick (about 3,015 ms) sends only a negotiate request. B's second tick makes a direct attempt and a negotiate request again. The server was back after 4.0 to 7.1 s, and the third tick (about 7,020 ms) reconnected both sides: A with `POST /hub/negotiate` (200) and a negotiated socket (`id=`), B with a direct socket. That held in 10 of 10 outage runs (`probe-log.txt`).
- Every resume after an outage on A sent one `POST /hub/negotiate` and opened a negotiated socket (20 of 20). Every resume after an outage on B opened a direct socket with no negotiate request (20 of 20). In the controls both sides went direct with no negotiate (16 of 16).
- What crossed the proxy until the rows: on A after an outage, `POST /hub/negotiate`, `GET /hub?…&id=…` and `GET /api/bootstrap` (20 resumes); on B after an outage and in every control, `GET /hub?…` and `GET /api/bootstrap` (36 resumes). Nothing crossed in the 1.5 s after the rows. No font, no shell file, no other request crossed in any resume. The browser log has no page errors.
- The size of the gain is one round trip of the profile: -919 ms on `far` (900 ms round trip), -55 to -71 ms on `near` (60 ms round trip).

## Verdict

A clear gain, above the noise on both profiles. After a server outage, a resume on main returns to the server's rows 919 ms later on `far` (4,005 ms against 3,086 ms, -22.9%) and 55 ms later on `near` (358 ms against 303 ms, -15.4%). The cost on main is the negotiate round trip on every resume and reconnect for the rest of the page's life, and the branch removes it. The two sides do not overlap anywhere: on `far` A's fastest resume (3,999 ms) is 901 ms slower than B's slowest (3,098 ms), and on `near` A's fastest (334 ms) is slower than B's slowest (311 ms). The controls without an outage agree within 0.2% on `far` and 1.0% on `near`, inside the harness's noise (0.4% `far`, 1.5% `near`). Everyone whose page lives through a server restart (each deploy) feels it, on every later resume and reconnect of that page; the far user feels about 0.9 s each time. The installed app on a phone feels it most, because it resumes many times a day and its page lives across deploys. The reconnect after the outage itself is also one round trip shorter on the branch (attempt to connected -905 ms on `far`, -50 ms on `near`).

## Caveats

- The page is in the quiet room (`pets`), not the lobby. The control resume here is 3,080 to 3,085 ms on `far` and 271 to 273 ms on `near`, against the harness's plain lobby resume of 2,979 ms and 258 ms. The numbers compare A with B inside this probe; they are not the harness's resume journey.
- On `near`, the resumes after an outage are slower than the controls on both sides (B 303 ms against 271 ms). A restarted server has seen only one reconnect and a few resumes, so its code is probably less warm (JIT) than the server of the controls. Both sides restart the same way, so the A/B delta is fair. On `far` the same effect is 6 ms.
- `server back to connected` depends on the retry tick: the server came back between 4.0 and 7.1 s after the stop and both sides reconnected at the 7 s tick. In the last `near` run the server needed 5.9 s to start, came back at about 7.0 s, and the tick came almost at once (140 ms on B, 329 ms on A). That explains the wide `near` range. `reconnect attempt to connected` removes the tick.
- While the server is down the branch makes two refused attempts per retry tick (direct, then negotiated), and main makes one after its first tick. The attempt log shows this; it costs nothing measurable here.
- The first shake-out failed on A: Playwright's `page.on('websocket')` did not report main's single direct attempt after the stop. Playwright reports a socket at its handshake request, and the proxy drops the TCP connection at once when the server is down, so no handshake request leaves. The probe now observes the sockets through CDP `Network.webSocketCreated`, which fires at `new WebSocket()`. The second shake-out and the measurement saw every attempt.
- Ports 5361/5362 and 5461/5462 were free; no port change. The worktree's `bin` and `obj` and the worktree are removed; the branch stays. The probe's server roots (`/home/agent/yap-perf/runs/E10/root-*`) were removed by `server.stop()`, and the empty folder too.
