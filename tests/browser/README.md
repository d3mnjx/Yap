# Browser scripts

These scripts drive the Yap web client in a real Chromium with Playwright. Each script starts its own Yap
server, runs its steps, prints PASS or FAIL for each step, and stops the server again.

- `smoke.mjs` checks the basic chat: sign-in, messages, reactions, edits, typing, DMs and unread counts,
  delete, the status menu, the pickers, a reload on a DM link, the phone layout (with the sheet after a visit to
  Settings), sign-out (with a second tab of the same device) and the back button.
- `offline.mjs` checks the offline features: the service worker, the connection dot, the outbox, a send into a
  direct message never opened on the device, a reload without a network, the return of the network, a reconnect
  after more than a page arrived, a repeated POST, a file sent offline, a text sent while a proxy answers 502 or
  Cloudflare answers 521 for the server, the new-version strip, a sign-out without a connection, and the clean-up of IndexedDB at sign-out.
- `features.mjs` checks replies, link cards, the image gallery, emoji sizes, pack emoji, older pages, the
  New messages pill, typing in a DM, Shift+Enter, two GIF files in one pick, the automatic read while Away, the
  keys on a GIF favourite star, an emoji pick at the 4000-character limit with Edit on a failed row, a rename
  of the open room, the media of a pin: the gallery viewer over the pins panel, its close order, its close on an
  unpin, and a video that plays in the entry, and the jump to a message that is not loaded: the window around it
  with one server call, an older page above it, the pill, the end row under it, and the way back by the pill, the
  end row's button, the arrow, a send and a reconnect. It also checks the message search: above 768 px the field,
  the panel in the place of the sidebar, the highlight, a long text, Escape and Ctrl+F; at 768 px or less the
  sidebar row, the search screen, a result, the steps back, "Go to newest", a reconnect and the two width tiers.
- `uploads.mjs` checks the uploads of a message: a text that goes out while a picture uploads, the state of each
  file in the pending row with three files at one time and the pictures in the order of the pick, an upload that
  goes on after a reload from the bytes the server has, a last chunk whose answer was lost (with a reload and
  without one), a message that goes out without a file the server refused, which stays as a failed row,
  a half-sent file that the server no longer has, and a file that waits while a proxy answers 502 for a server
  that restarts.
- `pages.mjs` checks the pages of step 5: the login rules, Settings (themes, text size, profile, the login link,
  the retired secret code, sessions, mutes, time and date), the verification and link pages, an account switch that
  reaches the other tab of the device, Admin (users, invites, registration and approval, bot, debug, the
  persistence-only tabs, GIFs, diagnostics), Create Channel / Channel Settings (with `/lobby` after a reorder),
  the keyboard on the sidebar rows and the + button, and the notification choices at 20 px on a 320 px phone.
- `latency.mjs` checks the latency table of the admin's Diagnostics tab (AD-26): one person loads a room, taps
  a room, loads an older page, sends a text, jumps to a pin that is not loaded, loses and regains the connection, and every wait shows up on
  the person and on the connection.
- `load.mjs` prints the load and the resume of one person on a slow link (900 ms round trip, 1 Mbit/s): the six
  phases of the boot report (AD-41) for a cold load and a warm load, the files answered by a cache, and the time
  from a return after a frozen background with a dead socket to the server's rows. It asserts nothing on the
  numbers; run it before and after a change and compare. The link is a TCP proxy inside the script, so the
  service worker and the WebSocket go through it too.
- `perf.mjs` measures how responsive Yap feels for one person on a real-sized server, and compares two builds (A
  and B) side by side. Each build runs on a copy of a seed with a real history (`perf-seed.mjs`: 30 people, 10 rooms,
  50,000 messages over 180 days). The journeys (`perf-journeys.mjs`) are a cold open, a warm open, a resume after a
  frozen background, sends, room changes, older pages and the two pickers, plus a cold open and older pages on a slow
  phone. They run through the link proxy of `load.mjs` (`proxy.mjs`) on three profiles: `far` (900 ms round trip,
  1 Mbit/s), `near` (60 ms, 20 Mbit/s) and `lan` (no proxy). The report gives the median, min and max of every
  metric per build and the delta. See "The performance harness" below.
- `update.mjs` replays a deploy: build A is served, the browser stores the shell through the worker, then build
  B takes the same port and the page is reloaded, as an installed app is at its next launch. It watches the
  worker's registration, taps the new-version strip's Reload, and says whether the page ends on build B with no
  strip. It needs two build copies made in different minutes, `--dllA=<dir> --dllB=<dir>`. `--stuckworker`
  makes build B serve build A's worker bytes, the iPhone case of 2026-10-30 where the worker never changed;
  `--signin` runs it on the settings page of an account and checks that the route survives.
- `screenshots.mjs` regenerates the images of the product spec in `docs/spec/img/`. It seeds people, rooms,
  messages, mutes and statuses, builds the state that each image's caption names, and overwrites the image. A
  step that fails keeps the old image. The run takes about three minutes: it waits for an offline person
  (30 s) and for the bot's welcome messages (one minute after each sign-in).
- `lib.mjs` holds the shared parts: the server start and stop, the sign-in, the collectors of browser errors,
  the step report, and a small PNG writer for upload tests and generated pictures.

Node and npm are development tools for these scripts only. They are not part of the build, the Docker image
or production.

## Run

Build the server first. The scripts use `Yap/bin/Debug/net10.0/Yap.dll`.

