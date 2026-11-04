---
id: client-static-19
title: Collapse the send and GIF buttons without animating width, flex-basis and margin
area: client-static
journey: send
category-guess: 3
behaviour-change: the draft field takes its new width at once instead of sliding over 150 ms; the buttons still scale in and out
effort: S
estimated-gain: "Unknown, needs measurement on a phone: about 9 frames of composer re-layout and draft re-wrap at the first key press of every draft and after every send."
confidence: low
files: [Yap/wwwroot/css/composer.css:225-245, Yap/wwwroot/css/composer.css:264-281, Yap/wwwroot/css/composer.css:403-426]
---

## What the code does now
- `.send-button` (`composer.css:242-244`): `transition: background-color 0.2s, opacity 0.2s, flex-basis 0.15s ease, width 0.15s ease, margin-left 0.15s ease, transform 0.15s ease;`.
- `composer.css:268-273`: while the box is empty the button gets `flex-basis: 0; width: 0; margin-left: 0; transform: scale(0)`. The first key press of a draft, and the reset after each send, flip it.
- `.gif-toggle-button` (`:416`) transitions `flex-basis` and `width` the same way when the draft becomes non-empty (`:422-426`); on phones it is hidden (`:678-680`).

## Why it costs the user time
Width, flex-basis and margin are layout properties. For 150 ms the browser re-lays out the input row in each frame, and the textarea between the buttons changes width, so the draft text re-wraps in each frame. This happens at the first key press, the moment the user is typing, and right after a send. On a fast desktop it is invisible; on a slow phone it can cost frames during input. Who pays: phones.

## The change
Keep the motion on the compositor: drop `flex-basis`, `width` and `margin-left` from both transition lists (`:242-244`, `:416`), keep `transform` and `opacity`. The space then changes in one step and the button scales.

## Risks and what could break
Visual: the slide becomes a jump plus a scale. The `.click()` target of the Enter handler stays (the button keeps existing).

## How to measure it
Phone, Performance trace with screenshots: the first key press in an empty draft; layout time per frame for 150 ms and the input delay of the next key presses (INP).
