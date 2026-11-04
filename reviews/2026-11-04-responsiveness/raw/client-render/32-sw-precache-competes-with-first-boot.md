---
id: client-render-32
title: Start the new build's precache after the first rows, not during the boot
area: client-render
journey: warm-open
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: On the first load after each deploy, the page registers the worker at module start; the browser finds the new worker bytes and installs it, and the install fetches the whole new shell (about 200 to 270 KB compressed, performance-notes) at the same time as the boot's own traffic (bootstrap, hub, openRoom, emoji, avatars). At 1 Mbit/s that is about 2 s of a saturated link during the boot of the far user. Gain unknown; depends on how the browser schedules the update check.
confidence: low
files: [Yap/wwwroot/service-worker.js:34-39, Yap/wwwroot/js/main.js:89-90]
---

## What the code does now
`main.js` registers the worker when the module runs (`main.js:90`). The registration URL carries the page's build, which is the old build when the page came from the cache; the browser fetches the worker script (no-cache) and sees new bytes after a deploy. `install` adds every URL of the shell list in parallel (`service-worker.js:35-37`) and calls `skipWaiting()`.

## Why it costs the user time
The boot runs from the old cache with no round trip to paint, and then needs the network for the server's rows. The install of the new worker downloads the full new shell in the same seconds. On a 1 Mbit/s link the rows and the emoji wait behind it. Who pays: far users, on the first load after each deploy.

## The change
Two options:
1. Register (or call `registration.update()`) after the server's rows are on screen (`markOnce('rows')`, or `requestIdleCallback` after it), not at module start. The browser also checks for an update after navigations on its own, so this may move the work only partly; measure first.
2. In the worker's `install`, add the files with a lower fetch priority (`cache.add(new Request(url, { priority: 'low' }))`) so that the page's requests on the same HTTP/2 connection go first. The hub's WebSocket is often a separate connection, so this helps the HTTP requests only.

## Risks and what could break
The Reload button waits up to 15 s for a worker that is installing (`update.js:36-37`); a later start of the install makes that wait longer for a person who taps Reload at once. Option 1 delays the "new version" install, not the detection (the bootstrap's build stamp still drives the strip).

## How to measure it
`npm run load` with a deploy between load 1 and load 2: compare the phases and the `bytes` field of the boot report for the first load after the deploy, with and without the change.
