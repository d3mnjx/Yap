---
id: C2-04
title: Let openRoom answer "unchanged" when the client's tail is current
category: 2
journey: resume
effort: M
confidence: medium
behaviour-change: none
estimated-gain: The whole 50-row tail stays off the wire on an open where nothing changed (most resumes and warm opens of a quiet room). Size unknown; an estimate from MessageDto is 300 bytes of field names, ids and empty arrays per row plus the text, so 15 to 40 KB of uncompressed JSON on the WebSocket, 120 to 320 ms at 1 Mbit/s, plus the JSON parse and the timeline's unchanged-row check on the phone. Needs measurement.
experiment: none
sources: [client-core-03]
files: [Yap/wwwroot/js/pages/chat.js:98-124, Yap/wwwroot/js/store.js:78-101, Yap/wwwroot/js/offline/snapshot.js:109-117, Yap/Endpoints/ChatHub.cs:81-86, Yap/Endpoints/ChatHub.cs:165-172]
---

## What the code does now
Every connect re-opens the conversation (chat.js:61, `hub.onConnected(open)`). `openConversation` (chat.js:106-124) invokes `openRoom` or `openDm` with the channel only. The server's `Open` (ChatHub.cs:165-172) always builds the full tail:

```cs
var (messages, hasMore, restricted) = chat.Tail(channel.Id, PageSize, Me);
chat.EnsurePreviews(messages);
return new Conversation(channel.Id, messages.Select(m => map.From(m, Me)).ToList(), hasMore, restricted, ...);
```

The client then calls `setOpen(result)` (store.js:78-101), which merges older pages and fires a `reset`. The timeline's `unchanged` check (ui/timeline.js, per the perf notes) keeps rows whose JSON did not change, so the bytes and the parse are spent to learn that nothing changed. The stored tail (snapshot.js:109-112) carries no version.

The SignalR protocol is JSON (`Program.cs:72-74`, no MessagePack), and the WebSocket frames are not compressed by the HTTP response compression middleware, so the tail travels at full JSON size.

## Why it costs the user time
On a resume, the device already shows the right rows in most cases (nothing happened in a quiet room while the phone slept). The server still sends 50 rows, each with its id, channel id, client id, timestamp, empty arrays and nulls, plus pins with media. For the far user on 1 Mbit/s the transfer sits on the critical path of the "rows" phase and the catching-up pill. The phone then parses the JSON and compares the rows.

## The change
1. Server: keep one counter per channel in memory, incremented by `ChatService` on every change that shows in a tail (a message added, edited, deleted, a reaction, a preview, a pin). Return it in `Conversation` as `version`.
2. Client: `saveTail` stores `version` with the tail (it already stores the whole conversation object). `openConversation` passes the version it shows: `hub.invoke('openRoom', channelId, state.open?.version ?? null)`.
3. Server: when the version matches and the person's visible window did not move (no time-based history limit, or its cutoff is older than the tail's first row), return the conversation without messages and with `unchanged: true`, plus the typists and pins as today. `MarkRead` and the group join run as today.
4. Client: on `unchanged`, keep `state.open.messages`, clear `fromDevice` (the pill ends), and fire `open` without a `messages` reset.

## Risks and what could break
- Every code path that changes a row must bump the counter; a missed path leaves a stale row on the device until the next change. Tests per event type are needed.
- A restart resets the counters; the server must then answer with a full tail (start the counter at a random value or the process start time).
- History limits (`HistoryLimit`, `SinceJoined`) make the tail per person; the check must include them.
- The `older` pages merge in `setOpen` stays unchanged for the full answer.

## How to measure it
Journey resume on the far link: hide the page for 35 s in a quiet room and return. Measure the bytes of the `openRoom` completion frame (Chrome WebSocket frames panel) and the boot report's `rows` minus `socket`. Repeat with a 50k-message room and with a room with link previews (bigger rows).