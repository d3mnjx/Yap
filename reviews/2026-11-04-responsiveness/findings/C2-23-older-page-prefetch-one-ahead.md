---
id: C2-23
title: Fetch the next older page as soon as the previous one lands, and keep it in memory
category: 2
journey: older
effort: M
confidence: medium
behaviour-change: none
estimated-gain: The older page is requested when the reader is two screens from the top (TL-06). A fling covers two phone screens in well under a second, so the far reader waits about one round trip (900 ms) plus the still-view wait at the top for most pages. With one page always fetched ahead, the page lands as soon as the view is still. Gain about one round trip per page for fast readers; costs one extra page request per conversation for readers who stop.
experiment: none
sources: [client-render-13]
files: [Yap/wwwroot/js/ui/timeline.js:238-257, Yap/wwwroot/js/ui/timeline.js:285-301]
---

## What the code does now
`loadOlder` runs from the scroll handler when `nearTop(up)` is true (`timeline.js:293`, `301`): within two screen heights of the top while scrolling up, else within 100 px. It then calls `hub.invoke('older', ...)` and waits for the answer (`timeline.js:246`), then waits for a still view (`timeline.js:250`), then prepends.

## Why it costs the user time
Fifty rows are about four to six phone screens. A reader who scrolls up with a fling reaches the top of the loaded rows in about a second. The request starts only two screens before the top, so the round trip of the far user (about 900 ms) is mostly visible as the "Loading older messages..." pill. Each page repeats the wait. Who pays: far users reading back, 50,000-message histories.

## The change
After a page lands (end of `loadOlder`), when `open.hasMore`, start the next `older` request at once and keep its promise in a variable (`ahead = { oldestId, promise }`). In `loadOlder`, when `ahead` matches the current oldest row, await that promise instead of a new invoke. `reset()` clears `ahead` (it already bumps `loadToken`). Do not prefetch on the first open (the reader may never scroll): start the chain only after the first page that the reader asked for.

## Risks and what could break
One page fetched that may never be shown; the server's `older` reads memory only, so the cost is the wire. The token logic (`loadToken`, `state.open !== open`) must also guard the prefetched answer. The still-view rule (TL-06) is unchanged: the rows still land only when the view is still.

## How to measure it
The `older` wait of AD-26 (`hub.report('older', ...)`) measures fetch plus placing; add the time the reader waited at the top (from `loading = true` to the prepend). Far link, a long room, fling up five pages.