---
id: C2-13
title: Keep a per-person session count (or list) in PresenceService so EffectiveOf, IsOnlineAndVisible, HasSession and Connect stop scanning all sessions
category: 2
journey: all
effort: M
confidence: medium
behaviour-change: none
estimated-gain: Removes O(sessions) scans under the global presence lock from each connect (three scans), each push recipient (two scans), each DM open with unread (one), and makes the admin pages O(sessions) instead of O(people x sessions). At 1,500 sessions the admin Users page (StatusPill per user) and the Diagnostics poll (EffectiveOf per session row, every 30 s) each hold the lock for an estimated 50 to 200 ms (same ratio as the sweep measurement), stalling every heartbeat and send. Small servers gain little.
experiment: none
sources: [backend-services-05]
files: [Yap/Services/Presence/PresenceService.cs:57-71, Yap/Services/Presence/PresenceService.cs:208-213, Yap/Services/Presence/PresenceService.cs:361-387, Yap/Services/Presence/PresenceService.cs:508-512, Yap/Services/Presence/PresenceService.cs:524-540, Yap/Endpoints/AdminEndpoints.cs:36-42, Yap/Endpoints/AdminEndpoints.cs:349-350, Yap/Endpoints/AdminEndpoints.cs:379]
---

## What the code does now
- `EffectiveLocked` scans all sessions: `_sessions.Values.Any(s => s.UserId == userId)` (`PresenceService.cs:510`).
- `Connect` runs three scans per connect: `first = !_sessions.Values.Any(...)`, `EffectiveLocked` before and after (`:63-67`).
- `IsOnlineAndVisible` runs `EffectiveLocked` and then another `Any` (`:364`); `ChatService.DispatchPush` calls it per push recipient (`ChatService.cs:628`).
- `HasSession`, `IsMobile`, `HasConnectedSessionFromIp`, `SessionsOf`, `Describe` each scan all sessions.
- Admin Users: `presence.StatusPill(u.Id)` for every user (`AdminEndpoints.cs:39`), which calls `EffectiveOf` and maybe `HasSession`: people x sessions under the lock.
- Admin Diagnostics: `SessionRow` calls `presence.EffectiveOf(s.UserId)` for every session row (`AdminEndpoints.cs:379`), for live and recently closed sessions, polled every 30 s by the open tab (`pages/admin.js:699`): sessions x sessions under the lock.

## Why it costs the user time
Every hub call that touches presence (heartbeat, typing, openRoom's `SetViewing`, the room send's `Looking`) waits for `_gate`. Long holds come from these scans when the server has many sessions, and they line up with the busiest moments (a reconnect storm, an admin page left open).

## The change
Add `Dictionary<Guid, int> _sessionsPerUser` (or `Dictionary<Guid, List<Session>>`) maintained under `_gate` in `Connect` and `RemoveLocked`. Then `EffectiveLocked` becomes `_sessionsPerUser.ContainsKey(userId) ? StatusLocked(userId) : Offline`, `HasSession` an O(1) lookup, `Connect`'s `first` an O(1) lookup, and `IsOnlineAndVisible`/`SessionsOf`/`Describe` walk only the person's own sessions if the list form is used. About 30 to 40 lines in one file. Comment at the field: every add and remove of `_sessions` must update it.

## Risks and what could break
An add or remove path that forgets the index makes a person look offline or stuck online. There are two mutation sites (`Connect` and `RemoveLocked`); the tests of PR-14 to PR-17 cover them.

## How to measure it
`SweepMs` and request p95 in `/api/admin/load` during a load test with the Diagnostics tab open; time `/api/admin/users` at 1,000 users.