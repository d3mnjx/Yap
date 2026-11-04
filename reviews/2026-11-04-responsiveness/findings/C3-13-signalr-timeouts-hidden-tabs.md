---
id: C3-13
title: Longer SignalR client timeout so a desktop tab hidden for a few minutes keeps its socket and needs no catch-up
category: 3
journey: resume
effort: S
confidence: low
behaviour-change: A tab that was hidden between 30 s and about 2 min shows current rows at once on return (it kept receiving events); a device that vanishes without closing its socket shows as connected for up to about 2 min instead of 30 s.
estimated-gain: For the far user, a return after 30 s to 2 min hidden skips the reconnect (upgrade, handshake, openRoom: about 2.7 s at 900 ms per round trip) and the Catching up pill. Only for browsers whose socket survives in the background (desktop and some Android tabs; iOS suspends the app). Unknown share, needs measurement.
experiment: none
sources: [backend-request-24]
files: [Yap/Program.cs:72-74, Yap/wwwroot/js/hub.js:71-72, Yap/wwwroot/js/hub.js:188-200, Yap/Services/Presence/PresenceService.cs:18-27, Yap/Endpoints/ChatHub.cs:116-122]
---

## What the code does now
- `builder.Services.AddSignalR()` sets no hub options except the filter (Program.cs:72-74), so the framework defaults apply: the server sends a keep-alive every 15 s and drops a client it has not heard from for 30 s (ClientTimeoutInterval). hub.js states it: `const SERVER_TIMEOUT_MS = 30_000;   // SignalR's default on both sides; nothing overrides it` (hub.js:72).
- On return to visible, the client restarts the connection when the tab was hidden longer than that: `const longBackground = hiddenAt && Date.now() - hiddenAt > SERVER_TIMEOUT_MS;` (hub.js:196), the TL-39 rule.
- The client sends its heartbeat every 60 s while hidden (ChatHub.cs:116-117 comment). Browsers throttle timers in hidden pages (Chrome documents a one-per-minute alignment after 5 minutes hidden), so the client's 15 s SignalR ping can miss the server's 30 s window.
- Presence detects a lost device by the disconnect (`DroppedAt`) and by heartbeat age (`HeartbeatStale = 90 s`, `DropToAway = 30 s`; PresenceService.cs:18-27).

## Why it costs the user time
After any background longer than 30 s, the return costs a full reconnect and a new tail, even when the old socket could have stayed alive and kept the rows current. The far user sees the old screen and the pill for about three round trips.

## The change
- Program.cs: `.AddSignalR(o => { o.ClientTimeoutInterval = TimeSpan.FromMinutes(2); o.KeepAliveInterval = TimeSpan.FromSeconds(15); })`.
- hub.js: `SERVER_TIMEOUT_MS = 120_000` and the client's `serverTimeoutInMilliseconds` to match the server's keep-alive rule (at least twice the keep-alive; it can stay 30 s, since the server keeps pinging every 15 s).
- Keep the forced reconnect for returns after more than 2 min.

## Risks and what could break
- A phone that loses its network keeps its server session up to 2 min; presence then shows it longer, unless the heartbeat rule (90 s stale) already ends it. Check the sweep's rules against the new timing (PR-15, PR-16).
- More idle connections held on the server.
- If the socket died anyway (iOS), the client learns it on its first failed call, up to its own server timeout; the forced reconnect after 2 min covers long backgrounds, but a 31 s to 2 min background on iOS would now wait for that failure. This risk is why the confidence is low: measure which devices keep the socket.

## How to measure it
The admin Sessions table: `DroppedAt` of hidden desktop tabs with the default settings (how many drop between 30 s and 2 min hidden). The `reconnect` wait (AD-26) and the resume scenario of `npm run load` with a 60 s hidden period, before and after.