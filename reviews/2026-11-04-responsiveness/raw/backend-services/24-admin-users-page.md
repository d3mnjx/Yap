---
id: backend-services-24
title: Admin Users page: stop loading every action-log row twice from SQLite, and compute statuses in one pass
area: backend-services
journey: admin
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The page awaits two full scans of the log table: all rows with every column (GetLastActionPerUserAsync) and all rows with an IP, then groups them in memory. The cleanup keeps up to 200 rows per person plus 2,000 anonymous rows, so 1,000 people means up to about 200,000 rows read and materialized per page open; plausibly 0.5 to 3 s on a small VPS (not measured). Then StatusPill per person rescans all sessions under the presence lock (see 05). Only the admin waits for the page; everyone else waits for the presence lock while it runs.
confidence: medium
files: [Yap/Endpoints/AdminEndpoints.cs:32-49, Yap/Services/Admin/UserActionLogService.cs:106-161, Yap/Services/Admin/UserActionLogService.cs:28-40, Yap/Services/Presence/PresenceService.cs:208-213]
---

## What the code does now
- `var lastActions = await log.GetLastActionPerUserAsync(); var recentIps = await log.GetRecentIPsPerUserAsync();` (`AdminEndpoints.cs:34-35`), one after the other.
- `GetLastActionPerUserAsync` loads `db.UserActionLogs.Where(l => l.UserUid != "").OrderByDescending(l => l.Date).ToListAsync()` (every column, every row) and keeps the first per user (`UserActionLogService.cs:116-123`); the comment says the GroupBy did not translate.
- `GetRecentIPsPerUserAsync` loads all rows with an IP and keeps five distinct per user (`:144-154`).
- `presence.StatusPill(u.Id)` per user (`AdminEndpoints.cs:39`).
- Every log row is written through `Log` (`:28-40`), so the service sees each row as it is created.

## Why it costs the user time
The admin's page open waits for the reads (the doctrine allows the admin log pages to read the DB, but not this much). Microsoft.Data.Sqlite runs its "async" calls synchronously, so each read also blocks a thread-pool thread for its whole duration.

## The change
Memory-first, like the rest: keep `ConcurrentDictionary<string, (string Action, DateTime At)> _lastAction` and a small ring of the last five distinct IPs per user in `UserActionLogService`, updated in `Log` and filled once at startup in the background with two grouped SQL queries (`GROUP BY UserUid` with `MAX(Date)`; EF translates `GroupBy(...).Select(g => new { g.Key, At = g.Max(l => l.Date) })`). The Users page then reads memory only. For statuses, take one presence snapshot (`presence.Effective()` after 04, plus a `HasSession` set) instead of one locked scan per person.

## Risks and what could break
- Without persistence the in-memory values start empty after a restart; today the page shows nothing then either (no DB).
- The "last action" must keep the same definition (any action except anonymous rows).

## How to measure it
Time `/api/admin/users` with a fixture of 1,000 users and 200 log rows each, before and after; watch `SweepMs` and request p95 in `/api/admin/load` while the page loads.
