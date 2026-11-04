# E09 startup-listen-sooner: the first answer after a restart

Branch `perf/09-startup-listen-sooner`, commit 455bdf4d, against main (the harness worktree, cb074cfa on main 7f149be4).
Measured on 2026-11-04.

## The change

`Program.cs` moves the action-log cleanup (`UserActionLogService.Cleanup`) from the start path to
`ApplicationStarted`, on the persistence writer's queue, so Kestrel listens before the cleanup runs. It also resolves
VideoService, GifFfmpegHelper and MediaCacheService on three parallel tasks before the chat load, so the ffmpeg and
yt-dlp probes run side by side.

## Method

The harness's `perf.mjs` measures pages in a browser, not a cold start. This experiment uses its own script,
`perf-start.mjs` (in this folder). It reuses `SERVER_ARGS` and the seed reader of `perf-seed.mjs`, and it builds each
content root as `startServer` in `lib.mjs` does.

- **Inflated action log.** The script copies the seed's `Data/` once to `/home/agent/yap-perf/runs/e09-inflated` and
  inserts 200,000 rows into `UserActionLogs` with `node:sqlite`. The dates run from 2025-05-01 to 2026-04-30, before
  the cut-off (UtcNow minus 6 months, 2026-05-04). A quarter of the rows are anonymous, the rest belong to the seed's
  people. The seed already holds 50,702 rows, and 47,641 of them are above the per-user keep limits. So every start
  begins with 250,702 rows (yap.db 90 MB), and the cleanup deletes 200,000 old + 47,641 excess rows.
- **One start.** A fresh root `/home/agent/yap-perf/runs/e09-start` gets the build's own `Data/*.json`, `welcome`,
  a link to its `wwwroot`, then a copy of the inflated `Data/` and the seed's `uploads/`. The copy happens before the
  spawn, so it is not in the timed window. The server runs as `dotnet Yap.dll --contentRoot <root> --urls
  http://127.0.0.1:<port>` with `SERVER_ARGS` (persistence on, no load bounds, uploads in the root),
  `--ChatSettings:WelcomePageEnabled=false`, and two log-level overrides (see Caveats).
- **Probes.** From the spawn, three pollers run side by side. Each sends one request every 20 ms on a new connection,
  with a 1 s limit per attempt, until it gets a 200:
  - `GET /login` with no cookie.
  - `GET /` with `yap_auth=<ada's token from seed.json>`.
  - `GET /api/bootstrap` with the same cookie. `GET /` only returns the shell. The bootstrap reads the loaded chat
    (rooms, DMs, unread counts), so it is the request that needs the chat in memory. Every bootstrap answer named `ada`.
- **Proof.** After the three 200s, the script counts the rows, waits 15 s, counts again, sends SIGTERM to the PID,
  waits for the exit, and counts a third time. Each line of stdout goes to `logs/<label>.log` with its arrival time
  in ms since the spawn.
- **Order.** One uncounted warm-up start per side, then 10 counted starts per side in the order A, B, B, A, A, B ...
- **Ports.** A on 5351, B on 5352. Both were free. The script checks the port before each start.

Commands (from `/home/agent/yap-perf/harness/tests/browser`):

```
node /home/agent/yap-perf/results/E09-startup-listen-sooner/perf-start.mjs --a=/home/agent/yap-perf/harness --b=/home/agent/yap-perf/exp/09-startup-listen-sooner --n=10 --warmup=1 --port-a=5351 --port-b=5352 --out=/home/agent/yap-perf/results/E09-startup-listen-sooner
node /home/agent/yap-perf/results/E09-startup-listen-sooner/phases.mjs
```

Wall time of the run: 7.0 min (22 starts). Every sample is in `starts.json`. The phase split is in `phases.txt`.

## Results (ms since the spawn, 10 starts per side)

| Metric | A median | B median | A min..max | B min..max | Delta ms | Delta % |
|---|---|---|---|---|---|---|
| First 200 on `GET /login` | 3400 | 2249 | 3182..3873 | 2018..3068 | -1151 | -33.9 |
| First 200 on `GET /` with cookie | 3400 | 2249.5 | 3182..3873 | 2019..3068 | -1150.5 | -33.8 |
| First 200 on `GET /api/bootstrap` with cookie | 3484 | 2371.5 | 3245..3933 | 2081..3181 | -1112.5 | -31.9 |
| "Now listening" line | 3280 | 2122 | 3060..3757 | 1905..2893 | -1158 | -35.3 |
| Cleanup line | 3051 | 2916 | 2840..3541 | 2580..3727 | -135 | -4.4 |
| Cleanup line minus "Now listening" | -224.5 | +751.5 | -275..-213 | 675..836 | | |
| SIGTERM to exit | 52 | 45.5 | 44..139 | 41..77 | | |

