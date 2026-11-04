---
id: client-core-32
title: Consider SignalR stateful reconnect for short connection drops
area: client-core
journey: resume
category-guess: 2
behaviour-change: none
effort: L
estimated-gain: For a drop shorter than the server's reconnect window (a network blip, a tunnel, a short background), the same connection id resumes and the missed hub messages replay, so the reconnect needs no `openRoom` and no bootstrap: about one round trip plus the tail and bootstrap bytes saved per such drop. No gain after a long background (the server has dropped the connection by then). Unknown how often short drops happen.
confidence: low
files: [Yap/wwwroot/js/hub.js:33-38, Yap/wwwroot/js/hub.js:61-63, Yap/wwwroot/js/hub.js:140-145, Yap/Program.cs:72-74, Yap/Program.cs:422]
---

## What the code does now
The client uses its own retry loop instead of `withAutomaticReconnect` (hub.js:62-63: "SignalR's list of delays ends, and it has no 'try now'"). Every reconnect is a new connection: new handshake, `openRoom` of the tail, a full bootstrap. The vendored client (`@microsoft/signalr` 10.0.11) has `withStatefulReconnect` (checked in `lib/signalr.min.js`). The server maps the hub with no options (Program.cs:422, `app.MapHub<ChatHub>("/hub")`), so `AllowStatefulReconnects` is off.

## Why it costs the user time
After a short drop, nothing in the conversation needs refetching if the messages sent meanwhile are replayed. Today the client pays the full resync: handshake, `openRoom` answer (the tail), the bootstrap, and the timeline's comparison of 50 rows.

## The change
Investigate, do not assume:
1. Server: `app.MapHub<ChatHub>("/hub", o => o.AllowStatefulReconnects = true)` and a buffer limit.
2. Client: `withStatefulReconnect()` on the builder. Check in the SignalR docs and source whether the JS client's stateful reconnect works without `withAutomaticReconnect`; if it needs it, the custom loop has to cooperate (for example, automatic reconnect for the first few seconds, then the custom loop).
3. On a successful stateful reconnect, the chat page's connected hook and the bootstrap fetch must not run.

## Risks and what could break
- More machinery, which the project avoids (offline-best-effort-principle: "the least machinery for the common short outage").
- `OnConnectedAsync` and `OnDisconnectedAsync` semantics change (a resumed connection is not a new one); presence grace periods (PR-14, PR-17) interact with it.
- Buffer memory per connection on the server.

## How to measure it
First count short drops: the `reconnect` wait samples (AD-26) with a short loss; if they are rare, drop this finding.
