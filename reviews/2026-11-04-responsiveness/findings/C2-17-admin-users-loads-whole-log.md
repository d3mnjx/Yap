---
id: C2-17
title: Admin Users tab: let SQL find the last action and the recent addresses, run the reads in parallel, and stop logging every API request to the database
category: 2
journey: admin
effort: M
confidence: medium
behaviour-change: none
estimated-gain: The Users tab request today reads every action-log row with a user id twice, one query after the other. The table grows by one HTTP_REQUEST row per API request until the next restart trims it (1,441 of 1,646 rows in the dev database, 88 %). Gain grows with uptime and traffic; unknown, needs measurement.
experiment: none
sources: [backend-request-22, backend-services-24]
files: [Yap/Endpoints/AdminEndpoints.cs:32-50, Yap/Endpoints/AdminEndpoints.cs:233-244, Yap/Endpoints/AdminEndpoints.cs:268-279, Yap/Services/Admin/UserActionLogService.cs:106-160, Yap/Middleware/RequestLoggingMiddleware.cs:92-114]
---

## What the code does now
- `/api/admin/users` awaits `log.GetLastActionPerUserAsync()` and then `log.GetRecentIPsPerUserAsync()` (AdminEndpoints.cs:34-35).
- The first loads full entities of every row with a user id, sorted, and groups in memory: `db.UserActionLogs.Where(l => l.UserUid != "").OrderByDescending(l => l.Date).ToListAsync()` then `GroupBy(l => l.UserUid).ToDictionary(g => g.Key, g => g.First())` (UserActionLogService.cs:116-123). The second loads every (UserUid, IP) pair the same way (lines 144-154).
- RequestLoggingMiddleware writes a CSV line for each non-static request (line 106) and also a database row: `_actionLog.Log(..., UserActionLog.KnownActions.HTTP_REQUEST, url: loggedUrl, ...)` (lines 109-114).
- The trim to 100 rows per person runs only at startup (`CleanupAsync`).
- `/media` and `/visitors` also await two queries in series (AdminEndpoints.cs:236-237, 271-272).

## Why it costs the user time
The admin waits for two full-table reads in a row, and their size grows with every API call of every person since the last restart. This is the admin journey only; the database work also shares the SQLite file with the persistence writer.

## The change
- Let SQL aggregate: for the last action, a subquery with `GroupBy(l => l.UserUid).Select(g => new { g.Key, Date = g.Max(l => l.Date) })` joined back to the rows; for the five recent addresses, a query per page of people or a windowed SQL (`ROW_NUMBER() OVER (PARTITION BY UserUid ORDER BY Date DESC)`) via `FromSql`. Both use the existing indexes on UserUid and Date.
- Run the two reads in parallel: each method already creates its own context from the pooled factory, so `await Task.WhenAll(lastTask, ipsTask)` works. Same for `/media` and `/visitors`.
- Stop writing HTTP_REQUEST rows to the database; the CSV keeps them. This changes what the Logs tab shows under that action filter, so it is the user's decision (category 3 for the admin).

## Risks and what could break
- SQLite and EF translate `GroupBy` with `Max` well; `First()` per group does not translate (the comment in the code says so), which is why the join form is needed.
- If the Logs tab must keep HTTP_REQUEST rows, keep writing them but exclude them from the "last action" query if the admin wants a meaningful last action.

## How to measure it
The request time of /api/admin/users in the RequestLogs CSV over a week of uptime; the row count of UserActionLogs by action.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/24-admin-users-page.md`. The raw files hold their reasoning and numbers.
