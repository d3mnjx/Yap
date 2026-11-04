---
id: client-core-20
title: Write the stored bootstrap and tail less often, and only when they changed
area: client-core
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Fewer structured clones of the whole bootstrap document on the main thread (the users directory plus the emoji image rules, "the largest part of the document"; size unknown, roughly 150 KB or more at 1,000 accounts). Today it is written twice per connect and again 2 s after every quiet moment following a presence or unread change, which on a busy server is every few seconds for the life of the page. The tail (50 rows) is also rewritten after every older page and after the device's own copy is shown. Gain unknown in ms; it lands on phones during scrolling and typing.
confidence: medium
files: [Yap/wwwroot/js/offline/snapshot.js:91, Yap/wwwroot/js/offline/snapshot.js:109-112, Yap/wwwroot/js/offline/snapshot.js:127-149, Yap/wwwroot/js/hub.js:124-129, Yap/wwwroot/js/main.js:148]
---

## What the code does now
The bootstrap is written whole (snapshot.js:91) from three places:

- `hub.js:128` after every connect's bootstrap: `saveBootstrap({ ...doc, emojiImages: store.state.emojiImages });`
- `main.js:148` after a first-load fetch.
- `queueBootstrap` (snapshot.js:142-145), which rebuilds the document from the store 2 s after the last change of any of nine parts (snapshot.js:149):

```js
for (const part of ['users', 'presence', 'rooms', 'dms', 'unread', 'mutes', 'emoji', 'favoriteGifIds', 'emojiImages']) on(part, queueBootstrap);
```

`applyBootstrap` fires all of these parts (store.js:48), so each connect writes the document at once (hub.js) and again 2 s later (the timer). The server batches presence and unread every 250 ms (ChatHubBroadcaster.cs:31), so a busy server keeps re-arming the timer and the document is cloned and written at every pause.

The tail (snapshot.js:129-133) is written 800 ms after any `messages` change, including `older` (the last 50 rows did not change) and the `reset` of the device's own copy (the rows just read from the disk).

`db.put` structured-clones the value synchronously in the calling task (the main thread).

## Why it costs the user time
Each write clones the whole directory and the emoji rules, which do not change between connects (the stamp says so). On a phone in a busy server this recurs every few seconds and sits on the same thread as scrolling and typing. Presence in the stored copy has little value: the stored copy paints for a moment, and the server's bootstrap replaces presence within one connect.

## The change
1. Drop `presence` from the parts that schedule a write (snapshot.js:149), and drop the timer write that follows a connect: skip `queueBootstrap` when `hub.js` has just saved (or simply remove the direct save in hub.js and let the 2 s timer write once).
2. Store `emojiImages` under its own key, written only when its `stamp` changes; `loadBootstrap` joins them. The frequent write then excludes the largest part.
3. In `queueTail`, skip the write when the detail is `older`, and when `state.open.fromDevice` is true (the rows came from the disk).
4. Optionally run the writes in `requestIdleCallback` (with a timeout), so they never land in a scroll frame.

## Risks and what could break
- An offline reload shows presence from the last write before the change; it already shows stale presence offline.
- A reaction or an edit on a tail row must still schedule the tail write (it fires `replace`, which stays).
- `loadBootstrap` must still return a document when the emoji record is missing (a copy from before the change), as it does today for copies before 2026-10-31.

## How to measure it
On a phone in the 1,000-user load-test server, record a performance profile for 60 s with the chat open: count `put` calls on the `snapshots` store and the main-thread time of the structured clones. Compare before and after.
