---
id: C3-15
title: Show the row's medium picture in the viewer at once, then swap to the large one
category: 3
journey: all
effort: S
confidence: high
behaviour-change: The viewer opens with the sharp-enough picture from the row at once, and gets sharper when the large file arrives.
estimated-gain: The viewer asks for the 1,600 px `large` file and shows nothing until it arrives. The 800 px `medium` file is already in the cache (the row shows it). For the far user a large picture of a few hundred KB takes one round trip plus several seconds at 1 Mbit/s; with the medium first, the picture shows at once.
experiment: none
sources: [client-render-24]
files: [Yap/wwwroot/js/ui/gallery.js:22-28, Yap/wwwroot/js/ui/message.js:142, Yap/Services/Media/ImageService.cs:17-18]
---

## What the code does now
```js
const img = el('img', { src: item.image.large, alt: 'Full size image', draggable: 'false', loading: i === startIndex ? 'eager' : 'lazy' });
img.addEventListener('error', () => { img.src = item.image.medium; }, { once: true });
```
(`gallery.js:24-25`). The row draws `img.medium` (`message.js:142`). The sizes are 800 px for medium and 1,600 px for large (`ImageService.cs:17-18`).

## Why it costs the user time
A tap on a picture opens a black layer that stays empty until the large file arrives. The medium file sits in the worker's media cache and the browser's memory cache, because the row shows it. Who pays: everyone who opens a picture; far users wait seconds.

## The change
Start each stage with the medium file and load the large one beside it:

```js
const img = el('img', { src: item.image.medium, ... });
const large = new Image();
large.onload = () => { img.src = item.image.large; };
large.src = item.image.large;   // only for the start index at once; the others when their stage comes into view
```

For the stages other than the start one, start the large load in the existing `IntersectionObserver` callback (`gallery.js:132-143`) when the stage is in view.

## Risks and what could break
The picture changes resolution once in front of the person (category 3). Fit and fill (TL-26) reads `naturalWidth`; it works with either file, and the double-tap position uses ratios. Download uses `original`, not affected.

## How to measure it
On the far link, open a picture from a row. Time from the tap to a visible picture, before and after.