B's slowest start (3,068 ms) is faster than A's fastest (3,182 ms). The two sets do not overlap on any of the three
requests.

Where the gain comes from (`phases.mjs`, from the arrival times of the log lines):

| Phase | A median | B median | Delta ms | A min..max | B min..max |
|---|---|---|---|---|---|
| Spawn to "Loaded link preview settings" | 909 | 929.5 | +20.5 | 841..985 | 840..1286 |
| The three probes | 151.5 | 118.5 | -33 | 57..206 | 39..298 |
| The chat load | 699 | 764.5 | +65.5 | 670..832 | 664..1533 |
| Chat loaded to "Now listening" | 1569 | 251.5 | -1317.5 | 1309..1799 | 235..306 |

The last phase holds the whole gain: on A it contains the cleanup (about 1.3 s for 247,641 deleted rows). The
parallel probes save 33 ms at the median, inside the spread of that phase. The +20 and +65 ms of the first two
phases are inside their spreads too (B3 and B6 were slow starts in those phases, machine noise).

The cleanup overlaps the first requests on B, and it costs them little:

| | A median (min..max) | B median (min..max) |
|---|---|---|
| "Now listening" to the first 200 on `/login` | 119.5 (111..137) | 128 (109..175) |
| Duration of the successful `/api/bootstrap` request | 173.5 (165..255) | 194 (156..270) |
| `/api/bootstrap` 200 minus `/login` 200 | 67.5 (60..125) | 69.5 (57..137) |

No attempt timed out and no attempt got a status other than 200 or a refused connection. No log had a fail, crit or
exception line.

## Proof of mechanism

Row counts in `UserActionLogs`:

| Start | Before the spawn | At the three 200s | 15 s later | After the exit | Cleanup line | "Now listening" |
|---|---|---|---|---|---|---|
| 04-A2 (A) | 250,702 | 3,064 | 3,065 | 3,065 | +2840 ms | +3060 ms |
| 15-B8 (B) | 250,702 | 250,702 | 3,065 | 3,065 | +2744 ms | +1989 ms |

On A the rows are gone before the server answers: the cleanup runs before Kestrel listens. On B the server answers
with all 250,702 rows still there, and 15 s later the count dropped to the same 3,065 as on A. All 20 counted starts
show this pattern, and every cleanup line reads "deleted 200000 old + 47641 excess entries". On B the cleanup line
arrives 675 to 836 ms after "Now listening".

## Verdict

A clear gain. With 250,702 action-log rows, the first answer after a restart comes 1.15 s sooner (3.40 s to 2.25 s,
-34%) on `/login`, on the shell with a cookie, and on the bootstrap that reads the chat. The gain is far above the
spread: the two sides do not overlap. The gain is the cleanup's duration, so it scales with the size of the action
log. The parallel probes add about 33 ms, which is inside the noise. Everyone who reconnects after a deploy or a
restart feels it. The saved time is server time, so it adds the same way on every network.

## Caveats

- **The gain depends on the table size.** 200,000 old rows is the setting of this experiment. Without the inflation
  the seed alone still gives the cleanup 47,641 excess rows. The implementation step measured 139 ms with 8,000 rows.
  The size of the production table is not known here. The cleanup runs at each start, so the table holds what came
  in since the last restart plus the keep limits.
- **Logging.** The root has no `appsettings.json` (the same as every `perf.mjs` run), so the server logs at the
  default level Information, which includes every EF SQL command (about 1,280 lines per start). The two overrides
  (`Microsoft.Hosting.Lifetime` and `Yap.Services.Admin.UserActionLogService` at Information) change nothing in that
  state. They are there in case the defaults change. A server whose content root holds `appsettings.json` logs EF at Warning, so its
  absolute times can be a little shorter. Both sides log the same lines.
- **Log times are arrival times** on the stdout pipe. The console logger writes in batches, so lines of one batch
  share one time. The phase split is approximate. The three HTTP metrics do not depend on it.
- **Other agents** ran Yap servers on this machine at the same time (8 `Yap.dll` processes at the start). The
  alternating order spreads that drift over both sides. B3 (3,068 ms) and B6 (2,978 ms) are the slow outliers.
- **The first start of a deploy is colder** than these starts: one uncounted warm-up per side ran first, so the dll
  and the runtime were in the page cache. The shake-out start before the run (cold A) took 5,116 ms to the first
  `/login` 200.
- Nothing went wrong in the run: no failed start, no rerun, no port change.
