---
id: C1-83
title: Write coalesced read states with one SQL upsert per row instead of an EF Find plus tracked update
category: 1
journey: all
effort: S
confidence: low
behaviour-change: none
estimated-gain: Background CPU only. A message in a room of 1,000 people coalesces into up to 1,000 read-state rows every 2 s; each costs a SELECT (FindAsync), a tracked SetValues, a SaveChanges and a ChangeTracker.Clear. On a 1 or 2 vCPU host that is CPU taken from request handling during busy periods. Whether this changes one user's latency is unknown; it matters only on small hosts with busy large rooms.
experiment: none
sources: [backend-services-27]
files: [Yap/Services/Persistence/Writes.cs:63-66, Yap/Services/Persistence/Writes.cs:154-159, Yap/Services/Persistence/PersistenceWriter.cs:216-233, Yap/Services/Chat/ChatService.cs:541-542]
---

## What the code does now
- `ReadState(state) => (db, ct) => Upsert(db, db.ChannelReadStates, new ChannelReadState { ... }, ct, state.UserId, state.ChannelId);` (`Writes.cs:63-66`), and `Upsert` runs `await set.FindAsync(key, ct)` then `Add` or `SetValues` (`:154-159`).
- The writer saves after every write and clears the tracker (`PersistenceWriter.cs:222-231`).
- `Send` coalesces one read-state write per recipient (`ChatService.cs:542`).

## Why it costs the user time
Only indirectly: CPU spent here on a small host is not available to the request threads.

## The change
For read states only: `db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO ChannelReadStates (UserId, ChannelId, LastReadAt, UnreadCount) VALUES (...) ON CONFLICT(UserId, ChannelId) DO UPDATE SET LastReadAt = excluded.LastReadAt, UnreadCount = excluded.UnreadCount")`. One statement, no tracking. The column and table names must match the migration.

## Risks and what could break
Raw SQL ties the write to SQLite (the only provider implemented). The foreign key failure path the writer handles stays the same.

## How to measure it
`CpuPercent` and `WriterDepth` in `/api/admin/load` during a load test with a 1,000-member room; request p95 at the same time.