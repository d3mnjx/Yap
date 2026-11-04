---
id: C1-14
title: Presence for the bootstrap scans all sessions once per person under the global lock
category: 1
journey: all
effort: S
confidence: high
behaviour-change: none
estimated-gain: O(sessions x people) becomes O(sessions) per bootstrap. At 1,500 sessions and 1,000 people that is about 750,000 checks under the presence lock per bootstrap (estimated 1 to 3 ms of lock hold), at 30 people nothing measurable. The lock also serves every heartbeat, typing event, openRoom and send.
experiment: none
sources: [backend-request-03, backend-services-04]
files: [Yap/Services/Presence/PresenceService.cs:390-401, Yap/Services/Presence/PresenceService.cs:508-512, Yap/Endpoints/BootstrapEndpoints.cs:59]
---

## What the code does now
- `Effective()` groups the sessions by person, then calls `EffectiveLocked(group.Key)` for each group (PresenceService.cs:390-401).
- `EffectiveLocked` starts with `if (!_sessions.Values.Any(s => s.UserId == userId)) return EffectiveStatus.Offline;` (PresenceService.cs:510), a scan of all sessions.
- All of this runs inside `lock (_gate)`.
- The bootstrap calls it on every request: `Presence: presence.Effective()` (BootstrapEndpoints.cs:59).
- The same pattern was fixed in `Sweep` and `Looking`, which call `StatusLocked` for people known to have a session (comments at PresenceService.cs:244-246 and 514-516).

## Why it costs the user time
Every bootstrap (one per connect) holds the global presence lock for a time that grows with sessions times people. Heartbeats, typing, `SetViewing` in openRoom, `Looking` in every room send and the sweep wait for it. After a deploy all clients bootstrap within seconds, so the lock holds add up. At 30 people the cost is tiny; at load-test scale it is the same class of cost the sweep had (70 to 200 ms per pass on 2026-10-18).

## The change
In `Effective()` replace `var presence = EffectiveLocked(group.Key);` with `var presence = StatusLocked(group.Key);`. The group proves that the person has a session, which is the only thing `EffectiveLocked` adds. One line, with a short comment that points to `StatusLocked`'s doc comment.

## Risks and what could break
None in behaviour: `EffectiveLocked` returns `StatusLocked` whenever a session exists. The existing presence tests cover the result.

## How to measure it
A unit test with 1,500 sessions and a Stopwatch around `Effective()`. In the field: bootstrap request time in the RequestLogs CSV during the reconnect wave after a deploy, and the `SweepMs` and thread-pool queue columns of /api/admin/load.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/04-presence-effective-quadratic.md`. The raw files hold their reasoning and numbers.
