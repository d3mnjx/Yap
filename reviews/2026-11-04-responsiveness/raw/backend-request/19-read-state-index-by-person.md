---
id: backend-request-19
title: Index read states by person; the bootstrap and the push path scan everyone's read states
area: backend-request
journey: all
category-guess: 1
behaviour-change: none
effort: M
estimated-gain: The bootstrap's unread map and each push recipient's total go from a pass over all read states (people x conversations: 450 at 30 x 15, about 60,000 at 1,000 x 60) to the person's own entries. Estimated 1 to 2 ms per call at 60,000 entries; nothing measurable at 30 people.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:44, Yap/Services/Chat/ChatService.cs:926-937, Yap/Endpoints/BootstrapEndpoints.cs:61]
---

## What the code does now
- One dictionary for all: `ConcurrentDictionary<(Guid UserId, Guid ChannelId), ChannelReadState> _readStates` (ChatService.cs:44).
- `UnreadCounts(userId) => _readStates.Where(e => e.Key.UserId == userId && e.Value.UnreadCount > 0).ToDictionary(...)` (lines 926-927), called by every bootstrap (BootstrapEndpoints.cs:61).
- `TotalUnread(userId)` filters the same way, per push recipient (lines 930-937).

## Why it costs the user time
Each connect's bootstrap walks every person's read state. At load-test scale, the reconnect wave after a deploy multiplies it by the number of clients. At 30 people it is negligible; this is a scale item.

## The change
Keep the per-person entries together: `ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, ChannelReadState>> _readStatesByUser`, either as the store or as a second index updated in the same places (`GetOrAdd` in MarkRead and IncrementUnread, Purge, RemoveAccount, InitializeAsync). `UnreadCounts` and `TotalUnread` then read one inner dictionary.

## Risks and what could break
Two structures must stay in step if the index is a second one; making it the only store avoids that but touches every use (about ten lines).

## How to measure it
A Stopwatch around `UnreadCounts` with the load tool's 1,000 users; bootstrap request time in the RequestLogs CSV during a reconnect wave.
