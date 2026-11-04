# Browser scripts

These scripts drive the Yap web client in a real Chromium with Playwright. Each script starts its own Yap
server, runs its steps, prints PASS or FAIL for each step, and stops the server again.

- `smoke.mjs` checks the basic chat: sign-in, messages, reactions, edits, typing, DMs and unread counts,
  delete, the status menu, the pickers, a reload on a DM link, the phone layout (with the sheet after a visit to
  Settings), sign-out (with a second tab of the same device) and the back button.
- `offline.mjs` checks the offline features: the service worker, the connection dot, the outbox, a send into a
  direct message never opened on the device, a reload without a network, the return of the network, a reconnect
  after more than a page arrived, a repeated POST, a file sent offline, the new-version strip, a sign-out without
  a connection, and the clean-up of IndexedDB at sign-out.
- `features.mjs` checks replies, link cards, the image gallery, emoji sizes, pack emoji, older pages, the
  New messages pill, typing in a DM, Shift+Enter, two GIF files in one pick, the automatic read while Away, the
  keys on a GIF favourite star, an emoji pick at the 4000-character limit with Edit on a failed row, a rename
  of the open room, the media of a pin: the gallery viewer over the pins panel, its close order, its close on an
  unpin, and a video that plays in the entry, and the jump to a message that is not loaded: the window around it
  with one server call, an older page above it, the pill, the end row under it, and the way back by the pill, the
  end row's button, the arrow, a send and a reconnect.
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

## The service worker and the offline script

Playwright applies `setOffline` to a service worker only when the environment variable
`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` is set. Without it, the worker still reaches the server
and the offline reload proves nothing. `offline.mjs` sets the variable itself, so `npm run offline` works
the same on Windows and Linux.
