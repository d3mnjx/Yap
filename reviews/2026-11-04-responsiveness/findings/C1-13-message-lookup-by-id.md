---
id: C1-13
title: Index messages by id; GetMessage scans the conversation's list on every lookup
category: 1
journey: switch-room
effort: S
confidence: medium
behaviour-change: none
estimated-gain: Each lookup goes from a scan of the conversation (up to 5,000 rows with the default load bound, more since the restart, everything with persistence off) to a dictionary hit. Estimated 10 to 15 us per lookup at 5,000 rows and over 100 us at 50,000. A tail full of replies does up to 50 lookups; a reply in a restricted room does one per reader.
experiment: none
sources: [backend-request-17, backend-services-15]
files: [Yap/Services/Chat/ChatService.cs:40-43, Yap/Services/Chat/ChatService.cs:415-433, Yap/Services/Chat/ChatService.cs:457-461, Yap/Services/Chat/ChatService.cs:690-704, Yap/Services/Chat/MessageMapper.cs:55-65]
---

## What the code does now
- `_channelOfMessage` maps a message id to its conversation id (ChatService.cs:43). `GetMessage` then scans: `lock (LockOf(channelId)) return messages.FirstOrDefault(m => m.Id == messageId);` (lines 457-461). `Delete` does the same scan (line 698).
- Callers: `MessageMapper.ReplyTo` for every row with a quote (MessageMapper.cs:58), so per tail, per older page and, in restricted rooms, per reader of a broadcast; `ToggleReaction` (line 720), `Edit` (668), `Pin` (746), `RaisePreviewsReady` (604), `Send` for a reply and for a repeated clientId (497, 507), `RefreshPinMedia` at start (851).
- `Page` finds the older-page cursor with `all.FindIndex(m => m.Id == cursor.Id)` from the start, and the history cutoff with `all.FindIndex(m => m.Timestamp >= c)` (lines 422-426).

## Why it costs the user time
Every scan holds the conversation's lock, which the sends into that conversation also take. With long histories the cost per call grows linearly. The far user does not feel microseconds, but a busy room multiplies them (tails with replies, reaction taps, per-reader broadcast mapping).

## The change
- Replace `_channelOfMessage` (`ConcurrentDictionary<Guid, Guid>`) by `ConcurrentDictionary<Guid, ChatMessage> _messageById`. The conversation id is `message.ChannelId`. Update it in the same places that update `_channelOfMessage` today (InitializeAsync, Send, AddSystemLine, Delete, Purge, GenerateTestMessages).
- `GetMessage` becomes `_messageById.GetValueOrDefault(messageId)`. `Delete` removes by reference (`messages.Remove(message)` is still a scan; acceptable for a rare action).
- Optional: in `Page`, `BinarySearch` by timestamp for the cutoff (the list is in time order: Send appends `DateTime.UtcNow`, the test generator sorts).

## Risks and what could break
The index must stay in step with the lists. `GetMessage` today also checks that the list still holds the message; with the index, Delete must remove from the index under the same lock order as today (list lock, then index).

## How to measure it
A unit benchmark of `Open` on a conversation of 5,000 and 50,000 rows with replies. In the field: openRoom times in the HubLatencyFilter slow events.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/15-message-lookup-by-id.md`. The raw files hold their reasoning and numbers.
