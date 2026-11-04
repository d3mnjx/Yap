---
id: backend-request-20
title: Find a direct message by its two people with a dictionary, not a copy and scan of all conversations
area: backend-request
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Each openDm and each send to /api/dm/{username}/messages stops copying every conversation (rooms and direct messages) into a new list under all of the dictionary's locks. At 10,000 conversations an estimated 50 to 100 us per call; nothing at 30 people.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:359-374, Yap/Endpoints/ChatHub.cs:88-93, Yap/Endpoints/MessagesEndpoints.cs:25-30]
---

## What the code does now
- `GetOrCreateDm(Guid userId, Guid otherUserId)`: `if (_channels.Values.FirstOrDefault(c => c.IsDMBetween(userId, otherUserId)) is { } existing) return existing;` (ChatService.cs:362). `_channels` is a `ConcurrentDictionary`; its `Values` property takes every bucket lock and copies all values into a new list before the scan.
- Called by the `OpenDm` hub call (ChatHub.cs:90) and by every direct-message send through `/api/dm/{username}/messages` (MessagesEndpoints.cs:25-30), which the client uses for messages queued offline (OF-08).
- `DmChannelsOf` (line 375) also scans `_channels.Values` for the bootstrap's direct-message list.

## Why it costs the user time
The cost grows with the number of conversations on the server, not with the person. Taking all bucket locks also blocks concurrent writers of `_channels` for that moment. A scale item; small for one user.

## The change
Add `ConcurrentDictionary<(Guid, Guid), Guid> _dmByPair` keyed by the ordered pair (smaller Guid first). Fill it in InitializeAsync, add in GetOrCreateDm when it creates, remove in Purge. `GetOrCreateDm` looks up the pair first. For `DmChannelsOf`, enumerating the dictionary directly (`foreach (var (_, c) in _channels)`) avoids the lock-all copy without a new index.

## Risks and what could break
Two DM channels between the same two people would map to one; the code already treats the first match as the conversation, so behaviour stays.

## How to measure it
Load tool with 1,000 users and many direct messages: the `post` wait for direct messages and the openDm call time.
