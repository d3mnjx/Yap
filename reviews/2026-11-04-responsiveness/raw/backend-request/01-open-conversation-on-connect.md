---
id: backend-request-01
title: Send the open conversation with the connect, not after it (one round trip less on every connect)
area: backend-request
journey: resume
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: One round trip (about 900 ms for the far user) off the time to the server's rows on every connect, reconnect and resume. The notes measured warm "socket 1876 ms, rows 2980 ms" after step 5; the 1.1 s gap is the openRoom round trip plus render.
confidence: medium
files: [Yap/Endpoints/ChatHub.cs:34-67, Yap/Endpoints/ChatHub.cs:81-93, Yap/Endpoints/ChatHub.cs:165-172, Yap/wwwroot/js/hub.js:34-36, Yap/wwwroot/js/hub.js:109-122, Yap/wwwroot/js/pages/chat.js:61, Yap/wwwroot/js/pages/chat.js:106-110]
---

## What the code does now
- The client opens the socket and waits for the SignalR handshake: `try { await connection.start(); }` (hub.js:109). Only then it runs the connected hooks: `api.get(bootstrapUrl()), ...[...connectedHooks].map(fn => fn())` (hub.js:119-122).
- The chat page's hook is `hub.onConnected(open)` (chat.js:61). It calls `await hub.invoke('openRoom', target.channelId)` or `openDm` (chat.js:107-109).
- On the server, `OnConnectedAsync` (ChatHub.cs:34-67) only records the session. `OpenRoom` (ChatHub.cs:81-86) does the group join, `SetViewing`, mark-read and the 50-row tail in one call.
- The hub URL is fixed per HubConnection object: ``.withUrl(`/hub?device=${deviceId()}...`)`` (hub.js:35).
- docs/performance-notes.md counts the floor as "3: upgrade, handshake, openRoom".

## Why it costs the user time
The openRoom request can leave the client only after the handshake answer arrives. So the rows need one more full round trip after the handshake. The client knows which conversation it shows before it connects (the route). The far user pays about 900 ms on each cold open with a stored copy, each reconnect and each resume after more than 30 s hidden (the TL-39 forced reconnect).

## The change
- Client (hub.js): put the target in the hub URL, `&open=room:<id>` or `&open=dm:<username>`. Build the connection again when the target changed before a connect (build() already exists; the custom retry loop calls `connection.start()` on the object).
- Server (ChatHub.OnConnectedAsync): after `presence.Connect`, when the `open` query names a room or a person, resolve it (`chat.GetRoom`, `chat.GetOrCreateDm`), run `Switch(...)` and send the result with `await Clients.Caller.SendAsync("opened", Open(channel))`. An unknown target sends nothing (the client falls back to openRoom).
- Client (chat.js): handle `opened` exactly like the openRoom answer (`setOpen(result, ...)`), with the existing `generation` check. The connected hook skips its own openRoom when the `opened` for the same target already came, or waits briefly for it.
- Keep `openRoom` and `openDm` for switches inside a live connection.

## Risks and what could break
- Ordering: SignalR writes the handshake answer before it calls OnConnectedAsync (framework behaviour; verify in a test). The `opened` frame then follows the handshake answer in the same flight.
- An exception in OnConnectedAsync ends the connection. Catch everything around the open.
- The target can change while the socket opens. The `generation` check in chat.js must drop a stale `opened`.
- The channel id or username appears in the hub URL, so in proxy logs. The URL already carries the device id. RequestLoggingMiddleware skips `/hub`.
- The boot report (AD-41) marks `rows` from the openRoom path; it must also mark it from `opened`.

## How to measure it
`npm run load` with the 900 ms / 1 Mbit/s throttle: warm load, compare `socket` to `rows`; the resume scenario (35 s hidden). In the field: the Load time table (AD-41), `rows` minus `socket` per load, and the `reconnect` wait (AD-26).
