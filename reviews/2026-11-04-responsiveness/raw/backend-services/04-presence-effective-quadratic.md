---
id: backend-services-04
title: In PresenceService.Effective (every bootstrap), use StatusLocked for each group instead of EffectiveLocked, which rescans all sessions per person under the global lock
area: backend-services
journey: resume
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The loop does about people x sessions/2 checks under the one presence lock. At 1,000 people and 1,500 sessions that is about 750,000 checks per bootstrap. The code's own measurement of the same pattern in the sweep (2.25 million checks took 70 to 200 ms, PresenceService.cs:244-246) gives about 23 to 67 ms per bootstrap, during which every heartbeat, typing call, openRoom (SetViewing, Get) and room send (Looking, ConnectedUserIds) waits. After a deploy every client bootstraps at once, so the stall adds up to seconds. With the fix the loop is one pass. Small servers (tens of sessions) gain little.
confidence: high
files: [Yap/Services/Presence/PresenceService.cs:390-402, Yap/Services/Presence/PresenceService.cs:508-512, Yap/Services/Presence/PresenceService.cs:517-522, Yap/Endpoints/BootstrapEndpoints.cs:59]
---

## What the code does now
The bootstrap calls `presence.Effective()` (`BootstrapEndpoints.cs:59`):
```csharp
foreach (var group in _sessions.Values.GroupBy(s => s.UserId))
{
    var presence = EffectiveLocked(group.Key);
```
(`PresenceService.cs:395-397`), inside `lock (_gate)`. `EffectiveLocked` starts with `if (!_sessions.Values.Any(s => s.UserId == userId)) return EffectiveStatus.Offline;` (`:510`), a scan of all sessions, for a person who is known to have a session because the group exists. The class already has the cheap form for this case: `StatusLocked` ("a caller that holds the session, or iterates the sessions, skips it", `:514-517`), and `Looking` and the sweep use it for this reason.

## Why it costs the user time
The bootstrap runs after every hub connect (`js/hub.js:120`), in parallel with `openRoom`. While it holds `_gate`, the reconnecting user's own `openRoom` (`SetViewing`, `presence.Get` in `LeaveCurrentGroup`) and every other user's heartbeat and send wait. A deploy makes every client reconnect within seconds, so the waits queue up exactly when everyone is waiting for rows.

## The change
`PresenceService.cs:397`: `var presence = StatusLocked(group.Key);` One line, plus a short comment that the group proves the session exists (the same reason as in `Looking`).

## Risks and what could break
None in behaviour: for a person with a session, `EffectiveLocked` returns `StatusLocked`. The permanent bot session is in `_sessions` too; it returns the same value as before.

## How to measure it
Load-test with 1,000 users: time the bootstrap endpoint on the server (the request p95 in `/api/admin/load`) and the presence sweep ms, before and after. On a small server: no visible change, which is expected.
