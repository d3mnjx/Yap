---
id: client-static-17
title: Remove the GIF spinner rules; their :has() matches every GIF row, so the spinner never shows
area: client-static
journey: all
category-guess: 1
behaviour-change: none (the spinner does not show today)
effort: S
estimated-gain: "Small: one :has() subject per GIF row, a pseudo-element style with an infinite animation per GIF row, and two load and error listeners per GIF media element that change nothing on screen."
confidence: high
files: [Yap/wwwroot/css/message.css:521-548, Yap/wwwroot/index.html:556-564, Yap/wwwroot/js/ui/message.js:174-195, Yap/wwwroot/css/README.md:127]
---

## What the code does now
- `message.css:525-539`: `.gif-message::after` is a 28 px spinner with `animation: spin 0.7s linear infinite, gif-spinner-in 0.01s linear 0.25s forwards`.
- `message.css:541-544`:
  ```css
  .gif-message.gif-loaded::after,
  .gif-message:has(.gif-message-missing)::after { display: none; }
  ```
- Template `t-gif` (`index.html:558`) always contains `<div class="gif-message-missing" hidden>`. `message.js:178-179` (`const missing = ...; if (!g.src) missing.hidden = false;`) only sets `missing.hidden = false` when there is no source; it never removes the element.
- So `:has(.gif-message-missing)` is true for every GIF row, and the spinner is `display: none` from the first frame.
- `message.js:184-185` still adds two listeners per GIF media to set `gif-loaded`, which changes nothing visible.

## Why it costs the user time
Every GIF row is a `:has()` subject the style engine re-checks when its subtree changes, and carries listeners and a pseudo-element rule that do nothing. The cost per row is small; GIF-heavy rooms have many such rows.

## The change
Keep today's behaviour and delete the dead parts: `message.css:521-548` (the `::after` spinner, its two hide rules, `@keyframes gif-spinner-in`) and the two `gif-loaded` listeners in `message.js:184-185`.
If a spinner is wanted instead, that is a category 3 change: the hide rule must test `.gif-message-missing:not([hidden])`, and then the infinite `spin` animation runs for every lazy GIF that has not loaded, rows far above the view included; it would need a stop for rows out of view.

## Risks and what could break
None for the deletion: nothing visible depends on these rules today.

## How to measure it
Not worth a measurement on its own. Check visually that GIF rows look the same.
