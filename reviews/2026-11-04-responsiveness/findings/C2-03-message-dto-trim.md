---
id: C2-03
title: Trim the message row shape: drop the per-row channelId in pages, omit null fields, derive the three image URLs on the client, shorter timestamps
category: 2
journey: switch-room
effort: M
confidence: medium
behaviour-change: none
estimated-gain: A plain text row is 336 bytes of JSON with an empty text, about 113 bytes after trimming (synthetic). 50 rows of chat went from about 19.6 KB to about 11.1 KB raw. Uncompressed on the WebSocket that is about 70 ms less per open at 1 Mbit/s. If finding 01 lands, the gain shrinks to about 0.3 KB per page (deflate removes the same repetition), so do 01 first.
experiment: none
sources: [backend-services-02]
files: [Yap/Models/Chat/MessageDto.cs:10-25, Yap/Models/Chat/MessageDto.cs:39, Yap/Services/Chat/MessageMapper.cs:19-46, Yap/Models/Chat/Conversation.cs:4, Yap/Models/Chat/Pin.cs:11-31]
---

## What the code does now
- `MessageDto` has 15 fields and every row carries all of them: `Id, ChannelId, ClientId, Username, Text, Timestamp, Edited, Kind, ReplyTo, Images, Videos, Gifs, Voice, Reactions, Previews` (`MessageDto.cs:10-25`).
- `Conversation` and `Page` already carry the channel at the top (`Conversation(Guid ChannelId, IReadOnlyList<MessageDto> Messages, ...)`), so each row's `channelId` repeats it 50 times.
- No `DefaultIgnoreCondition` is set on the hub JSON options (`Program.cs:72-74`), so `"clientId":null,"kind":null,"replyTo":null,"voice":null` and the empty arrays go out on every row.
- `ImageDto(string Original, string Medium, string Large, int? Width, int? Height)` (`MessageDto.cs:39`): three URLs per picture, all derived from one upload URL by `ImageService.GetMediumUrl/GetLargeUrl` (`MessageMapper.cs:34-39`).
- `DateTime` goes out with seven fractional digits (`2026-11-04T10:22:33.1234567Z`).
- `PinMedia` has nine optional fields that serialize as null when absent (`Pin.cs:30-31`), on every openRoom.

## Why it costs the user time
The bytes ride the critical path of the rows (see 01). They also grow the device snapshot that the client stores and compares with `JSON.stringify` per row (`ui/timeline.js:43`, client area).

## The change
In order of safety:
1. Mark the nullable members of `MessageDto`, `ReplyToDto`, `PreviewDto`, `PinMedia` with `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` (per type, not globally: `pages/settings.js:354` tests `until === null` on a mute DTO). The client reads these fields with `?.` or truthiness (`m.replyTo`, `m.voice`, `m.kind`).
2. Keep the arrays (the client calls `m.images.length` directly, `store.js:147`, `ui/message.js:111-113`).
3. Drop `channelId` from rows inside `Conversation` and `Page` only, and have the client fill it from the envelope. Live events keep it (`store.js:183`, `notify.js:50`).
4. Send one image URL plus size and let the client derive medium and large (needs the naming rule in the client) - optional.
5. Millisecond timestamps - optional; the client compares timestamps as strings (`store.js:89`, `ui/timeline.js:154`), so every timestamp must keep one fixed format.

## Risks and what could break
- The device's stored rows from the old build differ in shape, so `unchanged` in `ui/timeline.js` fails once and each row redraws once after the deploy.
- Any client code that tests a field with `=== null` on these DTOs breaks; a grep found none on message fields, but the client reader should confirm.
- String comparison of timestamps needs one fixed fraction length; changing the format must keep that.

## How to measure it
Byte size of the `openRoom` completion frame in the browser's WebSocket panel, before and after, on a room with media and replies. `rows` phase under `npm run load`.