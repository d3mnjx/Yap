---
id: client-static-14
title: Cap the rows kept in the DOM; per-row content-visibility does not fit this row design
area: client-static
journey: older
category-guess: 2
behaviour-change: none for the reader if the dropped rows come back as pages when the reader scrolls back to them
effort: L
estimated-gain: "Unknown, needs measurement. Today a width change, a theme change or a Tea House scene change re-lays out or re-styles every loaded row; a reader 20 pages back holds about 1,000 rows (about 23,000 elements and 30,000 text nodes)."
confidence: low
files: [Yap/wwwroot/js/store.js:231-237, Yap/wwwroot/js/ui/timeline.js:45-71, Yap/wwwroot/css/message.css:208-215, Yap/wwwroot/css/message.css:743-758, Yap/wwwroot/app.css:181-194, Yap/wwwroot/css/pickers.css:274-280]
---

## What the code does now
- `prependOlder` (`store.js:231-237`) adds each older page of 50 to `state.open.messages`; nothing removes rows until a reset of the conversation (`timeline.js:45-71`). A long read back keeps every row in the DOM.
- A drawn row with a header is about 23 elements plus about 30 indentation text nodes (client-static-12, client-static-13).
- The obvious cheap fix, `content-visibility: auto` on `.message-group`, conflicts with the row design. `content-visibility: auto` always applies paint containment and layout containment, also on screen:
  - Paint containment clips to the row box. The hover bar sits outside it: `.message-actions { position: absolute; top: -16px; ... }` (`message.css:743-746`).
  - Layout containment makes the row the containing block of `position: fixed` descendants. The menus and pickers rendered inside rows are fixed boxes (`app.css:181-189` describes them inside `.messages-flow`).
- The same blocker stops `contain: strict` on the `.messages` scroller, which would make the list a relayout boundary: layout containment there would also capture the fixed menus and pickers inside rows.
- The emoji picker already uses `content-visibility: auto` on its sections (`pickers.css:274-280`), where nothing overhangs.

## Why it costs the user time
Every loaded row takes part in each full re-layout and re-style: a phone rotation, a desktop resize or the 768 px sidebar breakpoint (width changes re-flow all text), a theme switch, the Tea House scene change (custom properties on the root re-style every element), a text-size change. The cost grows with the session. Who pays: readers of long histories (the 50,000-message user), phones.

## The change
Two options, both L:
1. A cap in `timeline.js`: above N rows (for example 300), when the reader is far from one end, remove rows at the far end and fetch them again as pages when the reader returns. The `older` path exists; a `newer` path from a cut point does not.
2. Move the hover bar out of the row (one bar on the list, placed over the hovered or tapped row) and keep the menus outside rows. Then `content-visibility: auto; contain-intrinsic-size: auto 48px` on `.message-group` becomes possible, with the scroll-anchoring checks of TL-06.

## Risks and what could break
Scroll anchoring and the follow rule (TL-06, TL-10) are sensitive (the CLS 1.24 history in `app.css:202-207`). Intrinsic-size estimates move the scrollbar until rows render. Find in page cannot see removed rows (option 1).

## How to measure it
Phone, 1,000 rows loaded: Performance trace of a rotation, a sidebar toggle at the 768 px tier and a theme switch; "Recalculate Style" and "Layout" times. Repeat with 50 rows for the baseline.
