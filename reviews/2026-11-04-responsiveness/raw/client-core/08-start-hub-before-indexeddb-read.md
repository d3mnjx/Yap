---
id: client-core-08
title: Start the hub connect before the stored bootstrap is read
area: client-core
journey: warm-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The socket opens earlier by the time of the database open plus the bootstrap read plus `applyBootstrap`'s listeners, and the server's rows land earlier by the same amount. On a cold launch of the installed app on iOS the first IndexedDB open may take tens of ms or more; unknown, needs measurement.
confidence: low
files: [Yap/wwwroot/js/main.js:72-82, Yap/wwwroot/js/main.js:143-160, Yap/wwwroot/js/hub.js:96-101]
---

## What the code does now
`main.js:143-152`:

```js
let doc = await snapshot.loadBootstrap();
...
if (doc?.user) {
  applyBootstrap(doc);
  hub.connect();
}
```

The socket opens only after the IndexedDB open, the read of the stored document (a structured-clone read of the whole bootstrap, users directory and emoji rules included) and the synchronous listeners of `applyBootstrap` (the `user` listener writes localStorage and calls `getComputedStyle`, main.js:72-82).

## Why it costs the user time
The socket needs only the cookie and the device id. Its set-up is the longest chain of the warm open (connection set-up, upgrade, handshake, `openRoom`), so any delay before its start moves the server's rows by the same amount. The read is needed for the paint, not for the socket.

## The change
Keep a small signed-in hint in localStorage, written by the existing `on('user')` listener in main.js (set when `state.user` exists, removed when the store resets it to null). At the top of `start()`, when the hint is there, call `hub.connect()` before `await snapshot.loadBootstrap()`. Then apply the stored document only when the hub's own bootstrap has not landed yet:

```js
if (doc?.user && !hub.synced()) applyBootstrap(doc);
```

At minimum, call `hub.connect()` before `applyBootstrap(doc)` so the listeners do not delay the socket.

## Risks and what could break
- A stale hint with a dead cookie: the direct socket fails, the negotiated one gets 401, and `signedOut()` runs. That is what happens today with a stored copy and a dead cookie, only earlier.
- The race where the server's bootstrap lands before the stored one is read is guarded by `hub.synced()`; without the guard an old document would overwrite a new one.
- The hint is one more piece of state to clear at sign-out (GEN-05); the existing `user` listener sees the reset.

## How to measure it
Warm open of the installed app on an iPhone after it was evicted (a cold launch). Add a mark after `loadBootstrap` and compare it with the `socket` mark of the boot report; the gain is the read's duration.
