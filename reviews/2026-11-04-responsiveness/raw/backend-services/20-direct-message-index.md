---
id: backend-services-20
title: Index direct messages by the pair of people, so opening, sending to and listing DMs stop scanning every conversation
area: backend-services
journey: switch-room
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: GetOrCreateDm scans all channels for the pair on every openDm and every POST /api/dm/{username}/messages; DmConversations (every bootstrap) and DmChannelsOf (bot welcome, account deletion) scan all channels too. The bot opens a DM with every new account, so channels grow with accounts (1,000 accounts means 1,000 or more channels). Estimated tens of microseconds per call plus a full copy of the channel dictionary (ConcurrentDictionary.Values takes every internal lock). Low per call.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:359-393, Yap/Endpoints/ChatHub.cs:88-93, Yap/Endpoints/MessagesEndpoints.cs:25-29, Yap/Endpoints/BootstrapEndpoints.cs:60]
---

## What the code does now
- `if (_channels.Values.FirstOrDefault(c => c.IsDMBetween(userId, otherUserId)) is { } existing) return existing;` (`ChatService.cs:362`).
- `DmChannelsOf(userId) => _channels.Values.Where(c => c.IsDirectMessage && c.CanAccess(userId)).ToList();` (`:375-376`), used by `DmConversations` for the bootstrap (`:384`, `BootstrapEndpoints.cs:60`).
- `OpenDm` calls `GetOrCreateDm` (`ChatHub.cs:90`); the DM send route calls it per message (`MessagesEndpoints.cs:27`).

## Why it costs the user time
Each call copies and filters the whole channel table on a request thread. Not large alone; it is part of the per-bootstrap and per-send cost that grows with the number of accounts.

## The change
`ConcurrentDictionary<(Guid, Guid), Channel> _dmByPair` keyed by the two ids in a fixed order, plus `ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Channel>> _dmsByUser`. Fill them in `GetOrCreateDm` (creation), `InitializeAsync` and remove in `Purge`. Two concurrent first opens of the same pair must not create two channels: use `GetOrAdd` with a lazy value, or a lock around the create (today two parallel first opens can also race and create two; the index makes it easy to close).

## Risks and what could break
The create path changes; a race test (two parallel `OpenDm` for a new pair) should be added.

## How to measure it
Server time of `/api/bootstrap` and `openDm` with 2,000 channels in memory.
