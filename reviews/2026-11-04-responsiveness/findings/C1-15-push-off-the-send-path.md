---
id: C1-15
title: Move the push dispatch off the send request
category: 1
journey: send
effort: S
confidence: medium
behaviour-change: none
estimated-gain: The send POST answers before the push work: a scan of all read states per recipient, the session description strings, and the synchronous part of the WebPush call for the first subscription (payload encryption and VAPID signing in the WebPush library; cost not measured). A few ms for a direct message to someone not looking; unknown, needs measurement.
experiment: none
sources: [backend-request-18, backend-services-12]
files: [Yap/Services/Chat/ChatService.cs:543-546, Yap/Services/Chat/ChatService.cs:619-645, Yap/Services/Chat/ChatService.cs:930-937, Yap/Services/Notifications/PushNotificationService.cs:204-235, Yap/Endpoints/MessagesEndpoints.cs:33-64]
---

## What the code does now
- `Send` ends with `QueuePreviews(message); DispatchPush(channel, request.Username, message); return SendResult.Ok(message);` (ChatService.cs:544-546). The POST handler waits for `Send` (MessagesEndpoints.cs:52-64).
- `DispatchPush` per recipient: `_presence.IsOnlineAndVisible` (presence lock and a session scan), `_presence.Describe` (string building), `_pushService.GetSubscriptionCount`, `TotalUnread(recipient.Id)` (a scan of every read state of every person, lines 930-937), an audit record, then `_ = channel.IsDirectMessage ? _pushService.SendDmNotificationAsync(...) : ...` (lines 619-645).
- `SendToUserAsync` runs synchronously until its first await, which is inside `_webPushClient.SendNotificationAsync(pushSubscription, json, _vapidDetails)` (PushNotificationService.cs:234). It also creates `new JsonSerializerOptions { ... }` per call (lines 221-224).

## Why it costs the user time
The sender's row stays "pending" until the POST answers. Work for other people's notifications runs before that answer. For a room, rooms are muted by default, so usually nobody is a push recipient; for a direct message to a person who is away, one recipient with one or more devices.

## The change
ChatService.cs:545: `_ = Task.Run(() => DispatchPush(channel, request.Username, message));` with a comment: the push is for others and must not delay the sender's answer. Optional: a static `JsonSerializerOptions` in PushNotificationService.

## Risks and what could break
- Exceptions inside DispatchPush then land in an unobserved task; wrap the body in try/catch with a log line.
- The unread count in the push payload is read a moment later; it can include a message sent in between (harmless).

## How to measure it
The `post` wait of AD-26 (ApiLatencyFilter) for direct messages to an away person with a push subscription, before and after.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/12-push-dispatch-off-send-path.md`. The raw files hold their reasoning and numbers.
