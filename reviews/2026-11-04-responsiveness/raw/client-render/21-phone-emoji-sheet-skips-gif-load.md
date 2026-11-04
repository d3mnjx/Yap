---
id: client-render-21
title: On a phone, open the GIF picker only when its tab shows
area: client-render
journey: picker-emoji
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: On a phone, opening the emoji sheet also opens the GIF picker: on the first open that is four API requests (recent, favorites, server, then trending) and a grid of up to 30 video previews in a hidden tab; on later opens one request and a redraw. These requests share the slow link with the emoji images the person wants to see. Bytes and ms unknown, needs measurement.
confidence: medium
files: [Yap/wwwroot/js/ui/composer.js:418-432, Yap/wwwroot/js/ui/composer.js:395-410, Yap/wwwroot/js/ui/gif-picker.js:42-55]
---

## What the code does now
```js
function openPicker(which) {
  mountPickers();
  container.dataset.picker = which;
  if (which === 'emoji') pickers.emoji.opened();
  if (which === 'gif' || overlays.isPhone()) pickers.gif.opened();
```
(`composer.js:418-422`). On a phone both pickers live in one sheet with two tabs (`composer.js:395-410`); the tab buttons only switch `combined.dataset.activeTab` (`composer.js:398`).

## Why it costs the user time
The person tapped the emoji toggle. The GIF lists and the provider's previews are not on screen, but they load now, on the same 1 Mbit/s link as the emoji images of the grid (cold emoji come from the CDN on a first view). Who pays: phone users, far users most.

## The change
Call `pickers.gif.opened()` when the GIF tab becomes active:
- in `openPicker`, only when `which === 'gif'` or the combined sheet's `activeTab` is the GIF tab;
- in the tab click handler (`composer.js:398`), when the new tab is the GIF tab, call `pickers.gif.opened()` (once per sheet opening; keep a flag).

## Risks and what could break
The sheet keeps its tab across opens (IB-41). A sheet that reopens on the GIF tab must still call `gif.opened()`; the `activeTab` check covers it. A first switch to the GIF tab now shows "Loading…" for one round trip (it showed the same on a cold first open before, only earlier). With client-render-19 that wait is one round trip.

## How to measure it
On a phone (or Chrome device mode with throttling), open the emoji sheet for the first time and record the Network panel: requests to `/api/gifs/*` and to the GIF provider's host before and after.
