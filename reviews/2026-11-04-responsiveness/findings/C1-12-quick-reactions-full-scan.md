---
id: C1-12
title: Cache the quick reactions per person instead of scanning every message in memory
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: Removes a scan of every message of every conversation in memory from every bootstrap (every connect) and from every React and EmojiUsed hub call. Estimated 50 to 100 ns per message (a lock and two LINQ iterators), so about 2.5 to 5 ms per call at 50,000 messages in memory and 25 to 50 ms at 500,000, plus that many short-lived allocations. Not measured.
experiment: none
sources: [backend-request-02, backend-services-06]
files: [Yap/Services/Chat/ChatService.cs:868-893, Yap/Endpoints/BootstrapEndpoints.cs:63, Yap/Endpoints/ChatHubBroadcaster.cs:71-72, Yap/Endpoints/ChatHub.cs:136, Yap/Endpoints/ChatHub.cs:148, Yap/Services/Chat/ChatService.cs:732-733, Yap/Services/Accounts/UserService.cs:663-677]
---

## What the code does now
- `TopReactionEmojis` walks every list of every conversation, takes each channel lock and each message's reaction lock:
  `foreach (var (channelId, messages) in _channelMessages) lock (LockOf(channelId)) foreach (var message in messages) lock (message.Reactions) mine.AddRange(message.Reactions.Where(r => r.UserId == userId).Select(r => r.Emoji));` (ChatService.cs:884-892).
- `QuickReactions(userId)` calls it (ChatService.cs:872-880).
- The bootstrap calls it for every request: `Emoji: new EmojiStateDto(users.GetRecentEmojis(me.Username), chat.QuickReactions(me.Id))` (BootstrapEndpoints.cs:63). The client fetches the bootstrap after every connect (hub.js:119-120).
- `React` (ChatHub.cs:136) calls `ToggleReaction`, which calls `_userService.RecordEmojiUse(userId, emoji)` (ChatService.cs:733). `EmojiUsed` (ChatHub.cs:148) calls it directly. `RecordEmojiUse` raises `OnRecentEmojiChanged` synchronously (UserService.cs:676). The broadcaster handler runs `chat.QuickReactions(userId)` again (ChatHubBroadcaster.cs:72). All of this runs before the hub call returns.
- The memory holds up to 5,000 messages per conversation within 90 days with the default config (appsettings.json:63), and everything since the restart with persistence off.

## Why it costs the user time
The cost grows with the whole server's history, not with the person. Each reaction tap and each picker pick waits for it before the hub answers. Each connect pays it in the bootstrap. After a deploy every client reconnects at once, so the scans stack up on the thread pool while each takes the channel locks that sends also need. A user with a 50,000-message history pays it on each of these calls; so does everyone on a big server.

## The change
In ChatService:
- `private readonly ConcurrentDictionary<Guid, List<string>> _quick = new();`
- `QuickReactions(userId)` returns `_quick.GetOrAdd(userId, id => Compute(id))`, where `Compute` is today's code.
- `ToggleReaction` removes the entry of that user after the change (`_quick.TryRemove(userId, out _)`), before `RecordEmojiUse`, so the `me` event carries the new list.
- `Delete`, `Purge` and `RemoveAccount` clear the whole cache (`_quick.Clear()`): a removed message can change anyone's counts, and these are rare.
About 10 lines. The rule (reactions only, padded with the three defaults) stays the same.

## Risks and what could break
A missed invalidation shows a stale quick bar until the next reaction of that person. The places that change reactions or remove messages are the four named above (check `GenerateTestMessages`: it adds messages without reactions, so no change). The memory `quick-reactions-from-reaction-history` notes that ties fall to scan order; the cache keeps that order.

## How to measure it
Stopwatch around `QuickReactions` in a debug build, or the HubLatencyFilter slow-event count for `React` (over 100 ms) on a server with a large memory load. Journey: reaction tap on a phone with a far link (the reaction ack time), and the bootstrap request time in the RequestLogs CSV right after a deploy.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/06-quick-reactions-full-scan.md`. The raw files hold their reasoning and numbers.
