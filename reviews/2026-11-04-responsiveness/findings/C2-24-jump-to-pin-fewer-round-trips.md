---
id: C2-24
title: Load the rows up to a jumped-to message in one call, not one page per round trip
category: 2
journey: older
effort: M
confidence: medium
behaviour-change: none
estimated-gain: A jump to a pinned message or a reply quote k pages back costs k round trips plus 50 ms each (k up to 20). For the far user and k = 5 that is about 4.75 s. With one call that returns every row from the target to the oldest loaded row (capped), it is one round trip, about 0.9 s plus the transfer.
experiment: none
sources: [client-render-14]
files: [Yap/wwwroot/js/ui/timeline.js:483-503, Yap/Endpoints/ChatHub.cs:102-104]
---

## What the code does now
```js
async function jumpTo(id) {
  for (let tries = 0; tries < 20 && !rows.has(id) && state.open?.hasMore; tries++) {
    await loadOlder();
    await new Promise(r => setTimeout(r, 50));
  }
```
(`timeline.js:484-488`). Each `loadOlder` is one `older` hub call for 50 rows (`ChatHub.cs:26`, `102-104`), then a still-view wait, then the prepend. The calls run one after another.

## Why it costs the user time
A pin or a reply quote often points far back. Every page is a round trip on the critical path of the tap; the pins panel shows "jumping" the whole time (SH-49). Who pays: far users, long histories.

## The change
Two options, the first is smaller:
1. Add a `limit` argument to the `older` hub method (server reader's area), capped on the server (for example 500). `jumpTo` asks once with a high limit and stops when `rows.has(id)`. The pins entry knows the target timestamp (`p.timestamp` in `pins.js:35`), so the client can also pass "until this timestamp" and the server returns exactly the rows needed.
2. Keep the API and only drop the 50 ms sleep: it waits for nothing that the still-view check does not already handle.

The rows still arrive contiguous, so the loaded history keeps its rule (older pages start at the oldest loaded row).

## Risks and what could break
A big prepend (hundreds of rows) is one long task on a phone; cap the count. The still-view placement and the scroll compensation work for any count (`timeline.js:158-173`).

## How to measure it
Pin a message 300 rows back, open the panel on the far link, tap the entry. Time from tap to highlight.