---
id: client-render-20
title: Do not reload and redraw the GIF picker while it is closed, and draw once per open
area: client-render
journey: resume
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: After the picker opened once in a page's life, every bootstrap (every connect and reconnect) sends GET /api/gifs/favorites and redraws the picker grid twice, with up to 30 autoplay <video> previews, while the picker is closed. Every star click does it twice. Each open draws the grid two to five times. The request lands on the resume path of the far user, next to openRoom. Bytes of the hidden previews unknown, needs measurement.
confidence: high
files: [Yap/wwwroot/js/ui/gif-picker.js:68-75, Yap/wwwroot/js/ui/gif-picker.js:112-126, Yap/wwwroot/js/ui/gif-picker.js:256-264, Yap/wwwroot/js/ui/gif-picker.js:293, Yap/wwwroot/js/store.js:36-49]
---

## What the code does now
```js
on('favoriteGifIds', () => { if (everOpened) load('favorites').then(() => { ... }); render(); });
```
(`gif-picker.js:293`). `applyBootstrap` fires `favoriteGifIds` on every bootstrap (`store.js:48`), and a star click fires it twice (the local toggle and the server's `gifFavorites` message, `store.js:350-358`). `load()` calls `render()` when its answer comes (`gif-picker.js:73`). `render()` replaces the whole results grid (`gif-picker.js:119-125`); each provider or video card gets a new `<video autoplay muted loop preload="metadata">` (`gif-picker.js:256-264`). None of this checks whether the picker is open.

On a first open, `render()` runs once per answering list (three), once more in `opened()`, and once when trending answers. On a reopen, `opened()` renders and `load('recent')` renders again when it answers (`gif-picker.js:51`, `54`).

## Why it costs the user time
- At every resume the far user's link carries one more request and response while the conversation reopens.
- Each redraw throws away the grid's video elements and creates new ones; video elements with `autoplay` may load data even when not shown (browser behaviour for hidden media is not certain; needs measurement).
- During an open, the grid flickers and restarts its previews several times as lists arrive.
Who pays: everyone who used the GIF picker in this page life; far users on resume.

## The change
- Keep a flag `isOpen` (set in `opened()`, cleared by the composer's `closePicker`; or check `picker.isConnected && picker.offsetParent !== null`). In the `favoriteGifIds` listener, only mark `cache.favorites` as stale when the picker is closed; reload it in the next `opened()`.
- In `render()`, return early when the picker is closed.
- Render the active tab only when its data changed: in `load(name)`, call `render()` only when `name` is the tab on screen (or the search is empty and the tab is Browse and the list feeds a Browse tile).

About 15 lines.

## Risks and what could break
PK-36 says a star elsewhere shows at once in the picker. With the stale flag, the open picker still reloads at once; a closed picker reloads at its next open, before it draws. The `folder` reset logic inside the listener (`gif-picker.js:293`) moves into the reload.

## How to measure it
Open the GIF picker once, close it, then force a reconnect (DevTools offline and back). Count requests to `/api/gifs/favorites` and media requests to the provider in the Network panel.
