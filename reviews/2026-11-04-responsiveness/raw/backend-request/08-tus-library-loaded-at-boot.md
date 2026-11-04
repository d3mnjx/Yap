---
id: backend-request-08
title: Load lib/tus.min.js on the first upload, not as a blocking script on every start
area: backend-request
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Cold first visit: 87,020 B raw (26.8 KB gzip -1, 22.3 KB gzip -9) leave the critical path, about 0.2 s at 1 Mbit/s. Every start: no parse and execution of 87 KB of script before main.js runs (phone cost unknown).
confidence: medium
files: [Yap/wwwroot/index.html:1330-1332, Yap/wwwroot/js/upload.js:1-3, Yap/wwwroot/js/upload.js:45, Yap/wwwroot/js/upload.js:73, Yap/Endpoints/ShellAssets.cs:23-25]
---

## What the code does now
- The page ends with two classic scripts and then the module entry: `<script src="lib/signalr.min.js?v={{build}}"></script>`, `<script src="lib/tus.min.js?v={{build}}"></script>`, `<script type="module" src="js/main.js?v={{build}}"></script>` (index.html:1330-1332). The classic scripts have no `defer`.
- Only upload.js uses the `tus` global: "lib/tus.min.js defines `tus`" (upload.js:2), `new tus.Upload(...)` (lines 45 and 73).
- ShellAssets puts every `lib/*.js` with its `?v=` stamp into the worker's precache list (ShellAssets.cs:23-25), so the file is in the worker's cache after the first load.

## Why it costs the user time
A classic script without `defer` stops the parser until it is fetched and executed. The module entry runs only after parsing ends. So on a first visit main.js waits for 87 KB of tus (about 22 to 27 KB on the wire) even though no upload happens at start. On a warm start the bytes come from the worker, but the phone still parses and runs them before main.js.

## The change
- index.html: remove the tus script tag (keep the SignalR one, which the start needs).
- upload.js: add a loader used by `uploadOne` and `upload` before `new tus.Upload`:

  ```js
  let tusReady;
  function loadTus() {
    return tusReady ??= new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = `/lib/tus.min.js?v=${encodeURIComponent(document.documentElement.dataset.build)}`;
      s.onload = ok;
      s.onerror = () => { tusReady = null; fail(new Error('tus')); };
      document.head.append(s);
    });
  }
  ```

  The URL must equal the precached one (same `?v=`), so the worker answers it from its cache.
- In `upload()`, start the per-file uploads inside `loadTus().then(...)`; `cancel` and `giveUp` must work before the script arrived (keep a `cancelled` check before creating the uploads).

## Risks and what could break
- The first upload in a tab without the worker (first visit) waits one round trip for the script.
- `upload()` returns `{ promise, cancel, giveUp }` synchronously today; the change keeps that shape but moves the tus objects' creation into a callback, so the cancel path needs a test.
- composer.js imports `check` from upload.js; it does not need tus.

## How to measure it
Cold and warm `npm run load`: the `scripts` phase. On a phone: a Performance trace of a warm start, the time spent evaluating tus.min.js. The first-upload time on the throttled link with and without the worker.
