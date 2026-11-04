---
id: client-render-19
title: Ask for the trending GIFs together with the three library lists
area: client-render
journey: picker-gif
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The first open of the GIF picker waits for recent, favorites and server (one round trip), and only then asks for trending (a second round trip). Browse shows "Loading…" for about 1.8 s for the far user. In parallel, trending arrives after one round trip: about 0.9 s saved on every first open per page load when a provider is set up.
confidence: high
files: [Yap/wwwroot/js/ui/gif-picker.js:42-55, Yap/wwwroot/js/ui/gif-picker.js:77-84]
---

## What the code does now
```js
if (!everOpened) {
  everOpened = true;
  await Promise.all([load('recent'), load('favorites'), load('server')]);
  tab = firstTab();
  if (configured()) loadTrending();
}
```
(`gif-picker.js:45-49`). `configured()` reads `state.config`, which the bootstrap set long before (`gif-picker.js:26-27`). The trending request does not depend on the three lists; only the choice of the first tab does.

## Why it costs the user time
Two round trips in a row on the path from the tap to the first GIFs. Browse is the first tab whenever a provider is set up (`firstTab`, `gif-picker.js:40`), so the person looks at the trending grid. Who pays: everyone who opens the GIF picker, far users about 0.9 s per first open.

## The change
```js
if (!everOpened) {
  everOpened = true;
  const trending = configured() ? loadTrending() : null;
  await Promise.all([load('recent'), load('favorites'), load('server')]);
  tab = firstTab();
}
```

`loadTrending` calls `render()` when it ends; with `tab` still null the `switch` draws nothing and the final `render()` in `opened()` draws the trending grid if it is there. A further option (category 2): ask for the four lists at idle after the first rows, so the first open is instant; that costs four requests for people who never open the picker.

## Risks and what could break
None known. The `trendingFailed` path is unchanged.

## How to measure it
On the far link, open the GIF picker for the first time after a load. Time from the tap to the first trending image in the grid.
