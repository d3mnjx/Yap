---
id: C2-20
title: Let the client ask for larger older pages (for example 100 to 150 rows) when it scrolls back
category: 2
journey: older
effort: S
confidence: medium
behaviour-change: none
estimated-gain: Each older page is one hub round trip (about 900 ms for the far user) for 50 rows. A reader who scrolls back through 300 messages waits for 6 round trips today and 2 to 3 with pages of 100 to 150. With 01 in place a 150-row page is about 13 KB compressed (about 100 ms at 1 Mbit/s), so the extra bytes cost far less than the saved round trips. Needs a client change to request the size and keep its prefetch distance.
experiment: none
sources: [backend-services-21]
files: [Yap/Endpoints/ChatHub.cs:26, Yap/Endpoints/ChatHub.cs:102-107, Yap/Services/Chat/ChatService.cs:405-409]
---

## What the code does now
`private const int PageSize = 50;   // TL-01, TL-06` (`ChatHub.cs:26`); `Older(Guid channelId, DateTime beforeTimestamp, Guid beforeId)` always returns up to 50 rows (`:102-107`). The client calls `hub.invoke('older', open.channelId, oldest.timestamp, oldest.id)` (`js/ui/timeline.js:246`, client area).

## Why it costs the user time
Scrolling back is a chain of round trips; on the far link each one is a visible stall at the top of the list.

## The change
Add an optional `int? count` parameter to `Older`, clamped to, for example, 25..200, default 50 (old clients unchanged). The client asks for more when it scrolls fast or when the link is slow (it knows its RTT from the heartbeat). TL-06 in the spec may need a wording change if it fixes 50.

## Risks and what could break
- A larger page means more rows to render at once on a phone (client area: render cost per row).
- Server work per call grows linearly (mapping, card lookups); still small.

## How to measure it
The `older` wait (AD-26) per page and the number of `older` calls per scroll-back session, under the 900 ms throttle.