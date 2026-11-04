---
id: backend-media-16
title: Start the trending request together with the three library requests when the GIF picker first opens
area: backend-media
journey: picker-gif
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One round trip (about 900 ms for the far user) before the trending grid of Browse, the default tab when a provider is configured, on the first picker open of every page load.
confidence: high
files: [Yap/wwwroot/js/ui/gif-picker.js:40-55, Yap/wwwroot/js/ui/gif-picker.js:77-84]
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
(gif-picker.js:45-50). `firstTab()` returns `'browse'` whenever a provider is configured (line 40), and Browse shows the trending grid (lines 190-199).

## Why it costs the user time
The trending GET starts only after the slowest of the three library GETs has answered, so the grid needs two round trips plus the server's Klipy call. `configured()` reads `state.config`, which is known before the picker opens. Every user pays on the first open per page load; the far user about 900 ms. The `/favorites` answer can be large (findings 17 and 18), which delays trending further.

## The change
Start `loadTrending()` before the `await`, when `configured()`:
```js
if (configured()) loadTrending();
await Promise.all([load('recent'), load('favorites'), load('server')]);
tab = firstTab();
```
`loadTrending` already calls `render()` when it lands, and `render()` draws nothing for the grid until `tab` is set. Two lines moved. This is client code (js/ui/gif-picker.js), outside the backend area; noted for the client reader.

## Risks and what could break
- If trending lands before the tab is set, its render is a no-op and the later `render()` (line 54) draws it. No visible change.
- One more parallel request at open; over HTTP/2 this costs nothing extra.

## How to measure it
Journey "picker-gif" on a throttled link: time from the tap on the GIF button to the first trending card in the DOM.
