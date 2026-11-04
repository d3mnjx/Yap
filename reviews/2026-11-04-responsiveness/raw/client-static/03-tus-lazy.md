---
id: client-static-03
title: Load tus.min.js on the first upload, not as a parser-blocking script at every boot
area: client-static
journey: cold-open
category-guess: 1
behaviour-change: none; on the very first upload of a first session, before the worker is installed, the upload starts one fetch later
effort: S
estimated-gain: "Cold: 26.8 KB (gzip level 1) off the path that main.js waits for, about 215 ms at 1 Mbit/s. Warm: no compile and run of 87 KB of script at every boot (unknown ms on a phone)."
confidence: high
files: [Yap/wwwroot/index.html:1328-1332, Yap/wwwroot/js/upload.js:2, Yap/wwwroot/js/upload.js:45, Yap/wwwroot/js/upload.js:73, Yap/Endpoints/ShellAssets.cs:23]
---

## What the code does now
- `index.html:1331`: `<script src="lib/tus.min.js?v={{build}}"></script>`, a classic script at the end of the body, without `defer` or `async`.
- `lib/tus.min.js` is 87,020 B raw, 26,846 B at gzip level 1.
- A classic parser-inserted script blocks the parser and also waits for every stylesheet before it. `main.js` (`index.html:1332`, a deferred module) runs only after it.
- Only `upload.js` uses the global: `new tus.Upload(...)` at `upload.js:45` and `upload.js:73`.
- The worker already precaches `lib/*.js` with the build stamp (`ShellAssets.cs:23`).

## Why it costs the user time
Cold: the far user downloads 27 KB that the first screen does not need before `main.js` may run, so the bootstrap fetch of a first visit starts later. Warm: every boot parses and runs 87 KB of script (the worker serves it, but the compile is on the main thread). Who pays: everyone; first visits on the far link most.

## The change
1. Delete `index.html:1331`.
2. In `upload.js`, a small loader used before the first `new tus.Upload`:
   ```js
   let tusReady;
   function loadTus() {
     return tusReady ??= new Promise((resolve, reject) => {
       const s = document.createElement('script');
       s.src = `/lib/tus.min.js?v=${encodeURIComponent(document.documentElement.dataset.build)}`;
       s.onload = resolve; s.onerror = reject;
       document.head.append(s);
     });
   }
   ```
   and `await loadTus()` at the start of the two upload paths.

Related, same place: `lib/signalr.min.js` (47,953 B raw, 16.7 KB gzip level 1) is needed at boot but the preload scanner finds it only at the end of the 97 KB page. A `<link rel="preload" as="script" href="lib/signalr.min.js?v={{build}}">` in the head starts it with the modules. Gain unknown, small on HTTP/2.

## Risks and what could break
- The URL must carry the same `?v=` stamp as the precache entry, or the worker misses and fetches it.
- A failed script load must fail the upload with the usual error path.

## How to measure it
`npm run load`: cold `scripts` phase before and after. Warm: a Performance trace on a phone, "Evaluate Script" time for tus.min.js at boot (should disappear).
