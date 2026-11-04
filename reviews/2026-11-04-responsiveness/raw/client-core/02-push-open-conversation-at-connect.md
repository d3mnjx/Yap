---
id: client-core-02
title: Let the server send the open conversation's tail at connect, without the openRoom round trip
area: client-core
journey: all
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: One round trip from the "rows" phase of every connect (cold open, warm open, resume, reconnect). About 900 ms for the far user. The perf notes' own warm measurement shows socket at 1876 ms and rows at 2980 ms; that gap is this round trip plus the render.
confidence: medium
files: [Yap/wwwroot/js/hub.js:33-58, Yap/wwwroot/js/hub.js:96-122, Yap/wwwroot/js/pages/chat.js:57-61, Yap/wwwroot/js/pages/chat.js:106-124, Yap/Endpoints/ChatHub.cs:34-67, Yap/Endpoints/ChatHub.cs:81-86]
---

## What the code does now
The rows of the open conversation need two steps after the socket is up:

1. `connection.start()` resolves after the SignalR handshake answer (hub.js:101).
2. The connected hooks run (hub.js:119-122). The chat page's hook is `open` (chat.js:59-61), which calls `hub.invoke('openRoom', target.channelId)` (chat.js:107-109) and waits for the answer.

`ChatHub.OnConnectedAsync` (ChatHub.cs:34-67) records the session and sends nothing. `OpenRoom` (ChatHub.cs:81-86) does `Switch` and `Open(room)`.

So the order on the wire is: upgrade, handshake request, handshake answer, `openRoom` invocation, `openRoom` answer. The client knows the conversation before it opens the socket: the route is parsed at load (`router.current`) and the stored bootstrap knows the lobby.

## Why it costs the user time
The `openRoom` invocation can only leave after the handshake answer arrives, so it adds a full round trip after the socket opens. Every connect pays it: the cold open, the warm open, the resume after a long background (`restart()`), every reconnect. For the far user that is about 900 ms on the "rows" phase, which is the phase the catching-up pill waits for.

## The change
1. Client, `hub.js` `connect()`: before `connection.start()`, set `connection.baseUrl` (settable while Disconnected) to the hub URL plus the open target, for example `&open=room:<id>`, `&open=dm:<username>` or `&open=lobby`. The chat page registers the target with a small setter (`hub.wantOpen(target)` at mount, `null` at unmount).
2. Server, `ChatHub.OnConnectedAsync`: when the query names a target the person may open, run the same `Switch` and `Open` as `OpenRoom`/`OpenDm` and `await Clients.Caller.SendAsync("opened", conversation)`. A message sent from `OnConnectedAsync` goes out after the handshake answer, in the same flight.
3. Client: `c.on('opened', ...)` in `build()` resolves a per-connect promise. The chat page's connected hook uses it when the target matches and calls `openRoom` only when the server did not send one (old server, unknown target, the route changed meanwhile).

Keep `OpenRoom` and `OpenDm` for room switches and as the fallback.

## Risks and what could break
- `Open()` marks the conversation read (`chat.MarkRead(..., "open")`). That already happens at connect today through `openRoom`, so nothing changes, but it must stay behind the same checks (hidden tab, NT-07) as today.
- An unknown or forbidden target must not throw in `OnConnectedAsync` (that would abort the connection). Send nothing and let the client fall back to `openRoom`, which navigates to the lobby as today (SH-43).
- The route can change between `start()` and the answer. The existing `generation` check in chat.js covers it; the server's group join is then corrected by the next `openRoom`.
- The `open` wait of AD-26 and the boot report's `rows` mark keep their meaning.

## How to measure it
Journeys warm open and resume on the far link (`npm run load`, 900 ms round trip). Compare the `socket` and `rows` phases of the boot report (AD-41) before and after: the gap should drop by about one round trip. The admin `start` and `reconnect` waits show the same.
