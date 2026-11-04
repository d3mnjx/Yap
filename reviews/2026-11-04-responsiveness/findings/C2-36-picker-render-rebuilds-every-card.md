---
id: C2-36
title: Keep the GIF grid when its data did not change instead of rebuilding every card
category: 2
journey: picker-gif
effort: M
confidence: medium
behaviour-change: none
estimated-gain: Unknown, needs a phone trace. Each rebuild drops and recreates up to 30 or more video elements (or images), which restarts their loading and decoding. A reopen rebuilds twice; a star elsewhere rebuilds twice. The same class of cost as the timeline's redraw work of 2026-10-31.
experiment: none
sources: [backend-media-23]
files: [Yap/wwwroot/js/ui/gif-picker.js:42-55, Yap/wwwroot/js/ui/gif-picker.js:68-75, Yap/wwwroot/js/ui/gif-picker.js:112-126, Yap/wwwroot/js/ui/gif-picker.js:157-166, Yap/wwwroot/js/ui/gif-picker.js:293]
---

## What the code does now
- `render()` replaces the whole result area: `case 'browse': replace(results, browseView()); break;` (gif-picker.js:124), and `browseView()` builds new tiles and a new grid of new cards each time (lines 190-199, 205).
- `render()` runs after every `load()` (line 73), after `loadTrending()` (line 83), and directly in `opened()` (line 54).
- A reopen calls `load('recent')` and then `render()` (lines 51-54): two full rebuilds, although trending did not change.
- A star anywhere: `on('favoriteGifIds', () => { if (everOpened) load('favorites').then(...); render(); })` (line 293): two rebuilds.
- Each folder tile picks a random sample on every build: `const sample = images[Math.floor(Math.random() * images.length)]` (line 160), so each rebuild can request another preview image.

## Why it costs the user time
New `<video autoplay>` elements start new requests (answered by the HTTP cache at best) and new decoders; the cards flash while they restart. On a phone this is main-thread work at the moment the user opens the picker. The far user also pays for tile samples that change on each rebuild.

## The change
- Keep the trending grid element in `cache` and reuse it while `cache.trending` is the same array (append cards on "Load more" instead of rebuilding).
- In `render()`, skip `replace` when the view's inputs (tab, folder, search state, and the identities of the lists) did not change since the last call.
- Pick each folder tile's sample once per list load, not per render.
- For a star change, redraw only the star buttons (as `redrawStars` does for the timeline, memory `client-render-cost-at-scale`).
About 30 to 40 lines. Client code; noted for the client reader.

## Risks and what could break
- Stale views if a change misses the check; keep the check simple (identity of the arrays that `load()` replaces).

## How to measure it
On a phone (remote DevTools), open the picker, close it, open it again; count video element creations and network requests for the second open, and record a performance trace.