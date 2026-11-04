---
id: backend-services-10
title: Run the action-log cleanup after the server listens (through the writer queue), not before app.Run
area: backend-services
journey: resume
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The cleanup runs one DELETE, one GROUP BY, and then two SELECT plus two DELETE statements for each user with more than 100 log rows, all before Kestrel accepts a connection. With hundreds of active users that is hundreds to thousands of statements, plausibly 0.5 to several seconds (unknown, needs measurement) added to every restart and deploy. During that time every client's reconnect fails and its retry back-off (1, 2, 4, 8 s) can stretch the gap further.
confidence: medium
files: [Yap/Program.cs:212-226, Yap/Program.cs:440, Yap/Services/Admin/UserActionLogService.cs:45-101]
---

## What the code does now
```csharp
// Clean up old action logs (keep last 100 per user, delete older than 6 months)
await app.Services.GetRequiredService<UserActionLogService>().CleanupAsync();
```
(`Program.cs:225-226`), before `app.Run()` (`Program.cs:440`). `CleanupAsync` deletes rows older than six months, groups all rows by user to find users with more than 100, then for each such user runs `TrimAsync` twice (`UserActionLogService.cs:70-82`), and each `TrimAsync` runs a SELECT of the ids to keep and a DELETE with `NOT IN` (`:97-101`). The JOIN row is written on every first hub connection of a person (`ChatHub.cs:61-65`), so active users reach 100 rows quickly.

## Why it costs the user time
Nothing listens until all startup work finishes. A deploy is the moment every client reconnects; the user sees the "Catching up" pill or the amber dot for the whole start time. The log rows are read only by the admin pages, so nothing needs them trimmed before the first request.

## The change
Replace the awaited call with a write on the persistence queue, which is where database writes belong by the doctrine ("EF code goes in Writes.cs and the startup loads"): `writer.Enqueue(Writes.CleanupActionLogs())`, moving the body of `CleanupAsync` into `Writes.cs` (it takes the `db` the writer passes). Or, smaller: start it with `_ = Task.Run(...)` after `app.Start`. Comment at the call: the cleanup touches only admin log rows, so it never delays the first request.

## Risks and what could break
- Inside the writer, a long cleanup delays the chat writes queued behind it by its duration (disk behind memory for a few seconds; no request waits).
- A crash during cleanup is harmless; it runs again at the next start.

## How to measure it
Wrap each startup step in a Stopwatch and log the milliseconds (see 11). Compare time from process start to the first `/api/bootstrap` answer in a restart test.
