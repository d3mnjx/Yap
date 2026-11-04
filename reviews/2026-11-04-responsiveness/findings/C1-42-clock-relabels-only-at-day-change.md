---
id: C1-42
title: Relabel row times only when the day changes, not every minute for every row
category: 1
journey: older
effort: S
confidence: high
behaviour-change: none
estimated-gain: Every 60 s the timer walks every loaded row, formats its time (one format and four to six formatToParts calls) and writes the text even when it is the same. A sandbox V8 check measured 19 ms per 1,000 messageTime calls (desktop, a check only). With 1,000 loaded rows that is the formatting alone, plus 1,000 querySelector calls, 1,000 text node writes and a layout of the whole list, once a minute. After the change: nothing on 1,439 of 1,440 minutes.
experiment: none
sources: [client-render-08]
files: [Yap/wwwroot/js/ui/timeline.js:475-481, Yap/wwwroot/js/render/time.js:93-102]
---

## What the code does now
```js
const clock = setInterval(() => {
  for (const { node, message } of rows.values()) {
    const time = node.querySelector('.message-time');
    if (time) time.textContent = messageTime(message.timestamp);
  }
}, 60_000);
```
(`timeline.js:476-481`). The comment says why: at midnight "today" becomes "Yesterday" (MR-06). `messageTime` changes its output only when the calendar day of `now` changes; the clock time of a message never changes (`time.js:93-102`).

## Why it costs the user time
`rows` holds every loaded row, the older pages included. A reader who scrolled far back has hundreds or thousands of rows. Each minute the timer formats every time, and the `textContent` write replaces the text node even when the text is the same, which invalidates layout for every header row. The result is a periodic long task on the main thread. On a phone it can reach tens to hundreds of milliseconds per minute (unknown, needs measurement). Who pays: big loaded histories, phones, also in a background tab where timers still fire once a minute.

## The change
Keep the day of the last relabel and skip the walk when it did not change:

```js
let labelledDay = new Date().toDateString();
const clock = setInterval(() => {
  const today = new Date().toDateString();
  if (today === labelledDay) return;
  labelledDay = today;
  for (...) { ... }
}, 60_000);
```

The day must be the account's zone, not the browser's: export a small `dayStamp(now)` from `render/time.js` (it already has `dayKey`) and use it here. Optionally also compare the new text before writing it.

## Risks and what could break
A change of the time preferences (zone, 12/24 h, date order) in Settings changes every label. Today the next tick (within 60 s) relabels the rows. After the change, the rows would keep old labels until a redraw. Call the same relabel function from the `user` listener when `usePreferences` runs (`main.js:81`), or reset `labelledDay` there.

## How to measure it
Load 20 older pages (1,000 rows) on a phone and record a performance profile across two minutes. Look at the timer task at each minute mark.