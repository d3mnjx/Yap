---
id: client-core-09
title: Show the confirmed own row before the outbox row is deleted from IndexedDB
area: client-core
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One IndexedDB read-write transaction commit (with the browser's default durability) leaves the path from the POST answer to the confirmed row, and the gap between two queued posts. A few ms to tens of ms on a phone; more where the browser flushes to disk on commit. Unknown, needs measurement.
confidence: high
files: [Yap/wwwroot/js/sender.js:111-125, Yap/wwwroot/js/offline/outbox.js:61-63, Yap/wwwroot/js/offline/db.js:27-44]
---

## What the code does now
After the POST answer, `flush()` waits for the disk before it confirms (sender.js:120-125):

```js
queue = queue.filter(r => r !== row);
await outbox.remove(row);
outbox.announce();
addMessage(message);                 // the POST answer and the hub event are the same confirmation
if (row.tappedAt) hub.report('send', performance.now() - row.tappedAt);
publish();
```

`outbox.remove` is `db.del` (outbox.js:62), a `readwrite` transaction that resolves on `tx.oncomplete` (db.js:34). The loop then takes the next queued row only after this.

## Why it costs the user time
The person sees the faded pending row until `addMessage` runs (or until the hub's `message` event comes, whichever is first). The disk delete has no bearing on what the screen shows: the row is already out of the in-memory queue. With several rows queued while offline, every POST after the first also waits for the previous row's commit. The `send` wait of AD-26 includes the commit, so the telemetry over-reports the wire.

## The change
Confirm first, then let the delete run in the background, and announce after it:

```js
queue = queue.filter(r => r !== row);
addMessage(message);
if (row.tappedAt) hub.report('send', performance.now() - row.tappedAt);
publish();
outbox.remove(row).then(() => outbox.announce());
```

## Risks and what could break
- If the tab closes between the confirmation and the commit, the next open finds the row on disk and posts it again. The server's clientId dedupe (memory-first-data-layer, one day) answers with the stored message, so no duplicate appears. This is the same window as today between the POST answer and the commit.
- Another tab learns of the change only after the commit, as today.

## How to measure it
Journey send on a phone: the `send` wait (AD-26) and a performance mark at `addMessage`. Queue five messages offline, go online, and time the five confirmations.
