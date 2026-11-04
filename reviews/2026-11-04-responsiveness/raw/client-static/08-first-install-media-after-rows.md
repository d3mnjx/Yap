---
id: client-static-08
title: Register the worker after the first server rows, so its install does not download media during the first visit's bootstrap
area: client-static
journey: cold-open
category-guess: 1
behaviour-change: none; the worker is installed a few seconds later on a first visit
effort: S
estimated-gain: "About 108 KB that a first visit fetches in parallel with the bootstrap, the hub and openRoom move behind the first rows: about 0.9 s of a 1 Mbit/s link. Warm loads: no change (the worker exists)."
confidence: medium
files: [Yap/wwwroot/js/main.js:88-93, Yap/wwwroot/js/pages/chat.js:132, Yap/wwwroot/js/main.js:143-172, Yap/wwwroot/service-worker.js:34-38, Yap/Endpoints/ShellAssets.cs:26-35, Yap/Endpoints/ShellEndpoints.cs:70]
---

## What the code does now
- `main.js:90` registers the worker at module evaluation, before `start()` (`main.js:172`) sends the bootstrap fetch of a first load.
- The install (`service-worker.js:34-38`) adds every URL of `SHELL_URLS` at once: `Promise.all(SHELL_URLS.map(url => cache.add(url)...))`.
- Most entries are HTTP-cache hits on a first visit (immutable `?v=` scripts and styles, the preloaded font). These are not, measured on disk:
  - `/login` (the page again; `ShellEndpoints.cs:70` sends `no-cache` and no ETag, so a full copy): 26.3 KB at gzip level 1
  - `notif.mp3` 43.9 KB (not fetched by the page until the first tap)
  - `icon-512.png` 10.7 KB and `icon-192.png` 7.7 KB (the page itself never shows them)
  - `js/data/emoji-list.js` 18.2 KB at gzip level 1 (excluded from the preloads on purpose)
  - `images/purpleline01_3px.png` 1.1 KB, `images/bot-avatar.svg` 0.6 KB, `images/klipy-attribution.svg` 0.3 KB
  - In all about 108 KB.

## Why it costs the user time
On a first visit the far user's link carries the bootstrap, the negotiate and handshake, the 50 rows, the avatars and the emoji images. The install's ~108 KB runs in the same seconds and takes about 0.9 s of a 1 Mbit/s link from them. None of it is needed before the rows are on screen. Who pays: first visits, and the first load after a sign-out on a device without a worker.

## The change
In `main.js`, register the worker when the first server rows are on screen (the moment the boot report marks `rows`), or on the first idle period after it:
```js
function registerWorker() { navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(build ?? '')}`).catch(() => {}); }
```
called once where `pages/chat.js:132` sets `performance.mark('rows')` (for example through a small event), with a fallback timer (for example 10 s) for a page that never shows rows (login). The `message` listener stays where it is.

## Risks and what could break
- Offline right after the first visit's first seconds: the shell is not stored yet. Today the install also takes seconds on the far link, so the window exists already.
- The page that must show the "Please refresh" strip relies on the bootstrap's build stamp, not on the worker, so it is unaffected.
- The registration also triggers the worker script fetch (`service-worker.js` with the shell list); that moves too, which is the point.

## How to measure it
`npm run load` cold: `bootstrap`, `socket` and `rows` phases, and the number of requests in flight before `rows` (resource timing). In production: boot report rows with `cached` near 0.
