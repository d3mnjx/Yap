---
id: C2-25
title: Handle the row buttons with one delegated listener on the list
category: 2
journey: all
effort: M
confidence: low
behaviour-change: none
estimated-gain: Each row adds 3 to 4 click listeners with closures at draw (picker, reply, edit, more), plus one per reaction pill, one per gallery picture (two), one per GIF star, one per reply quote, and one error listener per emoji image. For 50 rows that is about 200 to 500 listeners and closures per draw, repeated at every redraw. One listener on the flow replaces most of them. Small per draw (a few ms on a phone, unknown), larger in long histories.
experiment: none
sources: [client-render-16]
files: [Yap/wwwroot/js/ui/message.js:335-364, Yap/wwwroot/js/ui/message.js:274-286, Yap/wwwroot/js/ui/message.js:138-157, Yap/wwwroot/js/render/text.js:91-96, Yap/wwwroot/js/render/dom.js:7-19]
---

## What the code does now
`renderActions` adds a listener to each bar button that exists (`message.js:349-363`). `renderReactions` adds one per pill (`message.js:283`). `imageGallery` adds `onclick` and `oncontextmenu` per picture (`message.js:146`). The reply quote adds one (`message.js:70`). `emojiImage` passes `onerror: imageFailed`, which `el()` turns into `addEventListener` for every emoji image (`text.js:95`, `dom.js:11`).

## Why it costs the user time
Listener registration and closure allocation are per row and per redraw. The project already moved the quick reactions out of the draw for the same reason (requests), and the timeline holds hundreds of rows. Who pays: long histories and phones; each redraw (client-render-04, -05, -06) pays again.

## The change
- One `click` listener on `flow` in `timeline.js` (or exported from `message.js`): find the button with `e.target.closest('[data-action]')` and the row with `closest('.message-group')`, look the message up in `rows` by the row id, and call the same functions (`openReactionPicker`, reply, `startEdit`, `openMore`, `react`, `openGallery`, `jumpTo`).
- Put `data-action` on the template buttons; reaction pills carry `data-emoji`; gallery items carry `data-index`.
- One capture-phase `error` listener on the flow for `img` (error does not bubble but capture works) replaces the per-image `onerror`.

## Risks and what could break
`e.stopPropagation()` calls in pills and stars (`message.js:193`, `283`) exist to keep the row's touch handling apart; the delegated handler must keep that order (the document-level touch logic in `message.js:514-533` runs in the capture phase, so it is not affected). Pending rows and the pins panel use the same functions with their own nodes.

## How to measure it
A performance profile of a 50-row reset on a phone; compare scripting time. Heap snapshot of a 1,000-row history: count of closures and event listeners.