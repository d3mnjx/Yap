---
id: C1-02
title: Load the tus library on the first upload instead of as a blocking script at every start
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: An 87 KB (22 KB gzip) classic script leaves the boot path. On every load its parse, compile and top-level run happen on the main thread before `main.js` can run (unknown, likely a few ms to 10+ ms on a phone). On a cold first visit, 22 KB less competes with the boot modules (about 180 ms of a 1 Mbit/s link).
experiment: E02
sources: [client-core-15, client-static-03, backend-request-08]
files: [Yap/wwwroot/index.html:1330-1332, Yap/wwwroot/js/upload.js:43-92, Yap/Endpoints/ShellAssets.cs:138-142]
---

## What the code does now
The end of the body (index.html:1330-1332):

```html
<script src="lib/signalr.min.js?v={{build}}"></script>
<script src="lib/tus.min.js?v={{build}}"></script>
<script type="module" src="js/main.js?v={{build}}"></script>
```

Both are parser-blocking classic scripts; the module script runs after them. `lib/tus.min.js` is tus-js-client 4.3.1, 87,020 bytes raw, 22,424 bytes gzip. Only `upload.js` uses the global `tus`, inside `upload()` and `uploadOne()`, that is, when a person sends a file, records a voice message or adds a GIF to a library. `ShellAssets` puts `lib/*.js?v=` in the worker's precache list (ShellAssets.cs:140), so the file is available offline either way.

## Why it costs the user time
Every start parses and runs the library before the app's own code, for a feature most opens never use. On a phone the main thread is the bottleneck of the warm open. On a cold load its bytes share the link with the modules that `main.js` waits for.

## The change
Remove the `tus.min.js` tag from `index.html`. In `upload.js`, load it once on first use:

```js
import { build } from './update.js';
let loading = null;
const tusReady = () => window.tus ? Promise.resolve() : (loading ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = `/lib/tus.min.js?v=${encodeURIComponent(build ?? '')}`;   // the versioned URL the worker precached
  s.onload = resolve; s.onerror = () => { loading = null; reject(new Error('Upload library unavailable')); };
  document.head.append(s);
}));
```

Await `tusReady()` inside each file's promise in `upload()` (a failure becomes `{ retry: file }`, which the sender already treats as "try at the next wake-up") and in `uploadOne()`.

## Risks and what could break
- The first upload waits for a script load: a worker cache hit, a few ms. Offline before the worker stored the shell, the load fails and the row waits, as a network failure does today.
- The `?v=` must match the precached URL, or the worker's `cache.match` misses (it compares the query).

## How to measure it
Warm open on a phone: the boot report's `scripts` phase before and after (the mark is the first statement of `main.js`). Cold open on the far link: the `scripts` phase and the bytes.

## Also found by

The same finding, from another reader's angle: `raw/client-static/03-tus-lazy.md`, `raw/backend-request/08-tus-library-loaded-at-boot.md`. The raw files hold their reasoning and numbers.
