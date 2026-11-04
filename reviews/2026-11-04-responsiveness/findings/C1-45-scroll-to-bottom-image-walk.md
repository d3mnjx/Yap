---
id: C1-45
title: Drop the per-image load listeners in scrollToBottom; the ResizeObserver already follows
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: Each scrollToBottom frame walks every <img> of the list (thousands in a long loaded history) and adds a load listener to each one still loading. Each such load then schedules another scroll frame with a forced layout and another walk. Emoji and avatars have a fixed size, so their loads never change the height. After the change: one scroll per frame and no walk. Exact ms unknown.
experiment: none
sources: [client-render-11]
files: [Yap/wwwroot/js/ui/timeline.js:266-282, Yap/wwwroot/js/ui/timeline.js:377-385, Yap/wwwroot/app.css:353-356, Yap/wwwroot/css/frame.css:19-41]
---

## What the code does now
```js
scrollFrame = requestAnimationFrame(() => {
  scrollFrame = 0;
  list.scrollTop = list.scrollHeight;
  for (const img of flow.querySelectorAll('img')) {
    if (img.complete || watched.has(img)) continue;
    watched.add(img);
    img.addEventListener('load', () => { if (following) scrollToBottom(); }, { once: true });
  }
});
```
(`timeline.js:270-279`). `scrollToBottom` runs for every new message, every reset, every pending change while following, and every visible return.

A `ResizeObserver` on the flow and the list already scrolls to the bottom when the content height changes while following (`timeline.js:379-385`):

```js
const sizes = new ResizeObserver(() => {
  if (following) list.scrollTop = list.scrollHeight;
  ...
});
sizes.observe(flow); sizes.observe(list);
```

Emoji images have a fixed CSS box (`img.emoji { height: 1.2em; width: 1.2em }`, `app.css:353-356`), and avatars too (`.avatar-medium 40px`, `frame.css:25-29`).

## Why it costs the user time
An image whose load changes the height of the flow fires the observer, which scrolls. The load listeners repeat that work, and they also fire for images that cannot change the height (emoji, avatars), each costing a frame with `scrollHeight` (a forced layout) and a full `querySelectorAll('img')`. At an open, 50 rows hold hundreds of emoji images (the iPhone measured 524 emoji requests in 3 s for two draws), so this can mean dozens of extra layout frames. In a busy room it repeats for every message. Who pays: everyone; long histories and phones most.

## The change
Remove the `for` loop and the `watched` set; keep the single `list.scrollTop = list.scrollHeight` in the frame. If a case remains that the observer misses (none is known), limit the walk to the newest row's images and skip `img.emoji` and `.avatar-image`.

## Risks and what could break
TL-04 (the bottom stays in view after the newest pictures load) must still hold. The observer covers it when the flow grows. Check a GIF without size data (`gif-message` with `aspect-ratio: 1` fallback, `message.js:177`) and an old stored row without image sizes (`message.js:143`): both change the flow height when they load, so the observer fires. Test with the existing browser tests in `tests/browser` (the screenshots suite and the smoke suite).

## How to measure it
A busy room on a phone: record a profile while messages with emoji arrive at one per second. Count frames with a forced layout from `scrollToBottom` and the time in `querySelectorAll`.