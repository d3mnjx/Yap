---
id: client-render-22
title: Play the GIF picker's video previews only when they are near the view
area: client-render
journey: picker-gif
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The trending grid draws 30 cards (ProviderPage = 30) and each "Load more" adds 30; every card is an autoplay muted video, none lazy. On a phone the sheet shows about 6 to 9 cards. All previews load and decode at once and compete with each other on the link, so the visible ones arrive later. Loading only cards near the view cuts the bytes at open by roughly two thirds (the share of cards off screen). Exact bytes depend on the provider's preview sizes; unknown.
confidence: medium
files: [Yap/wwwroot/js/ui/gif-picker.js:205, Yap/wwwroot/js/ui/gif-picker.js:256-264, Yap/Endpoints/GifEndpoints.cs:15]
---

## What the code does now
```js
function preview(url, isImage, alt) {
  if (isImage) return el('img', { src: url, alt, loading: 'lazy' });
  const video = el('video', { src: url, autoplay: true, muted: true, loop: true, playsinline: true, preload: 'metadata', class: 'gif-card-video' });
  video.muted = true;
  return video;
}
```
(`gif-picker.js:256-264`). The provider page holds 30 items (`GifEndpoints.cs:15`). `bestPreview` picks the smallest video format when one exists (`gif-picker.js:249-254`), so most provider cards are videos. `autoplay` makes the browser load and play every card that the browser lets autoplay.

## Why it costs the user time
On a 1 Mbit/s link the 30 previews split the link, so the 6 to 9 cards in view take several times longer than they would alone. All 30 decode at once on the phone. Who pays: everyone opening the GIF picker; far users and phones most.

## The change
One `IntersectionObserver` per picker, with `root` the results scroller and `rootMargin` of about one view height:
- Create videos with `preload: 'none'` and the URL in `data-src`, no `autoplay`.
- On entering the margin: set `src` once and `play()`; on leaving: `pause()`.

The same helper can serve the row GIFs (client-render-12).

## Risks and what could break
A fast scroll shows empty cards for a moment; the card already reserves its box (`aspect-ratio`, `gif-picker.js:216`, `239`). PK-19 (muted previews) stays: keep `video.muted = true`.

## How to measure it
Open the picker's Browse tab on the far link. Record the Network panel: bytes from the provider's host in the first 5 s, and the time until the first visible card plays.
