---
id: C2-02
title: Compress the hub's WebSocket frames (permessage-deflate) so openRoom, older and live events travel compressed
category: 2
journey: switch-room
effort: M
confidence: medium
behaviour-change: none
estimated-gain: A 50-row openRoom of plain text rows is about 19.6 KB of JSON on the wire today and about 4.3 to 4.7 KB with deflate (my synthetic sample, levels 6 and 1). At 1 Mbit/s that is about 160 ms against about 37 ms, so about 120 ms per room open, per reconnect tail and per older page for the far user. Rows with images, cards and reactions are larger and gain more. Measured on synthetic JSON only; the real ratio needs measurement.
experiment: none
sources: [backend-services-01]
files: [Yap/Program.cs:72-74, Yap/Program.cs:80-84, Yap/Program.cs:422, Yap/Endpoints/ChatHub.cs:81-107, Yap/Endpoints/ChatHub.cs:165-172]
---

## What the code does now
- The hub uses the JSON protocol with no other option: `builder.Services.AddSignalR().AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter(...)))` (`Program.cs:72-74`), mapped with `app.MapHub<ChatHub>("/hub")` (`Program.cs:422`).
- Response compression is on for HTTP only: `AddResponseCompression(o => { o.EnableForHttps = true; ... })` (`Program.cs:80-84`). It never touches WebSocket frames.
- `OpenRoom` returns a `Conversation` with 50 `MessageDto` rows (`ChatHub.cs:26`, `:165-172`); `Older` returns a `Page` of 50 (`ChatHub.cs:102-107`). Both go over the WebSocket.
- In the .NET 10 reference docs, `Microsoft.AspNetCore.Http.Connections.WebSocketOptions` has only `CloseTimeout` and `SubProtocolSelector`. There is no compression switch in SignalR. The accept-level switch exists: `WebSocketAcceptContext.DangerousEnableCompression` (Microsoft.AspNetCore.Http.Features).

## Why it costs the user time
The rows of the open conversation are the critical path of every cold open, room switch and resume ("rows" phase in AD-41). Their bytes cross the 1 Mbit/s link uncompressed. A message row repeats the same 15 keys, three GUIDs and an ISO timestamp, which deflate removes almost entirely. Everyone pays; the far user on a slow link pays the most, and pays again on each reconnect (the tail is fetched again) and on each older page.

## The change
Add a small middleware before `MapHub` for requests to `/hub` that wraps `IHttpWebSocketFeature` with a decorator. The decorator's `AcceptAsync(context)` sets `context.DangerousEnableCompression = true` (and, to bound memory per connection, `DisableServerContextTakeover = true` or a smaller `ServerMaxWindowBits`) and then calls the inner feature. About 25 lines in one new file plus one `app.Use` line in `Program.cs`. A comment at the decorator must say why it exists (SignalR has no compression option) and why "Dangerous" is acceptable here (see risks).

Alternatives, if the decorator is unwanted: the MessagePack hub protocol (needs a client script, saves less, GUIDs and text stay strings), or serving the tail and older pages over a compressed HTTP GET (a design change).

## Risks and what could break
- Compression mixes attacker text (other people's messages) with any secret in the same compressed stream (CRIME class). Hub payloads carry no auth token; the beacon nonce (`BeaconNonce`) is the only secret-like value. Check that list before shipping.
- Memory: with context takeover each connection keeps a deflate window (tens of KB). At 1,500 connections that can be tens of MB. `DisableServerContextTakeover` trades some ratio for memory.
- CPU per frame on the server; small frames (typing, presence) may not benefit.
- Caddy and Cloudflare must pass `Sec-WebSocket-Extensions` through. Unknown; verify with the browser's network panel (the 101 response shows `permessage-deflate`).

## How to measure it
`npm run load` with the 900 ms / 1 Mbit/s throttle: compare the `rows` phase and the frame sizes of the `openRoom` completion before and after. In production, the AD-41 Load time table (`rows` minus `socket`) for far users, and the `open` and `older` waits of AD-26.