```
dotnet build Yap
cd tests/browser
npm install
npx playwright install chromium
npm run smoke
npm run offline
npm run features
npm run uploads
npm run pages
npm run latency
npm run load
npm run screenshots
```

Each run uses a new temporary content root under the system temp folder (`yap-browser-tests`). It copies
`Yap/Data`, links `Yap/wwwroot`, and turns persistence off. The repository's `Yap/Data` does not change.
The root is removed when the run ends.

The port is 5097. A script stops at once if something already answers on that port, because the new server
could not bind and the run would test the old one. To change the settings, pass `--port=<n>`,
`--dll=<path>` or `--scratch=<folder>` after `--`, for example `npm run smoke -- --port=5099`.

Screenshots go to `shots/`. The exit code is 1 when a step fails.

## The performance harness

Build each worktree to compare (`dotnet build Yap` in it), then from `tests/browser`:

```
npm run perf -- --seed                                             # once: about 1.5 minutes
npm run perf -- --a=<worktree A>:<label> --b=<worktree B>:<label>   # about 20 minutes at the defaults
```

`--seed` builds the seed into `~/yap-perf/seed` (`--seed-dir=<dir>` for another place) with the build of `--a` and
stops. A measurement starts each build on its own copy of the seed, with the database on, under `~/yap-perf/runs`
(ports 5301 and 5302, their proxies 5401 and 5402). With only `--a` it measures one build. The person is the seed's
admin, signed in through the API, so a journey times the page and not the login form. A page idling on Settings keeps
the person online on each server, so the person's presence (and the join line it draws) does not depend on the
order of the runs. The runs alternate A, B, B, A, so drift of the machine hits both builds alike. The tables go to stdout and to `report.md` in `--out` (default
`~/yap-perf/results/<time>`), the raw numbers to `runs.json`, the browser's complaints to `browser-log.txt`. A failed
run leaves a screenshot there, and the exit code is 1.

The default plan keeps one A/B run at five repetitions near 20 minutes. It leaves out the phone rows and the sends
on `far`, the resume on `near` and `lan`, and the phone rows on `lan`; `DEFAULT_PLAN` in `perf.mjs` says why. `--full`
runs every journey (about 29 minutes for A/B on all three profiles). `--profiles=`, `--journeys=` and `--n=` choose
others.

The numbers compare two builds on one machine. They are not production numbers: the server speaks HTTP/1.1 without
TLS, the emoji images come from the real CDN outside the proxy, and the phone is a desktop Chromium with a slower
CPU. The resume pauses the page in the debugger, because a freeze through `Page.setWebLifecycleState` does not stop
the timers of this headless Chromium.

### Records over time

`--record` measures one build and keeps the result in the repo, so that the numbers of today compare with the numbers
of next month:

```
dotnet build Yap                  # in the checkout to measure
npm run perf -- --record          # about 22 minutes; --a=<checkout> measures another built checkout
```

A record always runs the same plan at five repetitions, so every record holds the same rows: every journey on every
profile, but the two reaction-picker journeys on `near` only (they time the page's own work and cost 6 minutes a
profile). `--record` refuses `--b`, `--journeys`, `--profiles`, `--n` and `--full` for that reason. The run writes one
JSON file into `perf-history/` (every metric with its median, min and max) and writes `perf-history/README.md` again:
one table per profile, one row per record. The report of the run ends with a comparison against the record before
it. It takes the last record of the same machine when there is one. Commit the new JSON file and the README.

Each profile of a record starts with a machine check: a fixed piece of work on a blank page, with nothing of the app
in it. It says how fast the machine was at that minute.

Rules for a record that is worth a comparison:

- Run it on a quiet machine. A build or a browser suite that runs at the same time takes CPU from the pages, and the
  `lan` and `near` numbers rise with no change in the app. Two records compare on `lan` and `near` only as far as
  their machine checks agree.
- Nothing else may stop the server. A cleanup by process name (`pkill -f "[Y]ap.dll"`) from another session killed
  the server of a record run on 2026-11-11.
- Compare records of one machine. On `far` the link is most of every number (a cold open takes the same 18.3 s with
  a four times slower CPU), so `far` moves little between machines. `lan` and `near` follow the machine's speed.
- Measure a commit that is on origin, not a working tree. A build with uncommitted changes to the app gets a `*`
  after its commit, and a local commit can get a new name in a rebase: the record then names a commit that nobody
  finds. (The two records of 2026-11-11 were measured two test-only commits ahead of origin and carry the name of
  the last pushed commit, whose app code is the same.)
- A record shows a trend. For a question about one change, measure the two builds side by side in one run (`--a`
  and `--b`): between two records `near` moves by up to 10% and `lan` by up to 20% with no change in the app. Inside
  one run the two builds alternate, and the noise is 1.5% on `near` and 5 to 17% on `lan`.
- In the sandbox, measure a clone outside the shared tree, so the Linux build output stays out of the Windows tree:
  `git clone --depth 1 file:///d/PROJECTS/Yap $HOME/yap-perf/src`, `dotnet build` in its `Yap` folder, then
  `npm run perf -- --record --a=$HOME/yap-perf/src` from this folder.
- The seed lives in `~/yap-perf/seed`, outside the repo. A new machine or sandbox builds it again with `--seed`. The
  seed's random choices come from a fixed number, so every build of the seed holds the same people and messages.

## The service worker and the offline script

Playwright applies `setOffline` to a service worker only when the environment variable
`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` is set. Without it, the worker still reaches the server
and the offline reload proves nothing. `offline.mjs` sets the variable itself, so `npm run offline` works
the same on Windows and Linux.
