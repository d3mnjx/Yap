---
id: backend-media-31
title: Give icons, the sound and the theme images a cache lifetime, so a deploy does not refetch them
area: backend-media
journey: resume
category-guess: 1
behaviour-change: A changed theme image or icon reaches devices up to the max-age later (for example a day), unless its name changes.
effort: S
estimated-gain: Unknown, needs measurement. The service worker keeps these files in the per-build cache, which each deploy deletes. Whether the browser then refetches them depends on the HTTP cache: they carry no Cache-Control, only an ETag and Last-Modified that may change with each Docker build. The teahouse theme's images per time slot are 60 to 181 KB (measured); the icons and the sound are about 62 KB.
confidence: low
files: [Yap/Program.cs:358-373, Yap/wwwroot/service-worker.js:34-45, Yap/wwwroot/service-worker.js:67, Yap/wwwroot/service-worker.js:76-78]
---

## What the code does now
- The default static handler sets headers only for `.js`, `.css` and `.woff2` (Program.cs:365-372). The comment says "Icons, images and the sound keep the default (an ETag); the service worker answers them from its cache."
- The worker stores them in `SHELL_CACHE = yap-shell-${BUILD}` (service-worker.js:13, 67, 76-78) and deletes every other shell cache at activate (lines 41-45). Theme images are not precached; they enter that cache at first use, so after each deploy they are fetched again.
- Measured sizes: the teahouse time slots hold 60 KB (2pm) to 181 KB (4am) of WebP each; icon-192.png 7.7 KB, icon-512.png 10.7 KB, notif.mp3 43.9 KB.

## Why it costs the user time
After every deploy, the first open of a teahouse-theme user refetches the slot's background images, and the new worker's install refetches the icons and the sound. Without Cache-Control the browser may answer from its HTTP cache by heuristic, or revalidate (one round trip each), or download again if the ETag changed. On the far link these compete with the rows of the first screen.

## The change
In the `OnPrepareResponse` of the default static handler (Program.cs:365-372), add `public, max-age=86400` for `.png`, `.svg`, `.webp` and `.mp3` outside the dynamic folders, the same rule the emoji packs use (line 355), with a comment that a redrawn image needs a new name or waits a day. About 3 lines.

## Risks and what could break
- A redrawn theme image or icon with the same name shows up to a day late on browsers that cached it. The emoji packs accept the same trade.
- Branding overrides in Data/branding are served by their own middleware and are not affected.

## How to measure it
After a deploy, on a device with the teahouse theme, look at the network panel for `/images/themes/` requests and their status (200, 304 or from cache).
