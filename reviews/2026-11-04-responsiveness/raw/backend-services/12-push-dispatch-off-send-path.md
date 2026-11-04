---
id: backend-services-12
title: Run DispatchPush in the background after the send's events, not inside the POST
area: backend-services
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Per recipient who is not looking, the send POST now pays a scan of all read states (TotalUnread), a scan of all sessions (IsOnlineAndVisible, Describe), a scan of all push subscriptions (GetSubscriptionCount), and the synchronous part of the first web-push send, which encrypts the payload and signs the VAPID token with BouncyCastle P-256 (WebPush 1.0.13). The crypto is an estimated 3 to 30 ms per recipient depending on the CPU (not measured). A DM to an away person pays it once; a room message pays it once per person who unmuted the room. The far user's POST answer comes back that much later, and so does the "Post" wait in AD-26.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:544-546, Yap/Services/Chat/ChatService.cs:619-659, Yap/Services/Chat/ChatService.cs:930-937, Yap/Services/Notifications/PushNotificationService.cs:193-194, Yap/Services/Notifications/PushNotificationService.cs:205-259, Yap/Services/Notifications/PushSubscriptionStore.cs:143-157, Yap/Services/Presence/PresenceService.cs:361-365, Yap/Services/Presence/PresenceService.cs:466-475, Yap/Yap.csproj]
---

## What the code does now
`Send` ends with `QueuePreviews(message); DispatchPush(channel, request.Username, message); return SendResult.Ok(message);` (`ChatService.cs:544-546`). `DispatchPush` loops over recipients and, for each one, on the request thread:
```csharp
var lookingNow = _presence.IsOnlineAndVisible(recipient.Id);   // two session scans under the presence lock
var sessions = _presence.Describe(recipient.Id);               // another scan, builds a string for the audit
var subscriptions = _pushService.GetSubscriptionCount(recipient.Username);   // scans all subscriptions
var totalUnread = TotalUnread(recipient.Id);                   // scans all read states
...
_ = channel.IsDirectMessage ? _pushService.SendDmNotificationAsync(...) : _pushService.SendRoomNotificationAsync(...);
```
(`ChatService.cs:626-642`). The returned task is not awaited, but `SendToUserAsync` runs synchronously up to its first real await: it scans the subscriptions again (`PushNotificationService.cs:214`), builds a new `JsonSerializerOptions` per call (`:222-225`), and calls `_webPushClient.SendNotificationAsync(...)` (`:234`), whose request building (payload encryption with an ephemeral ECDH key, VAPID JWT signature) runs before its HTTP await. The package is `WebPush` 1.0.13 (`Yap.csproj`), which depends on Portable.BouncyCastle.

## Why it costs the user time
The sender's client waits for the POST answer to confirm the row. Everything above happens after the broadcast, so other readers are not delayed, but the sender's confirmation is.

## The change
In `Send`, replace the call with `_ = Task.Run(() => DispatchPush(channel, request.Username, message));` (the unread counts it reads are already incremented). Same for the push part of the bot's sends, which go through `Send`. Also hoist the `JsonSerializerOptions` in `SendToUserAsync` into a static field. About 5 lines. Comment: push work must never sit between the send and its answer.

## Risks and what could break
- Exceptions in `DispatchPush` would surface on a background task; wrap it in try/catch with a log line.
- The audit row order may interleave differently between concurrent sends; it is a diagnostic.

## How to measure it
The "Post" wait per person in the admin Latency table (AD-26) for DMs to people who are away, before and after; or a Stopwatch around `DispatchPush` logged at debug level.
