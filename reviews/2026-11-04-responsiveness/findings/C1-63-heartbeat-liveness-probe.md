---
id: C1-63
title: Treat an unanswered heartbeat as a dead socket, and bound a hanging connect
category: 1
journey: resume
effort: S
confidence: medium
behaviour-change: none
estimated-gain: A dead socket that the browser does not report (a network switch from Wi-Fi to mobile data, a short background on iOS, a NAT that dropped the mapping) is replaced after about 10 to 15 s instead of up to 30 s of SignalR's server timeout. During that window no message, typing or presence arrives. A connect that hangs on a black-holed network is retried after a bound instead of waiting for the browser's own TCP timeout. How often this happens is unknown.
experiment: none
sources: [client-core-06]
files: [Yap/wwwroot/js/hub.js:72, Yap/wwwroot/js/hub.js:96-110, Yap/wwwroot/js/hub.js:188-200, Yap/wwwroot/js/hub.js:306-321, Yap/wwwroot/js/hub.js:336-339]
---

## What the code does now
The client keeps SignalR's timeouts (hub.js:72, `SERVER_TIMEOUT_MS = 30_000`, "nothing overrides it"); the builder (hub.js:34-38) sets no `withServerTimeout` and no `withKeepAliveInterval`. The heartbeat (hub.js:306-316) awaits an invoke with no time limit:

```js
try {
  await connection.invoke('heartbeat', visible, idleSeconds(), lastRttMs, batch.length ? batch : null);
  lastRttMs = visible ? Math.round(performance.now() - started) : null;
} catch { /* the connection is going down; onclose follows */ }
```

It runs every 10 s while visible (hub.js:318-321) and at every visibility change (hub.js:336-339). The long-background rule restarts the connection only after more than 30 s hidden (hub.js:196-198). `connect()` awaits `connection.start()` with no bound (hub.js:101); with `skipNegotiation` the WebSocket open has no SignalR timeout of its own (the 15 s handshake timeout starts after the socket opens).

## Why it costs the user time
An invoke on a dead socket never answers and never fails; it waits until the client's server timeout closes the connection, up to 30 s after the last frame from the server. The `offline` event (hub.js:182-187) catches only a network the browser knows is gone. A phone that changes network while visible, or that returns from a background shorter than 30 s with a killed socket, shows old rows and no typing for up to 30 s, then the reconnect costs its round trips on top. A WebSocket open into a black hole (captive Wi-Fi, a dead route) can hang for the browser's TCP timeout while `connection.state` stays `Connecting`, so `reconnectNow()` and the visibility handler do nothing.

## The change
In `beat()`: race the invoke against a timer. When no answer comes within `max(5000, 4 * lastRttMs)` ms while the page is visible, call `restart()` (the same fresh connection object the long-background rule uses). In `connect()`: race `connection.start()` against a bound (for example 15 s plus 4 round trips); on the bound, drop that connection object the way `restart()` does and schedule the retry.

Keep the server timeout as is; the probe only shortens the wait for a visible page.

## Risks and what could break
- A very slow but alive link (a congested upload) could miss the bound and pay a needless reconnect (about 4 round trips). The bound uses the measured round trip to avoid that.
- `restart()` must not run while `stopped` (signed out) or while a connect is in flight.
- The heartbeat's RTT sample must not be taken from a raced timeout.

## How to measure it
Journey resume and a live network switch on a real phone: toggle Wi-Fi off while the page is visible and mobile data is on. Measure the time until the dot turns amber and until a message sent from another device appears. Before: up to 30 s plus the reconnect. After: about 10 to 15 s plus the reconnect. The `reconnect` wait (AD-26) records it.