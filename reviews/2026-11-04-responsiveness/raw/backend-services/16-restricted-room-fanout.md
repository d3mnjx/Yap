---
id: backend-services-16
title: In rooms with a history window, send reactions and cards in one call to all readers, and messages with at most two variants, instead of one mapping and one serialization per person
area: backend-services
journey: send
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Rooms created by the admin default to a one-month window with "since joined" (RoomRequest defaults), so most rooms are restricted. In such a room every reaction toggle, card arrival, edit and reply goes out as one SendCoreAsync per person, each with its own argument build and JSON serialization. With 500 people viewing, one reaction is 500 groupings and 500 serializations on the reacting user's hub thread before React returns, instead of one. Estimated a few ms per event at 500 viewers (not measured); the event also reaches each reader later because the sends go out one by one.
confidence: medium
files: [Yap/Endpoints/ChatHubBroadcaster.cs:44-58, Yap/Endpoints/ChatHubBroadcaster.cs:135-151, Yap/Services/Chat/ChatService.cs:434-455, Yap/Endpoints/RoomsEndpoints.cs:37-38]
---

## What the code does now
- `ToViewers` for a restricted room: `foreach (var person in presence.All().Where(s => s.Connected && s.Viewing == channel.Id).GroupBy(s => s.UserId)) { if (reads is not null && !reads(person.Key)) continue; Fire(hub.Clients.Clients(...).SendCoreAsync(name, argsFor(person.Key))); }` (`ChatHubBroadcaster.cs:145-149`).
- For reactions and cards the arguments ignore the viewer: `_ => [m.Id, map.Reactions(m)]` and `_ => [m.Id, chat.Previews(m)]` (`:52-53`), yet they are rebuilt and serialized per person. `chat.Previews(m)` runs the URL regex each time.
- For edits and replies, `map.From(m, viewer)` builds a full DTO per person (`:48-50`); the only viewer-dependent part is whether the quote is readable (`MessageMapper.cs:62`).
- `RoomRequest(..., HistoryLimit HistoryLimit = HistoryLimit.OneMonth, bool SinceJoined = true, ...)` (`RoomsEndpoints.cs:37`), and `IsRestricted` is true for any window or "since joined" (`ChatService.cs:447`).

## Why it costs the user time
SignalR caches the serialization per send call, not across calls, so N calls mean N serializations. All of it runs synchronously inside the hub call that raised the event (`React`, `Edit`) or inside the preview task.

## The change
In `ToViewers`, collect the connection ids of the people who pass `reads`, then:
- if `argsFor` does not depend on the viewer (reactions, previews, pins of an unrestricted view): one `hub.Clients.Clients(all).SendCoreAsync(name, argsFor(null))`;
- for `message`/`messageEdited` with a reply: split the readers by `MayRead(viewer, original)` into two lists and send two variants.
Pass a flag (or two overloads) so the call sites state whether the args depend on the viewer. About 20 lines in one file.

## Risks and what could break
The pins event (`:58`) does depend on the viewer (each person's list is filtered by their cutoff); keep it per person or group by cutoff.

## How to measure it
`HubSendsPerSec` in `/api/admin/load` during a reaction burst in a restricted room with many viewers; server time of the `React` call.
