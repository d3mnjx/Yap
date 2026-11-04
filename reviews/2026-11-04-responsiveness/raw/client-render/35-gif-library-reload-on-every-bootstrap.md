---
id: client-render-35
title: Do not reload the Settings GIF library on every bootstrap, and debounce its filter
area: client-render
journey: admin
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: While the Settings page with the GIF library is open, every bootstrap (every reconnect) and every star change sends GET /api/gifs/library and redraws the grid. The filter field redraws the grid on every keystroke. Small; one request per reconnect on the far link.
confidence: medium
files: [Yap/wwwroot/js/ui/gif-library.js:41-49, Yap/wwwroot/js/ui/gif-library.js:230-234]
---

## What the code does now
```js
filter.addEventListener('input', () => { query = filter.value; visible = FIRST[server ? 'server' : 'user']; render(); });
const offFavorites = on('favoriteGifIds', () => { if (!server) load(); });
```
(`gif-library.js:230-233`). `applyBootstrap` fires `favoriteGifIds` on every bootstrap (`store.js:48`), so each reconnect reloads the library. `render()` rebuilds every visible card, each with a `<select>` of all folders and five or more listeners (`gif-library.js:95-158`).

## Why it costs the user time
A reconnect is the moment the far user waits for fresh data; one more request and response share the link. The filter redraw per keystroke rebuilds up to 28 cards (the admin's first batch) each time. Who pays: people in Settings or the admin GIF tab; far users on reconnect.

## The change
- In the `favoriteGifIds` listener, compare the set of ids with the last one seen and reload only when it changed.
- Debounce the filter by about 150 ms, or keep the cards and toggle `hidden` per card instead of rebuilding.

## Risks and what could break
ST-23 (a star elsewhere changes the pool at once) still holds: a real change reloads.

## How to measure it
Open Settings, force a reconnect, count requests to `/api/gifs/library`.
