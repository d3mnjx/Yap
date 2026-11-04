---
id: client-static-18
title: Replace the two per-row :has() rules with classes the renderer already knows
area: client-static
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: "Unknown, likely small: every avatar and, on phones, every row stops being a :has() subject that the style engine re-checks when its subtree changes (emoji images, reaction pills, cards inserted into rows)."
confidence: low
files: [Yap/wwwroot/css/frame.css:50-52, Yap/wwwroot/js/render/avatar.js:24-37, Yap/wwwroot/css/message.css:1304-1310, Yap/wwwroot/js/ui/message.js:52-91, Yap/wwwroot/js/ui/message.js:110]
---

## What the code does now
- `frame.css:50-52`: `.avatar:has(.avatar-initials) { box-shadow: 0 0 0 1px white; }`. Every avatar (one per row with a header, one per reply quote, the people list, the profile card) is a `:has()` subject. `avatar.js:31-35` already knows the answer: it removes the initials when a picture exists and removes the picture otherwise.
- `message.css:1307-1310` (inside `@media (max-width: 600px)`): `.message-group:has(.voice-message) .message-actions { top: auto; bottom: 100%; }`. On a phone every row is a `:has()` subject. `renderRow` (`message.js:52-91`) knows when it draws a voice player.
- Elsewhere `:has()` is used on single elements (the composer, the gallery viewer), which is fine.

## Why it costs the user time
A `:has()` subject is re-matched when a mutation inside it could change the answer. Rows get mutations after the draw (emoji images, reactions, link cards, edits). The cost per check is small; the count of subjects grows with the rows. Who pays: phones, long sessions.

## The change
- `avatar.js`, in the `else` branch: `node.classList.add('avatar-letter')`. `frame.css:50`: `.avatar.avatar-letter { box-shadow: 0 0 0 1px white; }`.
- `message.js:110`, where the voice player is appended (`if (m.voice) content.append(voicePlayer(...))`): add `has-voice` to the row. `message.css:1307`: `.message-group.has-voice .message-actions { ... }`.

## Risks and what could break
The class must survive redraws. A row is redrawn as a whole (`renderRow`), so the class comes with it.

## How to measure it
Phone, 500 rows: Performance trace of an older-page prepend and of a reaction toggle; "Recalculate Style" time, before and after.
