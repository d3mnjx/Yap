---
id: C1-03
title: Preload only the modules of the boot graph, not the Settings, Admin and Channel pages
category: 1
journey: cold-open
effort: S
confidence: medium
behaviour-change: none
estimated-gain: 149 KB raw, about 47 KB gzip (sum of per-file gzip) of modules that no first page needs leave the cold load's competition for the link: about 375 ms of a 1 Mbit/s link, only when client-core-17 also keeps the worker's precache off the critical path. On a warm open, six fewer worker fetches and module parses at start (unknown, small).
experiment: E03
sources: [client-core-16, backend-request-07]
files: [Yap/Endpoints/ShellAssets.cs:138-155, Yap/wwwroot/index.html:113-118, Yap/wwwroot/js/main.js:36-44]
---

## What the code does now
`ShellAssets` writes a `modulepreload` link for every module under `js/` except `js/data/` (ShellAssets.cs:154):

```cs
ModulePreloads = string.Join("\n    ", modules.Where(p => !p.StartsWith("/js/data/")).Select(p => $"""<link rel="modulepreload" href="{p}?v={v}" />"""));
```

That is 42 links. The module graph, counted from the static imports:

- `main.js` and its static closure: 29 modules (main, store, update, api, hub, router, ui/frame, ui/overlays, session, render/text, render/time, render/dom, sender, notify, scene, offline/snapshot, offline/db, offline/outbox, push, render/avatar, ui/confirm, ui/pins, ui/timeline, ui/message, ui/voice, ui/gallery, ui/emoji-picker, pwa, upload).
- The chat route adds 4: pages/chat, ui/composer, ui/gif-picker, ui/recorder. A signed-in open runs 33 modules.
- The sign-in pages: pages/login, pages/verify, pages/invite (a signed-out first visit needs login).
- Only Settings, Admin or Channel settings need 6: pages/admin (77 KB), pages/settings (38 KB), pages/settings-debug, pages/channel-settings, ui/gif-library, ui/tooltip. Together 148,942 bytes raw, 46,808 bytes gzip.
- `js/data/emoji-list.js` (44 KB raw, 16 KB gzip): imported by `ui/emoji-picker.js` on the first open only, not preloaded (already done, perf notes 2026-10-31).

## Why it costs the user time
A `modulepreload` is a high-priority fetch plus a parse. On the cold first visit all 42 go out at once over HTTP/2, and the link is the bottleneck: the 47 KB for pages nobody opened yet delay the 29 modules `main.js` waits for. On a warm open the worker answers each from the cache and the browser parses each, for pages the start does not show.

## The change
Compute the preload list from the import graph, in the same startup scan, instead of from the directory: start at `/js/main.js`, `/js/pages/chat.js` and `/js/pages/login.js`, follow `import ... from './x.js'` and `import './x.js'` with a regex over each file, and preload the closure. Keep the import map and the worker's list as they are (every module), so a later `import()` of Settings still hits the worker's cache with the right `?v=`. About 25 lines in `ShellAssets.cs`; no list by hand.

## Risks and what could break
- The first Settings or Admin open on a page that the worker has not cached yet fetches its modules then, with one import level per round trip (settings.js, then gif-library and settings-debug). The worker's precache normally has them.
- A dynamic `import()` inside a boot module would be missed by a static scan; there is one today (`ui/emoji-picker.js` imports `js/data/`), which should stay out anyway.

## How to measure it
Cold first visit on the far link (`npm run load`, load 1): the `scripts` phase and the bytes on the wire, together with client-core-17. Warm: the number of worker fetch events at start.

## Also found by

The same finding, from another reader's angle: `raw/backend-request/07-modulepreload-only-start-modules.md`. The raw files hold their reasoning and numbers.
