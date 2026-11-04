---
id: client-render-12
title: Load and play a row's GIF video only near the view
area: client-render
journey: all
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Every GIF video in every loaded row downloads in full at draw time (preload auto, autoplay, play()). A 50-row tail or an older page with k GIF rows costs k full video files on the wire at once, whether the rows are in view or not; at 1 Mbit/s every 125 KB is one second of the link. After the change, only GIFs within about one screen of the view load. Exact bytes depend on the history; unknown, needs measurement.
confidence: medium
files: [Yap/wwwroot/js/ui/message.js:173-200, Yap/wwwroot/service-worker.js:69-73]
---

## What the code does now
```js
const media = g.isImage
  ? el('img', { src: g.src, ..., loading: 'lazy', onerror: imageFailed })
  : el('video', { src: g.src, autoplay: true, loop: true, muted: true, playsinline: true, preload: 'auto', class: 'gif-message-video' });
...
if (!g.isImage) { media.muted = true; media.play?.().catch(noteAutoplayBlocked); }
```
(`message.js:181-186`). An image GIF is lazy. A video GIF (the common case for converted GIFs) is eager: `preload: 'auto'` plus `play()` makes the browser fetch the whole file at draw time, for every row in the loaded history.

A media request from a `<video>` usually carries a `Range` header, and the worker passes range requests to the network (`service-worker.js:71`). So these files come from the HTTP cache (immutable, `Program.cs:301-302`) or from the network, never from the worker's media cache.

## Why it costs the user time
At an open the 50 newest rows draw at once; the person sees about 5 to 10 of them. GIF videos above the view still download and decode. For the far user the link is the limit: these bytes compete with the emoji images, the avatars, the older page and, on a shared link, with the hub. The same happens for each older page. Who pays: GIF-heavy conversations, far users, phones (decode and battery).

## The change
One module-level `IntersectionObserver` in `message.js` with `rootMargin: '100% 0px'` (one screen above and below):
- Build the video with `preload: 'none'` and the source in `data-src`, no `play()`.
- When a video enters the margin: set `src` from `data-src` (once), call `play()`.
- When it leaves: `pause()`.
- `gif()` registers the element with the observer; a row removed from the document drops out of the observer (call `unobserve` in a cleanup, or rely on the `isConnected` check in the callback).

The image GIF path stays `loading: 'lazy'`.

## Risks and what could break
A fast fling can reach a GIF before its first frame arrives; the existing `gif-loaded` class and the placeholder box already cover a GIF that has not loaded (`message.js:184-185`), and the box keeps its size from `aspect-ratio`. The autoplay-blocked path (`noteAutoplayBlocked`, `message.js:31-38`) must still work: the resume handler plays every `.gif-message video`; make it play only those that have a `src`. Pins and the gallery are not affected.

## How to measure it
Open a conversation whose last 50 rows hold 10 or more GIFs, on the `npm run load` link (900 ms, 1 Mbit/s) or a throttled phone. Compare the bytes in the boot report (`bytes`) and the time until the server's rows show their emoji, before and after.
