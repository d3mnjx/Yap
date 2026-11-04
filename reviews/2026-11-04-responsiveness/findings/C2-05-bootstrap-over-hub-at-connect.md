---
id: C2-05
title: Send the connect bootstrap over the hub instead of a separate HTTP request
category: 2
journey: resume
effort: L
confidence: low
behaviour-change: none
estimated-gain: One HTTP request less per connect. After a long background the HTTP/2 connection is often gone, and the bootstrap GET then pays TCP and TLS set-up (about 2 round trips, 1.8 s for the far user) before its own round trip. Over the hub it would arrive in the same flight as the handshake answer. The sidebar's unread counts and presence, and `firstSync` (a stored copy that does not know a new room), are then current 2 to 3 round trips sooner. Whether the WebSocket shares the HTTP/2 connection is unknown, so the gain is unknown in size.
experiment: none
sources: [client-core-04]
files: [Yap/wwwroot/js/hub.js:84-138, Yap/wwwroot/js/hub.js:74-79, Yap/Endpoints/BootstrapEndpoints.cs:200-233, Yap/Endpoints/ChatHub.cs:34-67]
---

## What the code does now
After `connection.start()` resolves, `connect()` fetches the bootstrap over HTTP in parallel with the hooks (hub.js:119-122):

```js
const results = await Promise.allSettled([
  api.get(bootstrapUrl()),
  ...[...connectedHooks].map(fn => fn()),
]);
```

The fetch starts only after the handshake answer, so it is connection-bound on purpose: events missed before the socket joined are corrected by a document read after the join. The endpoint (BootstrapEndpoints.cs:208-214) also does three side jobs: `AuthCookie.Set` (the cookie's year, AU-18), `users.RecordKnownIp` and `links.ObserveOrigin`.

`firstSettled` (hub.js:76-79) resolves only when this bootstrap is applied. The chat page waits for it when the stored copy does not know the route (chat.js:49), and `reportLoad` waits for it.

## Why it costs the user time
The bootstrap leaves one round trip after the socket is up, on its own HTTP request. The socket is kept warm by the heartbeat; the HTTP/2 connection is not, and after a phone sleeps it is usually closed by the browser or by Caddy/Cloudflare. A new TCP plus TLS 1.3 set-up costs about 2 round trips before the GET. The rows do not wait for it, but the sidebar (unread badges, presence dots, new rooms) shows stale data until it lands, and a route to a room the stored copy does not know waits for it.

## The change
1. Server: in `OnConnectedAsync`, after `presence.Connect`, build the same `BootstrapDto` (the code of `BootstrapEndpoints` moves into a small builder) and `SendAsync("bootstrap", doc)` to the caller. The `emojiStamp` comes from the hub URL query, as the device id does today.
2. Client: `c.on('bootstrap', doc => ...)` replaces `api.get(bootstrapUrl())` in `connect()`; the rest of the code (apply, save, beacon, `settleFirst`) stays.
3. The cookie's yearly extension (AU-18) cannot travel over a WebSocket. Keep it on a cheap HTTP call that runs once a day and off the critical path (for example `POST /api/auth/touch` after the first rows), or on the `/api/bootstrap` fetch of a first load, which stays.

## Risks and what could break
- AU-18 and AU-09 (known networks) depend on the side jobs of the HTTP endpoint; they must move, not vanish.
- A large bootstrap (1,000 users) becomes one large hub message; SignalR's default maximum receive size applies to client-to-server messages only, so the server-to-client direction is fine, but the message sits in the socket's send queue in front of the `openRoom` answer. Send the bootstrap after the open conversation (see client-core-02) so the rows come first.
- The connection-bound semantics stay: the document is built after the group join.

## How to measure it
Journey resume on a real phone over the far link: the boot report has no phase for a resume, so add a mark when the bootstrap of a reconnect is applied and compare it with the reconnect's `openRoom` answer. In Chrome devtools, check whether `/api/bootstrap` after a long background shows a non-zero `connectStart`..`connectEnd` (a new connection).