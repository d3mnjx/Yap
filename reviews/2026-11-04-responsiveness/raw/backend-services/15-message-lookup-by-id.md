---
id: backend-services-15
title: Find a message by id with a dictionary, and find the older-page cursor from the end, instead of scanning the conversation's list under its lock
area: backend-services
journey: switch-room
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: GetMessage scans the whole conversation list from its start under the conversation lock. It runs for every reply row of every page and every broadcast (the quote), every reaction, edit, pin, previews-ready event and every send that is a reply. In a room of 20,000 to 50,000 messages each call is an estimated 20 to 100 microseconds; a page of 50 rows with 20 replies is about 1 to 2 ms under the lock, and the older-page cursor adds another full scan. Small per call; it grows with history and blocks sends into the same room while it runs.
confidence: high
files: [Yap/Services/Chat/ChatService.cs:43, Yap/Services/Chat/ChatService.cs:411-432, Yap/Services/Chat/ChatService.cs:457-461, Yap/Services/Chat/ChatService.cs:613-617, Yap/Services/Chat/MessageMapper.cs:55-58]
---

## What the code does now
- `_channelOfMessage` maps a message id to its channel id only (`ChatService.cs:43`), so `GetMessage` then scans: `lock (LockOf(channelId)) return messages.FirstOrDefault(m => m.Id == messageId);` (`:460`).
- The mapper calls it for each reply row: `var original = chat.GetMessage(id);` (`MessageMapper.cs:58`).
- The older cursor: `end = all.FindIndex(m => m.Id == cursor.Id);` (`:422`), a scan from index 0, although the cursor is the oldest loaded row and usually near the end.
- The restricted-room cutoff: `all.FindIndex(m => m.Timestamp >= c)` from index 0 (`:426`) on every open of a room with a history window.
- `RepliesTo` scans the whole list on every edit (`:613-617`).

## Why it costs the user time
These scans run on the hub and HTTP threads, under the per-conversation lock that `Send` also takes, so a long scan delays the next message into that room. The cost grows with the history the instance keeps in memory (no load bounds, see 28).

## The change
1. Change `_channelOfMessage` to `ConcurrentDictionary<Guid, ChatMessage> _messageById` (same add and remove sites: `Send`, `AddSystemLine`, `GenerateTestMessages`, `InitializeAsync`, `Delete`, `Purge`). `GetMessage` becomes a lookup; callers that need the channel use `m.ChannelId`.
2. `Page`: `all.FindLastIndex(m => m.Id == cursor.Id)` (scans 50, 100, 150 rows for successive pages instead of n).
3. The cutoff: optional binary search on `Timestamp` (the list is in send order; concurrent sends can swap two rows by a millisecond, so walk back while the previous row is still >= the cutoff).
About 15 lines.

## Risks and what could break
- `GetMessage` today returns null for a message removed from the list but still in `_channelOfMessage`; with the dictionary, removal must happen in the same places (it does today for `_channelOfMessage`).
- Memory: one more reference per message (8 bytes plus dictionary overhead), about 2 MB at 50,000 messages.

## How to measure it
Server time of `openRoom` and `older` on a room with 50,000 generated messages and many replies (HubLatencyFilter flags slow calls; add a debug Stopwatch).
