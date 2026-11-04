---
id: client-render-06
title: Update only the reaction pills of a row when its reactions change
area: client-render
journey: send
category-guess: 1
behaviour-change: The row's pictures, emoji and GIF no longer flash or restart when someone reacts.
effort: M
estimated-gain: A reaction tap rebuilds the whole row twice (the local toggle, then the server's reactions event); every other person's reaction rebuilds it once. After the change only the pills are rebuilt. On WebKit this removes one request per emoji image of the row per rebuild; a GIF row no longer reloads and restarts its video. Exact ms unknown.
confidence: high
files: [Yap/wwwroot/js/store.js:217-222, Yap/wwwroot/js/store.js:240-250, Yap/wwwroot/js/ui/timeline.js:142-148, Yap/wwwroot/js/ui/timeline.js:94-101, Yap/wwwroot/js/ui/message.js:274-293]
---

## What the code does now
`setReactions` and `toggleReactionLocally` fire `changed('messages', { type: 'replace', message: m })` (`store.js:221`, `249`). The timeline answers every `replace` with `redraw(m, prev)` (`timeline.js:142-148`), which calls `renderRow` and swaps the whole node (`timeline.js:94-101`). `react()` toggles locally, then the server's `reactions` event arrives and sets them again (`message.js:288-293`).

## Why it costs the user time
A rebuilt row creates new `<img>` elements for its emoji, avatar and pictures, and a new `<video>` for a GIF (`message.js:174-200`). On the iPhone every new `<img>` is a request, answered a frame or two after the text (performance-notes, "Media"), so the row's emoji blink. A GIF video loads again with `preload: 'auto'` and restarts at frame 0. One tap does this twice. In a busy room, other people's reactions rebuild rows all the time. Who pays: everyone; most visible on phones and on GIF rows.

## The change
- In `store.js`, mark reaction changes: `changed('messages', { type: 'replace', message: m, part: 'reactions' })` in `setReactions` and `toggleReactionLocally`.
- In `message.js`, export `updateReactions(rowNode, m)`: find or create `.reactions-display` (the template removes it when empty, `message.js:276`, so create it with `el('div', { class: 'reactions-display' })` and insert it after `.message-cards` or `.message-content` inside `.message-body`), then run the body of `renderReactions` on it.
- In `timeline.js`, in the `replace` case: when `detail.part === 'reactions'` and the row is not in the editor, call `updateReactions(r.node, m)` and `keepPlace()`, and store `r.message = m`; otherwise redraw as today.

The same idea fits link previews (`setPreviews`, `store.js:224-229`): rebuild `.message-cards` only.

Related, smaller: the `older` and `remove` handlers redraw the neighbouring row unconditionally (`timeline.js:155`, `163`). A check `r.node.classList.contains('has-header') !== needsHeader(prev, m)` before the redraw skips a rebuild that changes nothing.

## Risks and what could break
The pill click handler closes over `rowNode` and `m`; `react()` looks the live row up by id for errors, so a kept node is fine. The `unchanged` check in `reset()` compares `r.message` with JSON, so `r.message` must be updated with the new object.

## How to measure it
Tap a reaction on a GIF row and on a text row with several emoji, on the iPhone. Watch the GIF restart and the emoji requests on the Settings debug card. In DevTools, count `renderRow` calls per reaction tap (2 today, 0 after).
