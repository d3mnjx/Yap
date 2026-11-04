---
id: C3-11
title: Admin Diagnostics: bucket the 7-day series on the server (or send only new points) instead of resending up to 20,160 points every 30 s
category: 3
journey: admin
effort: S
confidence: high
behaviour-change: The three diagnostics charts draw about 500 averaged points per line instead of up to 20,160 raw points (no visible difference at chart width).
estimated-gain: After a week of uptime the series is 20,160 points of six fields, about 2.5 to 3 MB of JSON, an estimated 300 to 500 KB compressed, fetched again every 30 s while the tab is open; about 3 to 4 s per poll at 1 Mbit/s, and Chart.js redraws 20,000 points per line on each poll. Bucketed to 500 points: about 70 KB raw. The same endpoint builds a row per session with EffectiveOf under the presence lock (sessions x sessions, see 05).
experiment: none
sources: [backend-services-25]
files: [Yap/Services/Admin/DiagnosticsCollectorService.cs:13-14, Yap/Services/Admin/DiagnosticsCollectorService.cs:86-92, Yap/Endpoints/AdminEndpoints.cs:339-363, Yap/Endpoints/AdminEndpoints.cs:375-385, Yap/Services/Admin/LoadMetrics.cs:196-231]
---

## What the code does now
- `private const int MaxEntries = 20160; // 7 days at 30s intervals` (`DiagnosticsCollectorService.cs:14`); `GetSnapshots()` returns all of them (`:86-92`).
- `/api/admin/diagnostics` sends `series = snapshots.Select(s => new { s.Timestamp, s.UniqueUsers, s.UserSessions, s.ActiveConnections, s.DisconnectedConnections, s.TotalMessages }).ToList()` (`AdminEndpoints.cs:348`) and a `SessionRow` per live and recently closed session, each with `status = presence.EffectiveOf(s.UserId)` (`:349-350`, `:379`).
- The tab polls every 30 s (`js/pages/admin.js:699`) and redraws three charts from the series (`:679-697`).
- `LoadMetrics.Last(seconds, step)` already buckets its own series (`LoadMetrics.cs:196-231`), so the pattern exists.

## Why it costs the user time
The admin on a far or mobile link waits seconds per refresh and the phone redraws large charts every 30 s; the server serializes megabytes every 30 s per open admin tab.

## The change
Bucket the series to at most about 500 points with the same averaging as `LoadMetrics.Bucket` (or accept `?since=` and return only newer points, keeping the client's earlier points). Compute session statuses from one presence snapshot instead of `EffectiveOf` per row.

## Risks and what could break
Averaging hides a single 30-second spike in a 7-day view; keep max values for the counts if spikes matter (the bucket can carry max as well as average).

## How to measure it
Response size and time of `/api/admin/diagnostics` after a few days of uptime; main-thread time of the Diagnostics tab refresh in the browser.