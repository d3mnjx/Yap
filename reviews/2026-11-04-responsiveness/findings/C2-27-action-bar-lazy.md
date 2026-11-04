---
id: C2-27
title: Build the hover bar's buttons when the bar first shows, like the quick reactions
category: 2
journey: all
effort: M
confidence: medium
behaviour-change: none, if keyboard focus keeps a way into the bar
estimated-gain: "About half or more of every drawn row's elements (12 of 23 for another person's text row with a header, 12 of 17 for a continuation row, 15 of 26 for an own row), 2 to 3 click listeners and one stacking context with a box-shadow, at every draw: 50 rows at an open (up to two draws), 50 per older page. Unknown ms; likely a few ms per open on a phone, and less memory per row."
experiment: none
sources: [client-static-12]
files: [Yap/wwwroot/index.html:438-456, Yap/wwwroot/css/message.css:743-771, Yap/wwwroot/js/ui/message.js:324-364, Yap/wwwroot/js/ui/message.js:525-528]
---

## What the code does now
- Template `t-message` (`index.html:412-458`) has 39 elements. The bar `.message-actions` (`:438-456`) is 18 of them: the bar, the quick-reactions slot, a divider and five buttons with an `<svg>` and a `<path>` each.
- `renderActions` (`message.js:336-364`) removes the buttons a row does not use and wires the rest: Add Reaction and Reply always (unless pending), More for most rows, Edit for own text rows. A typical row keeps 12 to 15 bar elements and 2 to 3 listeners. Counted from the code: a row with a header keeps 11 elements outside the bar (row, avatar div and img or initials, body, meta, name, bot badge, time, content, cards, reactions); a continuation row keeps 5.
- The bar is `position: absolute; z-index: 100; box-shadow: ...; opacity: 0; pointer-events: none` (`message.css:743-758`): laid out in every row, a stacking context in every row, invisible until hover, tap or focus.
- The three quick reactions are already built lazily (`fillQuick`, `message.js:324-333`), triggered by `pointerover`, `focusin` (`:527-528`) and `showTouched`.

## Why it costs the user time
A drawn text row with a header keeps 23 elements; the bar is 12 of them. A continuation row keeps 17; the bar is 12 of them. Every row draw clones, wires and lays out a bar that most rows never show. Who pays: everyone; phones and long sessions most.

## The change
Extend the existing filler: `renderActions` keeps only an empty `.message-actions` in the row and registers the button building in the same `quickFillers` entry that `fillQuick` already runs on first show. The template's bar buttons move to a template of their own (`t-message-actions`).
Keyboard: today `focusin` on a bar button is what triggers `fillQuick`. With lazy buttons a row has no focusable child until the bar exists, so the row needs `tabindex="0"` (or one always-present button) for keyboard users to reach the bar. That is the design part of this change.

## Risks and what could break
- Keyboard access to the bar (see above).
- `redrawStars` looks for `.action-gif-fav[data-entry]`; stars built later must be drawn with the current state at build time (`drawStar` already reads the store).
- Code that queries bar buttons before the first show (none found in `message.js`, check `timeline.js` and `overlays.js`).

## How to measure it
Phone, warm open of a 50-row room: Performance trace of the reset (scripting plus "Recalculate Style" plus "Layout"), and the DOM node count (`document.getElementsByTagName('*').length`) after the open, before and after.