---
id: C1-71
title: Cut the quoted original in ReplyToDto to about 300 characters
category: 1
journey: switch-room
effort: S
confidence: high
behaviour-change: none
estimated-gain: Up to about 4 KB less per reply row that quotes a long message (MaxTextLength is 4000), in every page, every reply broadcast and every stored snapshot. Typical gain is small and depends on how often people reply to long messages; unknown, needs a count.
experiment: none
sources: [backend-services-03]
files: [Yap/Services/Chat/MessageMapper.cs:55-65, Yap/Services/Chat/ChatService.cs:53, Yap/Services/Chat/ChatService.cs:599-600]
---

## What the code does now
`ReplyTo` copies the whole original text into every reply row:
```csharp
return new ReplyToDto(id, original.Username, string.IsNullOrEmpty(original.Content) ? null : original.Content, original.HasMedia, original.HasVoice, Unavailable: false);
```
(`MessageMapper.cs:64`). A message may hold 4,000 characters (`ChatService.cs:53`). The client shows the quote in one line on desktop (`css/message.css:269-273`: `white-space: nowrap; text-overflow: ellipsis`) and two lines on a phone (`css/message.css:1287-1292`: `-webkit-line-clamp: 2`), and it runs the whole text through `inline()` for emoji and links (`ui/message.js:69`).

## Why it costs the user time
Bytes nobody can see travel on the critical path of the rows and in the stored snapshot, and the phone parses and renders the hidden part of the quote (emoji images included) for each reply row.

## The change
Use the existing helper: `Cut(original.Content, 300)` (the same helper cuts card descriptions, `ChatService.cs:599-600`; make it internal or copy the one line into the mapper). One line in `MessageMapper.cs:64`.

## Risks and what could break
- A cut inside an emoji shortcode or a URL renders a half token, but only beyond the visible clamp.
- The composer's local pending row may build `replyTo` with the full text; the server row replaces it at confirmation anyway.

## How to measure it
Count reply rows and their quote lengths in a real room (admin can query the DB once). Compare openRoom frame size on a room with replies to long messages.