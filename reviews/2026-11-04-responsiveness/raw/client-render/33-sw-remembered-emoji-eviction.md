---
id: client-render-33
title: Evict the worker's emoji memory one entry at a time, not all at once
area: client-render
journey: picker-emoji
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The memory layer holds 1,000 emoji answers and clears all of them when full. The picker alone holds about 1,000 cells (925 Unicode plus 76 pack images), so scrolling through the picker fills the memory and the next entry wipes the rows' emoji too. The next draw of the rows then reads storage again, about 3 ms per image one after another on the iPhone (measured 2026-10-31). An oldest-first eviction keeps the recently used rows' emoji. Small, rare.
confidence: low
files: [Yap/wwwroot/service-worker.js:114-134]
---

## What the code does now
```js
const REMEMBER_MAX = 1000;
function rememberedFirst(request) {
    if (!remembered.has(request.url)) {
        if (remembered.size >= REMEMBER_MAX) remembered.clear();
```
(`service-worker.js:121-124`). The comment accepts it: "when it is full it starts over, and the rows read the storage once more" (`service-worker.js:118-119`).

## Why it costs the user time
After a full clear, the next redraw of the rows (a reset, a reaction, client-render-04 or -05) sends each emoji to the storage again. On the iPhone the storage answered about 3 ms per image, one after another; 200 emoji then take about 0.6 s to show. Who pays: WebKit users who browse the whole picker.

## The change
A `Map` keeps insertion order. Re-insert on every hit (delete and set) and drop the oldest key when full:

```js
const hit = remembered.get(request.url);
if (hit) { remembered.delete(request.url); remembered.set(request.url, hit); }
else {
  if (remembered.size >= REMEMBER_MAX) remembered.delete(remembered.keys().next().value);
  remembered.set(request.url, ...);
}
```

## Risks and what could break
None known. Memory stays capped at 1,000 entries.

## How to measure it
On the iPhone: scroll the whole picker, close it, react to a message (a row redraw). The Settings debug card's emoji timings for that redraw, before and after.
