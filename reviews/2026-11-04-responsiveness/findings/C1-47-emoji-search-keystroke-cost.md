---
id: C1-47
title: Filter the emoji picker from a cached list of cells, not a DOM walk per keystroke
category: 1
journey: picker-emoji
effort: S
confidence: low
behaviour-change: none
estimated-gain: Each keystroke in the emoji search runs querySelectorAll per section, reads a data attribute on about 1,000 buttons, toggles an attribute on each, writes scrollTop, then reads offsetTop per section (a forced layout). A plain array of { button, kw, section } removes the DOM walk and the attribute reads. Small; a few ms per keystroke on a phone (unknown, needs measurement).
experiment: none
sources: [client-render-23]
files: [Yap/wwwroot/js/ui/emoji-picker.js:91-107, Yap/wwwroot/js/ui/emoji-picker.js:110-118, Yap/wwwroot/js/ui/emoji-picker.js:120]
---

## What the code does now
```js
for (const section of sections.children) {
  let hits = 0;
  for (const b of section.querySelectorAll('.emoji-btn')) {
    const hit = !q || (b.dataset.kw ?? '').includes(q);
    b.toggleAttribute('data-search-miss', !hit);
    ...
```
(`emoji-picker.js:94-103`), called on every `input` event without a delay (`emoji-picker.js:120`). Then `content.scrollTop = 0` and `highlight()`, which reads `offsetParent` and `offsetTop` of every section (`emoji-picker.js:105-118`).

## Why it costs the user time
The search input has the focus, so each keystroke waits for this work before the next frame. With the attribute toggles on about 1,000 buttons, the style recalculation that follows covers the whole grid. Who pays: people who search emoji on phones.

## The change
Collect the cells once in `build()` and `fillRecent()` into an array of `{ button, kw, section }`. In `filter`, loop over the array, toggle only when the state changes (keep the last state per cell), and count hits per section in a `Map`. Keep `highlight()` as is.

## Risks and what could break
Recent is rebuilt on each open (`fillRecent`), so its part of the array must be replaced then.

## How to measure it
Type a five-letter search in the picker on a phone and record a performance profile; compare the input event durations.