---
id: backend-services-06
title: Stop scanning every message in memory for the quick reactions on every bootstrap, reaction and emoji pick
area: backend-services
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One call walks every message of every conversation, takes each channel lock and each message's reaction lock, and allocates two LINQ iterators per message. At 50,000 messages that is an estimated 5 to 15 ms per call (not measured). It runs in every bootstrap (every connect and reconnect), inside every React hub call before it returns, and inside every EmojiUsed call. During the scan of one conversation its lock blocks sends, edits and page reads of that conversation.
confidence: high
files: [Yap/Services/Chat/ChatService.cs:868-893, Yap/Services/Chat/ChatService.cs:717-736, Yap/Services/Accounts/UserService.cs:663-677, Yap/Endpoints/ChatHubBroadcaster.cs:71-72, Yap/Endpoints/BootstrapEndpoints.cs:63, Yap/Endpoints/ChatHub.cs:136, Yap/Endpoints/ChatHub.cs:148]
---

## What the code does now
```csharp
foreach (var (channelId, messages) in _channelMessages)
    lock (LockOf(channelId))
        foreach (var message in messages)
            lock (message.Reactions)
                mine.AddRange(message.Reactions.Where(r => r.UserId == userId).Select(r => r.Emoji));
return mine.GroupBy(e => e).OrderByDescending(g => g.Count()).Take(count)...
```
(`ChatService.cs:887-892`). Callers:
- the bootstrap: `chat.QuickReactions(me.Id)` (`BootstrapEndpoints.cs:63`);
- every reaction: `ToggleReaction` calls `_userService.RecordEmojiUse` (`ChatService.cs:733`), which raises `OnRecentEmojiChanged` (`UserService.cs:676`), and the broadcaster's handler calls `chat.QuickReactions(userId)` synchronously (`ChatHubBroadcaster.cs:71-72`), all inside the `React` hub call (`ChatHub.cs:136`);
- every picker pick: `EmojiUsed` -> `RecordEmojiUse` (`ChatHub.cs:148`).

## Why it costs the user time
The bootstrap is on the critical path of a first load and runs at every reconnect; after a deploy every client runs it at once, so the scans add up. The reaction answer and the `me` event wait for the scan. The channel locks held by the scan delay sends into the busiest rooms.

## The change
Cache the per-person reaction counts and update them in place:
- `ConcurrentDictionary<Guid, Dictionary<string, int>> _reactionCounts`, filled lazily by the existing scan for one person on first need.
- `ToggleReaction`: if the person's counts are cached, add or subtract 1 under a lock on that dictionary.
- `Delete`, `Purge`, `RemoveAccount`: `_reactionCounts.Clear()` (rare events; the next call rescans lazily).
- `QuickReactions` reads the top three from the cached counts.
About 20 lines in `ChatService.cs`. A comment says which events must clear the cache.

## Risks and what could break
A missed invalidation path shows stale quick reactions until the next restart. The paths that remove reactions are the three listed; `GenerateTestMessages` adds messages without reactions and needs nothing.

## How to measure it
Time `/api/bootstrap` on the server with 50,000 messages loaded (generate them with AD-08), before and after; time the `React` hub call (HubLatencyFilter flags calls over 100 ms).
