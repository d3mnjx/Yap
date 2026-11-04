---
id: backend-request-15
title: In rooms with a history window, serialize a reaction, card or edit event once, not once per reader
area: backend-request
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Per event in a restricted room with N readers: N argument builds and N serializations become one (reactions, previews) or at most two (replies, edits). Estimated tens of microseconds per reader, so milliseconds for hundreds of readers, on the thread that runs the hub call or the POST. Small for 30 users.
confidence: medium
files: [Yap/Endpoints/ChatHubBroadcaster.cs:45-58, Yap/Endpoints/ChatHubBroadcaster.cs:132-150, Yap/Services/Chat/ChatService.cs:447, Yap/Endpoints/RoomsEndpoints.cs:37, Yap/wwwroot/js/pages/channel-settings.js:34]
---

## What the code does now
- A room is restricted when it has a history window or "since joined": `IsRestricted(Channel channel) => !channel.IsDirectMessage && (channel.HistoryLimit != HistoryLimit.Unlimited || channel.SinceJoined)` (ChatService.cs:447). New rooms get `HistoryLimit.OneMonth` and `SinceJoined = true` by default (RoomsEndpoints.cs:37; the form defaults to `'oneMonth'` and `true`, channel-settings.js:34). The lobby is unrestricted.
- For such a room `ToViewers` loops per person: `foreach (var person in presence.All().Where(s => s.Connected && s.Viewing == channel.Id).GroupBy(s => s.UserId)) { ... Fire(hub.Clients.Clients(...).SendCoreAsync(name, argsFor(person.Key))); }` (ChatHubBroadcaster.cs:145-149). SignalR serializes once per send call, so once per person.
- For `reactions` and `previews` the arguments do not depend on the reader: `_ => [m.Id, map.Reactions(m)]` and `_ => [m.Id, chat.Previews(m)]` (lines 52-53). Each call still rebuilds them (`map.Reactions` takes the reaction lock and groups; `chat.Previews` runs the URL regex).
- For replies and edits, `map.From(m, viewer)` differs only in the quote, by `MayRead(viewer, original)` (MessageMapper.cs:55-65).

## Why it costs the user time
The loop runs inside the service event, so inside the React hub call or the send POST, before they return. The last reader in a busy restricted room gets the event after all the per-person work before it.

## The change
In ChatHubBroadcaster:
- For reactions and previews: compute the arguments once, collect the connection ids of the readers who pass `reads`, and make one `hub.Clients.Clients(ids).SendCoreAsync(name, args)`.
- For replies and edits: split the readers into "may read the original" and "may not", build `map.From(m, viewer)` once per group (any viewer of the group), and send twice at most.
A `ToViewers` overload that takes `object?[] args` instead of `argsFor` keeps the code readable.

## Risks and what could break
The pins event (`ToViewers(c, "pins", viewer => [c.Id, chat.PinsFor(c.Id, viewer)])`, line 58) does depend on the reader (each person's own list); leave it per person.

## How to measure it
A load test room with a one-month window and a few hundred viewers: hub sends per second (the admin load card counts send calls) and the React call time (HubLatencyFilter).
