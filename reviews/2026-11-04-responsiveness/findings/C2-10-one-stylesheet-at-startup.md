---
id: C2-10
title: Serve the nine stylesheets as one file, joined at startup like the import map
category: 2
journey: cold-open
effort: M
confidence: medium
behaviour-change: none
estimated-gain: "9 requests become 1 and the gzip output shrinks by 3.5 KB (level 1) to 6.3 KB (level 9), measured. Over HTTP/2 the request saving is small. Over HTTP/1.1 to Kestrel (the compose file publishes Kestrel directly), nine requests over six connections take two serial round trips and one file takes one: about 900 ms less for the far user on a first visit."
experiment: none
sources: [client-static-15]
files: [Yap/wwwroot/index.html:93-103, Yap/Endpoints/ShellAssets.cs:20-35, Yap/wwwroot/css/README.md:8-17, css_architecture.md:3-15]
---

## What the code does now
- `index.html:93-103`: nine `<link rel="stylesheet">`, in the order of `css/README.md` (later files win ties).
- Gzip level 1 of the nine files separately: 78,792 B; of the same bytes joined in that order: 75,226 B. Level 9: 63,710 B separately, 57,396 B joined.
- Every `url()` in the nine files is absolute or a data URI (`/fonts/...`, `/images/themes/...`, `/emoji_selection_*.png`), so a joined file at the root resolves them the same.
- `ShellAssets` already scans wwwroot once at startup to write the import map, the preloads and the worker list (`ShellAssets.cs:18-35`).

## Why it costs the user time
On a first visit all nine files block the first paint and `main.js`. Each is a request; on HTTP/1.1 they queue on six connections, and every queued request costs a round trip (about 900 ms far user). On HTTP/2 the cost is a few header frames and a slightly worse compression ratio. Who pays: first visits; most on an HTTP/1.1 deployment.

## The change
`ShellAssets` reads the nine files in the README order at startup, joins them with a `/* ==== file ==== */` line between parts, and keeps the string. An endpoint serves it at `/app.bundle.css?v={build}` with `public, max-age=31536000, immutable`. The page gets one `<link>`; the worker list gets the bundle in place of the nine. In Development the bundle is rebuilt per request, as the `{{build}}` stamp is. The source files stay as they are; no tool beyond dotnet.
If client-static-06 lands, join the blocking files only and keep `pages-app.css` apart.

## Risks and what could break
- DevTools shows one file (section comments mark the parts).
- The README's load order becomes code: keep the list in one place (`ShellAssets`) and point the README at it.

## How to measure it
`npm run load` cold over HTTP/1.1 and behind Caddy with HTTP/2: the `scripts` phase and the request count.