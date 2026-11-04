---
id: C1-43
title: Compute today's and yesterday's day keys once per draw, not per row
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: messageTime does up to 7 Intl calls per header row; 4 of them are the same for every row of a draw (today, yesterday, this year). A sandbox V8 check gave about 19 µs per call (desktop). For 50 rows with about 30 headers that is under a millisecond on desktop and a few ms on a phone; for an older page or a pins panel the same. Small, but free.
experiment: none
sources: [client-render-09]
files: [Yap/wwwroot/js/render/time.js:76-102]
---

## What the code does now
```js
export function messageTime(iso, now = new Date()) {
  const date = new Date(iso);
  const time = timeOf(date);
  const today = dayKey(now);
  const key = dayKey(date);
  if (key === today) return time;
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return `Yesterday ${time}`;
  const sameYear = partsOf(date).year === partsOf(now).year;
  return `${dateOf(date, !sameYear)} ${time}`;
}
```
(`time.js:93-102`). `dayKey` and `partsOf` each call `formatToParts` on a cached formatter (`time.js:76-90`). For a message older than yesterday the call makes one `format` and six `formatToParts`: `now` twice, yesterday once, `date` three times.

## Why it costs the user time
The `now` parts are the same for every row of one draw. `formatToParts` allocates an array of part objects per call. The cost is small per row but sits in every row draw and in the minute timer (client-render-08).

## The change
Cache the keys of `now` by the minute inside `time.js`:

```js
let nowCache = { minute: -1 };
function nowKeys() {
  const minute = Math.floor(Date.now() / 60_000);
  if (nowCache.minute !== minute) {
    const now = new Date();
    nowCache = { minute, today: dayKey(now), yesterday: dayKey(new Date(now.getTime() - 86_400_000)), year: partsOf(now).year };
  }
  return nowCache;
}
```

Use it when the caller passes no `now`. Compute `partsOf(date)` once and reuse it for `dayKey(date)`, the year and `dateOf`. Clear `nowCache` in `usePreferences`.

## Risks and what could break
A label at the exact minute of midnight can lag by up to a minute, the same as the timer today. Callers that pass `now` keep the old path.

## How to measure it
A micro-benchmark of 1,000 calls on a phone (a published test page, as for the randomUUID question), before and after.