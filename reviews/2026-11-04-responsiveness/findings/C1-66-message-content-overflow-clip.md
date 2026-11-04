---
id: C1-66
title: Use overflow-x clip on .message-content, so a row's text is not a scroll container
category: 1
journey: all
effort: S
confidence: low
behaviour-change: none expected (same horizontal clipping)
estimated-gain: "Unknown, needs measurement. One scroll container (with its scrollable area and paint layer) less per row: 50 rows at an open, hundreds to thousands after older pages."
experiment: none
sources: [client-static-11]
files: [Yap/wwwroot/css/message.css:372-383]
---

## What the code does now
`message.css:372-383`:
```css
.message-content {
    ...
    white-space: pre-wrap;
    max-width: 100%;
    overflow-x: hidden;
}
```
`overflow-y` is not set. By the CSS Overflow spec, when one axis is neither `visible` nor `clip`, a `visible` on the other axis computes to `auto`. So every row's `.message-content` computes to `overflow: hidden auto`: a scroll container. Its height is `auto`, so it never scrolls, but the engine still treats it as a scroller (a scrollable area, a paint layer, its own overflow bookkeeping at each layout).

## Why it costs the user time
Each row carries a scroll container nobody can scroll. The timeline keeps every loaded row (see client-static-14), so a long read back holds hundreds of them. Layout and pre-paint walk more state per row; touch and wheel input over rows meet nested scrollers before the list. The size of the effect is unknown. Who pays: phones, big histories.

## The change
`message.css:382`: `overflow-x: clip;`. `clip` clips the same way and does not make a scroll container, and `overflow-y` stays `visible`.
If the block formatting context of `hidden` matters (margins of block children inside the text), add `display: flow-root;` on the same rule.

## Risks and what could break
- `overflow: hidden` made the box a block formatting context; `clip` does not. If the text renderer emits block children with vertical margins, those margins could collapse through. `display: flow-root` restores the BFC without a scroller.
- `overflow-x: clip` needs Safari 16+.

## How to measure it
A phone with 500 rows loaded (scroll back ten pages): Performance trace of a scroll fling and of a rotation; compare "Layout" and "Pre-Paint" time and dropped frames, before and after. The Layers panel shows the per-row layers.