---
id: client-static-04
title: Ship the emoji-toggle sprites as lossless WebP (85.0 KB to 31.5 KB)
area: client-static
journey: cold-open
category-guess: 1
behaviour-change: none (lossless, same pixels)
effort: S
estimated-gain: "-53.4 KB measured on every first visit, about 430 ms of a 1 Mbit/s link, and the same at every worker install that misses the HTTP cache."
confidence: high
files: [Yap/wwwroot/css/composer.css:451-484, Yap/wwwroot/emoji_selection_color.png, Yap/wwwroot/emoji_selection_greys.png, Yap/Endpoints/ShellAssets.cs:30, Yap/wwwroot/js/ui/composer.js:480-486, Yap/wwwroot/service-worker.js:76-78]
---

## What the code does now
- The composer's emoji button draws one 22 px cell of a 960 x 192 sprite (`composer.css:453-472`). The grey state uses `emoji_selection_greys.png` as a mask; hover and an open picker use `emoji_selection_color.png` (`:474-484`).
- `composer.css:469-471` fetches the colour sprite at boot on purpose: `background-image: url(/emoji_selection_color.png); background-size: 0;` ("Preload color sprite to avoid flash on first hover").
- Sizes: colour 45,887 B, greys 39,111 B, 84,998 B together, both RGBA PNG.
- Lossless WebP (libwebp through ffmpeg, `-lossless 1 -compression_level 6`), measured in the scratchpad: colour 19,040 B, greys 12,508 B, 31,548 B together.
- The worker precaches root `*.png` (`ShellAssets.cs:30`); root `*.webp` is not in that glob. The worker's asset test already includes `webp` (`service-worker.js:77`).

## Why it costs the user time
Both sprites load in the first seconds of every first visit, next to the CSS, the modules and the bootstrap, for one 22 px icon. 53 KB is about 430 ms of a 1 Mbit/s link. Who pays: every first visit; far users most. Phones never hover, so the colour sprite's early fetch helps only desktop.

## The change
1. Convert both files to lossless WebP (`emoji_selection_color.webp`, `emoji_selection_greys.webp`).
2. `composer.css:459,460,470,480`: point the four `url()`s at the `.webp` files. The cell math (`440px 88px`, `-22px` steps) stays, the pixel size is the same.
3. `ShellAssets.cs:30`: add `.Concat(Files(webRoot, ".", "*.webp"))` so the worker keeps precaching them.

## Risks and what could break
- Without step 3 an offline cold start loses the icon.
- WebP as `mask-image`: supported in current Chrome, Safari (14+) and Firefox.

## How to measure it
Boot report `bytes` for first visits; resource timing of the two files in `npm run load` cold.
