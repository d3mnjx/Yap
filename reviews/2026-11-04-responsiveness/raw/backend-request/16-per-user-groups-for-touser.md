---
id: backend-request-16
title: Send per-person events through a per-person group instead of Clients.User, which scans every connection
area: backend-request
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Each per-person send goes from a pass over all connections to a lookup. A room message with 1,000 recipients puts up to 1,000 unread keys into the next 250 ms tick: about 1.5 million user-id comparisons at 1,500 connections in one tick (estimate, a few ms). Nothing measurable at 30 users.
confidence: medium
files: [Yap/Endpoints/ChatHubBroadcaster.cs:94-110, Yap/Endpoints/ChatHubBroadcaster.cs:112-130, Yap/Endpoints/ChatHubBroadcaster.cs:163, Yap/Endpoints/ChatHub.cs:34-67]
---

## What the code does now
- `private void ToUser(Guid userId, string name, params object?[] args) => Fire(hub.Clients.User(userId.ToString()).SendCoreAsync(name, args));` (ChatHubBroadcaster.cs:163).
- The unread tick calls it once per person and conversation: `foreach (var key in _unread.Keys) if (_unread.TryRemove(key, out var count)) ToUser(key.User, "unread", key.Channel, count);` (line 103), every 250 ms.
- Other callers: `me` (lines 65, 69, 72, 73), `dm` (116-117), `gifFavorites` (74), `pending` (78), `gifImport` (80). Direct-message events use `hub.Clients.Users(new[] { ... })` (line 127).
- The default SignalR lifetime manager (one server, no backplane) implements a user send as a pass over all its connections, comparing each connection's user id (ASP.NET Core source, DefaultHubLifetimeManager.SendUserAsync; not verified against 10.0.14 here). Group sends go only to the group's members.

## Why it costs the user time
The tick is one loop on one thread. Its length grows with recipients times connections, and every unread badge and presence change in that tick waits for it. At load-test scale (the 2026-10-18 test had 1,000 to 1,500 connections) this is the same class of cost the broadcaster's comments describe for presence and typing.

## The change
- ChatHub.OnConnectedAsync: `await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(Me));` with `public static string UserGroup(Guid id) => $"user:{id}";` next to `Group(channelId)`. SignalR removes the membership when the connection ends. (OnConnectedAsync becomes async.)
- ChatHubBroadcaster: `ToUser` uses `hub.Clients.Group(ChatHub.UserGroup(userId))`; the direct-message branch of `ToChannel` uses `hub.Clients.Groups([UserGroup(p1), UserGroup(p2)])`.

## Risks and what could break
- Code that still calls `Clients.User` elsewhere keeps working (the user identifier stays).
- A connection that fails during OnConnectedAsync before the group add receives no per-person events; it is closed anyway.
- AccountEndpoints and AdminEndpoints send `signedOut` with `Clients.Client(connectionId)`; no change.

## How to measure it
The 1,000-user load tool (loadtest/): tick duration (Stopwatch around the loop body in SendBatchesAsync) and HubSendsPerSec before and after; a real tab's badge delay during a busy room.
