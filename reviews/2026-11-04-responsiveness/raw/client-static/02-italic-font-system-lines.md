---
id: client-static-02
title: Do not download the 388 KB italic font for the grey system lines
area: client-static
journey: cold-open
category-guess: 3
behaviour-change: system lines (joins, leaves, pins, the DM start line) show in upright or synthetic-oblique Inter instead of the true Inter Italic design
effort: S
estimated-gain: "387,976 B not fetched on the first visit that shows a system line: about 3.1 s of a 1 Mbit/s link that today competes with the rows, avatars and emoji of that visit, plus no swap re-layout of those lines. Each device pays once (immutable for a year in the HTTP cache)."
confidence: medium
files: [Yap/wwwroot/app.css:14-20, Yap/wwwroot/css/message.css:408-416, Yap/wwwroot/index.html:389-396, Yap/wwwroot/js/ui/timeline.js:463-467, Yap/wwwroot/css/frame.css:1153-1161, Yap/Endpoints/ShellAssets.cs:26-29]
---

## What the code does now
- `app.css:14-20` declares a second face, `InterVariable-Italic.woff2`, 387,976 B, `font-display: swap`.
- The browser fetches it the first time any element with `font-style: italic` and the Inter family is laid out. The CSS has 10 such rules. The one in the timeline is `message.css:408-416`:
  ```css
  .system-message .message-content { ... font-style: italic; font-size: 0.8125rem; ... }
  ```
- System lines are common on a first screen: the lobby join and leave lines (`timeline.js:463-467`, MR-73), stored pin lines (MR-80), and "This is the beginning of your direct message history" in every DM (`index.html:389-391`, template `t-dm-start`).
- The worker does not precache the italic file (`ShellAssets.cs:26-29`: "The regular font only"). It keeps it from first use in the per-build shell cache.
- No renderer emits `<em>` or `<i>` for message text (no match in `render/text.js`).

## Why it costs the user time
A first visit to the lobby downloads 388 KB for a few small grey lines, in the same seconds as the rows, avatars and emoji images. At 1 Mbit/s that is about 3.1 s of link time. With `swap` the lines first paint in Helvetica Italic, then re-lay out when Inter Italic arrives. Who pays: first visits on every device; far users most.

## The change
Two options, both a visual decision for the user:
1. Drop `font-style: italic` from `.system-message .message-content` (`message.css:411`). The italic face then loads only for the rare places left (profile card "empty" text, a few settings and admin labels).
2. Delete the italic `@font-face` (`app.css:14-20`). The browser synthesises an oblique from the regular Inter for all 10 rules (`font-synthesis` default), and the 388 KB file is never fetched.

This does not subset the font, so it stays within the "the font stays as it is" decision of performance-notes.md for the regular face.

## Risks and what could break
Visual only. A synthetic oblique is not identical to Inter Italic. Option 1 changes the look of system lines.

## How to measure it
Throttled first visit to the lobby (`npm run load`, cold): resource timing of `InterVariable-Italic.woff2` (start and end) against the `rows` phase; `layout-shift` entries on `.system-message` rows.
