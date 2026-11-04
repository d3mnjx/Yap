---
id: client-core-10
title: Do not redraw the own row when its second confirmation carries the same message
area: client-core
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One row rebuild per own send (the row's DOM, its avatar, its inline emoji; on WebKit every emoji `<img>` element is a request to the worker, see static-asset-caching). Small per send, on the main thread right after the send.
confidence: high
files: [Yap/wwwroot/js/store.js:181-203, Yap/wwwroot/js/sender.js:120-123, Yap/wwwroot/js/hub.js:39]
---

## What the code does now
An own message is confirmed twice: by the POST answer (sender.js:123, `addMessage(message)`) and by the hub's `message` event (hub.js:39, `store.addMessage(m)`). Whichever comes second finds the row and replaces it (store.js:189):

```js
if (openMessage(m.id)) { replaceMessage(m); return; }        // the POST answer and the hub event are the same confirmation
```

`replaceMessage` (store.js:196-203) always fires `changed('messages', { type: 'replace', message: m })`, and the timeline rebuilds that row.

## Why it costs the user time
The second copy is, in the normal case, the same message (same text, no reactions or previews yet). The rebuild costs main-thread time at the moment the person may type the next message, and on an iPhone it re-requests the row's emoji images. Every sender pays it on every send.

## The change
In `addMessage`, replace only when the copy differs:

```js
const known = openMessage(m.id);
if (known) { if (JSON.stringify(known) !== JSON.stringify(m)) replaceMessage(m); return; }
```

The timeline's `unchanged` check in `reset()` uses the same idea (same JSON).

## Risks and what could break
- The server's two copies may differ in key order or in a field the POST answer fills differently from the hub mapping; then the replace runs as today (correct, only not faster).
- A preview that arrives later still comes through `setPreviews`, which is unaffected.

## How to measure it
Journey send: count the `messages` `replace` notifications per own send (one today, zero after) and the row's render time in a performance profile on a phone.
