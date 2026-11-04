---
id: C2-09
title: Move the Settings, channel, admin and GIF-library templates out of the page
category: 2
journey: cold-open
effort: M
confidence: medium
behaviour-change: none, if the templates are in before those pages mount (the worker can precache them)
estimated-gain: "The page drops from 96,885 B to 57,953 B raw, 26.3 KB to 16.6 KB at gzip level 1 (-9.7 KB, about 80 ms at 1 Mbit/s) on a first visit and at each worker install. The parser builds about 40 % fewer inert template nodes at every boot (unknown ms)."
experiment: none
sources: [client-static-16, client-core-30]
files: [Yap/wwwroot/index.html:850-957, Yap/wwwroot/index.html:960-1239, Yap/wwwroot/index.html:1242-1319, Yap/wwwroot/js/render/dom.js:32-40]
---

## What the code does now
- The page is 96,885 B raw; its 62 templates are 82,156 B of it. The head is 8,698 B.
- Templates that only Settings, the channel pages, the GIF library or Admin use (raw bytes): `t-settings` 19,834 and eight small Settings templates (22,611 in all), `t-channel-settings` with `t-pinner-row` and `t-reorder-item` 7,928, `t-admin` 5,775, `t-gif-library` with `t-gif-lib-card` 2,532.
- Measured: the page without those 15 templates is 57,953 B raw, 16,648 B at gzip level 1 (26,337 B today).
- The page is `no-cache` but the worker serves it cache-first, so warm loads do not pay the bytes. A first visit pays them twice: the navigation and the install's `/login` copy (client-static-08).

## Why it costs the user time
The page is the first response of a cold load; its bytes come before anything else is discovered past the head. Every boot also parses the inert templates into DOM fragments. Who pays: first visits on the far link; every boot for the parse (small).

## The change
Put the 15 templates in a static file `pages.html` (precached by the worker, with the build stamp). The page modules that need them (`pages/settings.js`, `pages/channel-settings.js`, `pages/admin.js`, `ui/gif-library.js`) call an `await loadTemplates('pages')` before their first `clone()`; it fetches the file once and appends its `<template>`s to the body. `clone()` stays synchronous.

## Risks and what could break
- A page that clones before the load resolves throws "missing template". The await must be at each page's mount.
- The first Settings open of a cold first session waits one fetch if the worker has not stored the file yet.

## How to measure it
`npm run load` cold: `html` and `scripts` phases. Phone: Performance trace "Parse HTML" at boot.

## Also found by

The same finding, from another reader's angle: `raw/client-core/30-page-only-templates-out-of-index-html.md`. The raw files hold their reasoning and numbers.
