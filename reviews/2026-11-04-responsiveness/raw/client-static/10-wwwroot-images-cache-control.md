---
id: client-static-10
title: Give the wwwroot images and the sound a Cache-Control, so a deploy does not cost a revalidation
area: client-static
journey: warm-open
category-guess: 1
behaviour-change: none; a redrawn image under the same name takes up to a day to reach a browser (as for the emoji packs)
effort: S
estimated-gain: "Unknown, needs measurement. Up to one round trip (about 900 ms far user) before the Tea House scene shows after each deploy, and one conditional request per plain file at each worker install, whenever the browser's heuristic freshness has run out."
confidence: low
files: [Yap/Program.cs:358-373, Yap/wwwroot/service-worker.js:13, Yap/wwwroot/service-worker.js:41-44, Yap/wwwroot/service-worker.js:69, Yap/wwwroot/service-worker.js:76-78, Yap/Endpoints/ShellAssets.cs:26-31]
---

## What the code does now
- `Program.cs:363-373` sets `Cache-Control` for `.js`, `.css` and `.woff2` only. `.png`, `.webp`, `.svg` and `.mp3` from wwwroot get an ETag and Last-Modified, no Cache-Control ("Icons, images and the sound keep the default").
- Without Cache-Control, freshness is heuristic: a browser commonly allows 10 % of the time since Last-Modified. The repo does not record whether a deploy keeps the files' modification times.
- The worker stores every shell asset, the Tea House scene images (`.webp`, not precached: `ShellAssets.cs:26-28`) included, in `yap-shell-{build}` (`service-worker.js:13, 69, 76-78`). `activate` deletes every other cache (`:41-44`), so each deploy drops the scene images.
- The install re-adds the plain files (sprites, icons, header lines, sound) at each deploy (`ShellAssets.cs:29-31`).

## Why it costs the user time
After a deploy, the first open of a Tea House user asks the network for the scene images. If the heuristic freshness has expired, each image waits a conditional request (a round trip, in parallel) and the frame shows the plain `--bg-primary` colour meanwhile. The install also sends one conditional request per plain file in the background. Who pays: Tea House users after each deploy; every device's install after each deploy (background).

## The change
In the `OnPrepareResponse` of the generic `UseStaticFiles` (`Program.cs:365-372`):
```csharp
else if (name.EndsWith(".png") || name.EndsWith(".webp") || name.EndsWith(".svg") || name.EndsWith(".mp3"))
    ctx.Context.Response.Headers.CacheControl = "public, max-age=86400";
```
One day, as for the built-in emoji packs (`Program.cs:342-356`), bounds the time a redrawn image under the same name stays old.

## Risks and what could break
The worker's install uses `cache.add`, which can take an HTTP-cached copy. A redrawn sprite under the same name could then enter the new build's cache from the HTTP cache for up to a day. A new file name avoids it, as for the font.

## How to measure it
After a deploy, a throttled warm open with the Tea House theme: resource timing of `/images/themes/teahouse/**` (transferSize and duration) and the time until the scene paints.
