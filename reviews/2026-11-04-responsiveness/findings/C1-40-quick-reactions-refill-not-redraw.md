---
id: C1-40
title: Refill the quick reaction buttons instead of redrawing every row when they change
category: 1
journey: send
effort: S
confidence: high
behaviour-change: none
estimated-gain: A change of the three quick reactions now redraws every loaded row (every emoji image requested again on WebKit, every GIF video recreated). After the change only the bars that were already shown get new buttons; rows not yet hovered do nothing. The quick reactions follow the person's most used reaction emoji, so they can change after any reaction.
experiment: none
sources: [client-render-05]
files: [Yap/wwwroot/js/ui/timeline.js:113-119, Yap/wwwroot/js/ui/timeline.js:514, Yap/wwwroot/js/ui/message.js:323-348, Yap/Services/Chat/ChatService.cs:872-881, Yap/Endpoints/ChatHubBroadcaster.cs:72]
---

## What the code does now
`state.emoji.quickReactions` is part of `rowFacts` (`timeline.js:113`). An `emoji` change with new quick reactions triggers `redrawAll()`. The server sends `me` with `{ emoji: { recent, quickReactions } }` after every recorded emoji use (`ChatHubBroadcaster.cs:72`). `QuickReactions` returns the person's three most used reaction emoji, padded with the defaults (`ChatService.cs:872-881`), so a reaction can reorder them.

Since 2026-10-31 the quick reaction buttons are built only when a bar first shows (`fillQuick`, `message.js:327-348`). A row whose bar never showed has no buttons yet; its filler reads `state.emoji?.quickReactions` when it runs (`message.js:341`).

## Why it costs the user time
The rows themselves do not show the quick reactions. Only the hidden action bar does, and most bars are not built. A full redraw for them throws away and rebuilds every row: on WebKit every emoji `<img>` is a new request, every GIF `<video>` reloads and restarts. Who pays: people who react often in a long loaded history, most on phones.

## The change
- Remove `state.emoji?.quickReactions` from `rowFacts`.
- Export a function from `message.js`, for example `refreshQuick()`: for every row node not in `quickFillers` (its bar was built), empty `.quick-reactions` and run the same fill again. Rows still in `quickFillers` need nothing, because the filler reads the store when it runs. A `WeakSet` or a `data-quick` attribute marks the filled rows, so the function can find them with one `querySelectorAll('.message-group[data-quick]')`.
- In `timeline.js`, call it on `emoji` when the quick reactions changed (compare with the last value).

About 15 lines.

## Risks and what could break
The click handler of a quick button closes over `m` and `rowNode`; the refill must build it the same way (move the fill body into a named function used by both paths). A row with an open picker or menu keeps its bar state; only the buttons change.

## How to measure it
React with a new emoji several times until the top three change, in a conversation with 200+ loaded rows. Count `renderRow` calls (a breakpoint or a counter) and the emoji requests on the iPhone debug card.