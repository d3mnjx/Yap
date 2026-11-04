---
id: client-core-17
title: On a first visit, register the service worker after the first rows instead of at script start
area: client-core
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: On a first visit, the worker's install downloads the files the page did not load itself (estimate from the shell list: the notification sound 44 KB, the icons 19 KB, the emoji list 16 KB gzip, the page again for `/login` about 22 KB gzip, small images) at the same moment as the bootstrap, the socket and the first `openRoom`. About 100 KB, about 0.8 s of a 1 Mbit/s link, leave the critical path. Returning visitors are unaffected.
confidence: medium
files: [Yap/wwwroot/js/main.js:88-94, Yap/wwwroot/service-worker.js:34-39, Yap/Endpoints/ShellAssets.cs:146-155]
---

## What the code does now
`main.js:89-90` registers at module evaluation, before `start()`:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(build ?? '')}`).catch(() => {});
```

On a first visit the worker installs at once and precaches every shell URL in parallel (service-worker.js:34-39, `Promise.all(SHELL_URLS.map(url => cache.add(url)...))`). The list (ShellAssets.cs:139-155) holds every module, stylesheet and `lib` script with `?v=`, the regular font, the root `.png` and `.svg` files (icon-192.png 7.7 KB, icon-512.png 10.7 KB, emoji_selection_color.png 45.9 KB and emoji_selection_greys.png 39.1 KB, which the composer's CSS also loads), `notif.mp3` (43.9 KB), `images/*.png|svg`, and `/login` (the page, `no-cache`, no ETag, so a full download). The versioned scripts and styles come from the HTTP cache (immutable), but the files the page did not load go to the network.

## Why it costs the user time
On the first visit the page itself has just used the link for 60 files. The precache then runs during `fetchBootstrap()`, the socket's set-up and `openRoom`, which are the waits the person sees. On 1 Mbit/s every 8 KB is about 65 ms. The worker is only needed for the next open and for offline use.

## The change
Register at once when a worker already controls the page (a returning visitor: the call is cheap and keeps today's update path). Otherwise register when the first sync settles, or after a fallback delay for a signed-out page that never connects:

```js
const registerWorker = () => navigator.serviceWorker.register(`/service-worker.js?v=...`).catch(() => {});
if (navigator.serviceWorker.controller) registerWorker();
else Promise.race([hub.firstSync(), new Promise(r => setTimeout(r, 10_000))]).then(registerWorker);
```

## Risks and what could break
- A first visit closed within seconds leaves no worker; the next visit is again a network load. Acceptable.
- The Settings push switch and `push.current()` wait for `navigator.serviceWorker.ready`; they already handle a slow or missing worker (push.js:131-139, a 3 s bound).
- The installed app's first launch uses `/pwa-launch`, which the worker serves; an app installed from a page whose worker did not register yet would launch from the network once.

## How to measure it
Cold first visit on the far link (`npm run load`, load 1): `bootstrap`, `socket` and `rows` phases before and after; the network panel shows the precache requests moving after the rows.
