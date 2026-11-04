---
id: C1-23
title: In the bot's message handler, test the message's own channel instead of listing all of the bot's DMs on every message
category: 1
journey: send
effort: S
confidence: high
behaviour-change: none
estimated-gain: Every message sent anywhere (rooms included) runs DmChannelsOf(bot) inside Send before the POST answers: a copy of all channels (ConcurrentDictionary.Values takes all its internal locks), a filter, and a list of every bot DM (one per account). At 1,000 accounts that is a 1,000-entry list per message; an estimated tens of microseconds. Tiny per send, but free to remove.
experiment: none
sources: [backend-services-14]
files: [Yap/Services/Chat/SystemBotService.cs:554-566, Yap/Services/Chat/ChatService.cs:375-376, Yap/Services/Chat/ChatService.cs:537]
---

## What the code does now
```csharp
var channels = _chatService.DmChannelsOf(_botUserId);
var dmChannel = channels.FirstOrDefault(c => c.Id == message.ChannelId);
if (dmChannel == null) return;
```
(`SystemBotService.cs:564-566`), with `DmChannelsOf => _channels.Values.Where(c => c.IsDirectMessage && c.CanAccess(userId)).ToList()` (`ChatService.cs:375-376`). The handler is `async void` and runs synchronously up to its `await Task.Delay(800)`, inside `OnMessageReceived?.Invoke(message)` (`ChatService.cs:537`).

## Why it costs the user time
It adds work to the send path of every message and holds the channel dictionary's locks briefly while other requests read it.

## The change
```csharp
if (_chatService.GetChannel(message.ChannelId) is not { IsDirectMessage: true } dmChannel || !dmChannel.CanAccess(_botUserId)) return;
```
Two lines replace three.

## Risks and what could break
None; same condition, O(1).

## How to measure it
Microbenchmark only; no user-visible metric moves by itself.