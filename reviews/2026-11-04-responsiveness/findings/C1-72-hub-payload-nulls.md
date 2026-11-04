---
id: C1-72
title: Leave null fields (and later empty lists) out of the message rows on the socket, which SignalR does not compress
category: 1
journey: switch-room
effort: S
confidence: medium
behaviour-change: none
estimated-gain: A 50-row tail from the dev database is 17,890 B on the socket (gzip would make it 2,850 B, but WebSocket frames are not compressed). Dropping nulls saves about 40 to 56 B per row, 2 to 2.8 KB per tail (about 20 ms at 1 Mbit/s). Dropping empty lists too (category 2, client change) saves about 3 KB more. Paid on every open, switch, reconnect, resume and older page, and on every broadcast row.
experiment: none
sources: [backend-request-11]
files: [Yap/Program.cs:72-74, Yap/Models/Chat/MessageDto.cs:10-56, Yap/Services/Chat/MessageMapper.cs:19-28, Yap/Models/Chat/Conversation.cs:4, Yap/wwwroot/js/store.js:147-160, Yap/wwwroot/js/ui/timeline.js:43]
---

## What the code does now
- The hub uses the JSON protocol with one converter: `.AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)))` (Program.cs:73). No `DefaultIgnoreCondition`, so every null and every empty list is written.
- `MessageDto` has 15 members (MessageDto.cs:10-25); a plain text row carries `"clientId":null` (when absent), `"kind":null`, `"replyTo":null`, `"voice":null`, `"images":[]`, `"videos":[]`, `"gifs":[]`, `"reactions":[]`, `"previews":[]`, and its `channelId`, which the `Conversation` also carries (Conversation.cs:4).
- The ASP.NET Core 10.0.14 assembly `Microsoft.AspNetCore.Http.Connections.dll` contains no compression option (searched for "Compression" and "DangerousEnableCompression": 0 hits). So the WebSocket frames go uncompressed; Caddy and Cloudflare pass them through.
- Sample: 50 rows of the largest conversation in Data/yap.db, mapped to this shape inside a SignalR completion message: 17,890 B. Average text was 52 B per row.

## Why it costs the user time
The socket carries the tail on every open. On 1 Mbit/s, 18 KB is about 145 ms of transfer on the critical path of the rows; roughly a quarter of it is null and empty-list fields.

## The change
Step 1 (category 1): put `[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` on the nullable members of `MessageDto` and its nested records (`ClientId`, `Kind`, `ReplyTo`, `Voice`, the `Width`/`Height` pairs, the optional preview fields). Attributes on the DTOs, not a global option, so the HTTP answers that the client tests with `=== null` (settings.js:354, invite.js:84) keep their shape. A grep of the client found no `=== null` test on message fields; `m.kind`, `!!m.voice`, `m.replyTo` are truthiness tests.
Step 2 (category 2): emit no empty lists (the mapper returns null for an empty list, and the same attribute drops it), and add one normalizing function in store.js at the message entry points (`m.images ??= []` and so on), because store.js and ui/message.js read `m.images.length` directly (store.js:147).

## Risks and what could break
- `unchanged` in timeline.js compares rows with `JSON.stringify` (timeline.js:43). After the deploy, stored rows (with nulls) differ from the server's rows once, so every row redraws once per device.
- The device snapshot stores rows; old snapshots still have nulls. Both shapes must render.
- The send POST returns the same `MessageDto` over HTTP; the attributes apply there too, which is consistent.

## How to measure it
Chrome DevTools, WS frames: size of the openRoom completion before and after. The `rows` phase on the throttled link with a 50-row conversation.