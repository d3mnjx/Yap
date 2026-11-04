---
id: backend-services-19
title: Index read states by person so the bootstrap's unread counts and each push's total unread stop scanning every read state on the server
area: backend-services
journey: resume
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: `_readStates` holds one entry per person and conversation they ever had a count in: with 1,000 people and a dozen rooms plus DMs, 15,000 to 50,000 entries. UnreadCounts (every bootstrap) and TotalUnread (every push recipient, see 12) walk all of them. Estimated 0.2 to 1 ms per call (not measured). Low per call; it repeats per reconnect and per push.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:44, Yap/Services/Chat/ChatService.cs:922-937, Yap/Services/Chat/ChatService.cs:943-964, Yap/Services/Chat/ChatService.cs:971-1000, Yap/Endpoints/BootstrapEndpoints.cs:61]
---

## What the code does now
- `ConcurrentDictionary<(Guid UserId, Guid ChannelId), ChannelReadState> _readStates` (`ChatService.cs:44`).
- `UnreadCounts(userId) => _readStates.Where(e => e.Key.UserId == userId && e.Value.UnreadCount > 0).ToDictionary(...)` (`:926-927`), called by the bootstrap (`BootstrapEndpoints.cs:61`).
- `TotalUnread(userId)` does the same walk plus a mute check per entry (`:930-937`), called per push recipient inside `DispatchPush` (`:631`).
- Entries are created in `IncrementUnread` (`:990`), `MarkRead` (`:946`) and the startup load (`:127-128`); removed in `Purge` (`:280-281`) and `RemoveAccount` (`:331`).

## Why it costs the user time
Both walks run on request threads: the bootstrap that runs in parallel with the reconnect's openRoom, and the send POST (until 12 moves the push off it).

## The change
Add `ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, ChannelReadState>> _readStatesByUser`, filled at the same `GetOrAdd` sites and cleared at the same remove sites. `UnreadCounts` and `TotalUnread` read the person's inner dictionary only. About 30 lines; a comment at both dictionaries says they change together.

## Risks and what could break
A create or remove site that updates one dictionary and not the other shows a wrong badge. Five sites in one file.

## How to measure it
Server time of `/api/bootstrap` at 1,000 users with many conversations (load-test fixture), before and after.
