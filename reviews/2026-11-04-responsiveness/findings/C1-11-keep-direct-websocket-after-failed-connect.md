---
id: C1-11
title: Try the direct WebSocket again after a connect where both attempts failed
category: 1
journey: resume
effort: S
confidence: high
behaviour-change: none
estimated-gain: One round trip (the negotiate POST, about 900 ms for the far user) on every later connect of the page, after any connect attempt that failed for a reason other than the transport (a server restart at a deploy, a dead network at boot, a 401). An installed app lives for days and reconnects at every resume, so the cost repeats many times.
experiment: E10
sources: [client-core-01]
files: [Yap/wwwroot/js/hub.js:26-38, Yap/wwwroot/js/hub.js:96-110, Yap/wwwroot/js/hub.js:207-215]
---

## What the code does now
`hub.js:30` keeps one flag for the life of the page:

```js
let negotiate = false;
let connection = build();
```

`build()` (hub.js:33-38) skips the negotiate step only while the flag is false:
`negotiate ? {} : { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets }`.

When `connection.start()` throws, the catch (hub.js:102-110) switches the flag on and never back:

```js
if (!negotiate) { negotiate = true; connection = build(); connect(); return; }
if (!everConnected) settleFirst();
store.setConnectionFailed(true);
store.setConnection(...); scheduleRetry(); return;
```

Nothing in the file sets `negotiate = false` again. `restart()` (hub.js:207-215) and `resume()` (hub.js:233) keep it.

## Why it costs the user time
The flag answers "does this network block WebSockets?". But the catch also runs when the server is down (a deploy restarts Kestrel), when the phone has no usable network at the moment of the attempt, and when the cookie is dead. In all three cases the negotiated attempt fails too, and the flag stays on. From then on, every connect of this page sends `POST /hub/negotiate` first and opens the socket after its answer: one more round trip before the handshake, before `openRoom`, before the server's rows.

Who pays: every client that was connected during a server restart (all of them, at every deploy), and every client whose first attempt failed on a bad network. The installed app keeps the page alive across many resumes, so the far user pays about 900 ms at each resume until a reload.

## The change
In `hub.js` `connect()`, in the catch, after the negotiated attempt also failed and the error is not a 401, set the flag back and rebuild:

```js
if (!negotiate) { negotiate = true; connection = build(); connect(); return; }
// Both ways failed: the server or the network is down, not the transport. The next try goes direct again.
negotiate = false; connection = build();
```

Optionally also reset the flag in `restart()` (a resume after a long background is a new network situation). A proxy that really blocks WebSockets still works: the direct attempt fails, the negotiated one succeeds, and the flag stays on because the negotiated attempt did not fail.

## Risks and what could break
- A network that blocks WebSockets and is also flaky pays one failed direct attempt more after each double failure. A blocked upgrade usually fails fast.
- `connection = build()` in the catch creates a new HubConnection object; `onClose` already ignores a replaced connection (hub.js:141).
- The 401 path must keep its early `signedOut()` return.

## How to measure it
Journey resume, far link. Restart the server while a page is open, wait for the reconnect, then hide the page for more than 30 s and return. Before: the network panel shows `/hub/negotiate` before the WebSocket on each later connect. After: only the WebSocket. The admin Sessions table (AD-25) and the `reconnect` wait (AD-26) show the round trip less.