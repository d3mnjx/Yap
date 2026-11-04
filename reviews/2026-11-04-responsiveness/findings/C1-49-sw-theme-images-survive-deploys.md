---
id: C1-49
title: Keep the theme backgrounds and the italic font in a cache that survives a deploy
category: 1
journey: warm-open
effort: S
confidence: medium
behaviour-change: none
estimated-gain: The worker stores the Tea House scene images (about 155 KB per scene, 5 files, 13 scenes, 1.5 MB in all) and the italic font in the per-build shell cache, which every deploy deletes. After each deploy the first open of each scene asks the network again: a revalidation round trip (the images have no Cache-Control) or a full download, about 1.2 s of link per scene at 1 Mbit/s. After the change: no request after a deploy.
experiment: none
sources: [client-render-29]
files: [Yap/wwwroot/service-worker.js:41-45, Yap/wwwroot/service-worker.js:67, Yap/wwwroot/service-worker.js:76-78, Yap/Endpoints/ShellAssets.cs:26-31, Yap/Program.cs:358-373, Yap/wwwroot/themes/teahouse.css:12-16]
---

## What the code does now
`isShellAsset` matches `.webp`, `.woff2` and the other static types (`service-worker.js:76-78`), and the fetch handler answers them with `cacheFirst(request, SHELL_CACHE)` (`service-worker.js:67`). `SHELL_CACHE` is `yap-shell-${BUILD}` (`service-worker.js:13`); `activate` deletes every cache except the current shell, the emoji and the media caches (`service-worker.js:41-45`). The precache list leaves out the italic font and `images/themes` on purpose (`ShellAssets.cs:26-31`), so these files enter the shell cache on first use and leave it at the next deploy.

The Tea House theme uses five images per scene (`teahouse.css:12-16`); the `midnight` scene is about 155 KB (72 KB footer, 44 KB header tile, 32 KB footer tile, two small files). The static file rule gives these images no `Cache-Control` (`Program.cs:358-373`, only `.js`, `.css` and `.woff2` get one), so the browser's HTTP cache uses a heuristic.

## Why it costs the user time
The scene paints with the first frame of the page. After a deploy, its images are not in the new shell cache. The browser then revalidates them (one round trip, about 0.9 s for the far user, before the background shows) or downloads them again. The scene changes during the day, so each scene pays once per build. The italic font is immutable over HTTP, so it usually comes from the HTTP cache without the network, but only while the browser keeps it. Who pays: Tea House users after each deploy, far users most.

## The change
A build-independent cache for the static files that the precache leaves out:

```js
const STATIC_CACHE = 'yap-static-v1';   // theme backgrounds and the italic font: stable names, kept across builds
...
const PRECACHED = new Set(SHELL_URLS);
...
// before the isShellAsset line: a static file the precache leaves out
if (isShellAsset(url.pathname) && /\.(webp|woff2)$/.test(url.pathname) && !PRECACHED.has(url.pathname)) { event.respondWith(cacheFirst(request, STATIC_CACHE)); return; }
```

This catches the theme images and the italic font, which the precache list does not hold, and leaves the precached regular font, the icons and every script and stylesheet in the shell cache. Scripts and stylesheets must stay out of it: a bare `.js` URL kept across builds would serve old code.

Add `STATIC_CACHE` to the keep list in `activate`. A redrawn theme image or a new font then needs a new file name or a new cache name, the same rule as the fonts already follow (comment `Program.cs:358-362`) and as the emoji packs follow (`Program.cs:341-347`).

## Risks and what could break
A theme image redrawn under the same name would stay old on devices until the cache name changes. Record that rule at the constant and in `fonts/`.

## How to measure it
On a device with the Tea House theme, deploy a new build, open the app on a throttled link. Network panel: requests for `/images/themes/` and their status, before and after.