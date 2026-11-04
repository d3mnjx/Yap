---
id: client-static-24
title: Measure the scroll cost of the full-height masked pattern layer in the pattern themes
area: client-static
journey: all
category-guess: 2
behaviour-change: none for the measurement; a different pattern technique would be a design change
effort: S
estimated-gain: "Unknown, needs measurement. Affects Terminal and Neon Glow everywhere, and DMs in Daylight, Ocean, Sunset and Tea House."
confidence: low
files: [Yap/wwwroot/app.css:163-211, Yap/wwwroot/app.css:125-139, Yap/wwwroot/themes.css:296-347, Yap/wwwroot/themes.css:395-412, Yap/wwwroot/themes.css:458-478]
---

## What the code does now
- `app.css:196-211`: `.messages-flow::before` is `position: absolute; inset: 0; z-index: -1;` with `background-color: var(--pattern-color)` and `mask-image: var(--canvas-pattern)`. It spans the whole scroll content, so its height is the height of every loaded row (about 60 px per row; 3,000 px at an open, 60,000 px after 20 older pages).
- The masks are SVG data URIs of 64 to 260 px tiles (`app.css:134-139`).
- Themes with a pattern: Terminal (`themes.css:398-399`) and Neon Glow (`:460-461`) everywhere; DMs in Daylight (`:338-341`), Ocean and Sunset (the generic DM rule, `:296-299`), Tea House (`:345-347`). The other themes set `none` and `transparent`, so the layer paints nothing.

## Why it costs the user time
Every newly exposed tile of the scrolling list composites a masked layer under the rows: an extra mask raster and blend per tile during a fling. On a fast machine this is invisible; on a slow phone it may cost raster time per frame. The size is unknown, and only users of those themes and contexts pay.

## The change
Measure first: a Performance trace of a fling in a Terminal room and in a discord-dark room on a phone, with 500 rows loaded; compare raster time and dropped frames. If the masked layer costs frames, options (each a design decision): a per-theme tinted SVG as a plain `background-image` with `background-attachment: local` on `.messages` (one image per theme instead of one shape for all), or the pattern on a fixed backdrop (rejected once, 2026-08-25, for design reasons).

## Risks and what could break
None for the measurement. The pattern's z-index choreography (`app.css:175-190`) and the `overflow-anchor: none` guard (`:202-207`) must survive any change.

## How to measure it
As above: chrome://tracing or the DevTools Performance panel with "Enable advanced paint instrumentation", Terminal vs discord-dark, same rows, same device.
