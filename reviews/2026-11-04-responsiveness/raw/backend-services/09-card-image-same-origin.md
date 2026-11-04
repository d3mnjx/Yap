---
id: backend-services-09
title: Cache the card picture (og:image) on this server and send its local URL and size, instead of making each client fetch it from the remote site
area: backend-services
journey: switch-room
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: A card picture from a host the phone has not contacted costs a DNS lookup, a TCP handshake and a TLS handshake before the first byte, about 3 round trips, which is about 2.7 s for the far user (900 ms RTT), plus the picture itself on the remote site's terms (often a large original). From this origin it rides the open HTTP/2 connection, immutable and cache-first in the worker. The card also gets its box size, so the row does not grow when the picture arrives.
confidence: medium
files: [Yap/Services/Chat/LinkPreviewService.cs:234-283, Yap/Services/Chat/ChatService.cs:582-597, Yap/Models/Chat/MessageDto.cs:54-56, Yap/Endpoints/MessagesEndpoints.cs:35-38]
---

## What the code does now
- The scrape stores the remote `og:image` URL as is: `preview.ImageUrl = ExtractMetaContent(html, "og:image");` (`LinkPreviewService.cs:249`).
- `PreviewDto(string Url, string? SiteName, string? Title, string? Description, string? ImageUrl, PreviewMediaDto? Media)` carries it to the client with no width or height (`MessageDto.cs:54`).
- The client sets it as `img.src` directly (`ui/message.js:243`, `:258`) and as a video poster fallback (`:265`).
- The send route refuses remote media in messages for privacy ("a tracking pixel for everyone who reads the room", `MessagesEndpoints.cs:35-36`); the card picture is a remote image in every reader's browser all the same.

## Why it costs the user time
Each distinct card host is a new connection for every reader. On the far link, the card's picture appears seconds after the text, the card box changes size when it loads, and on cellular each new TLS connection costs radio time. The service worker caches `/media-cache/` cache-first, but not third-party images.

## The change
After a successful scrape, download the `og:image` in the same background task (the "MediaFetch" client already exists and is SSRF-guarded, `Program.cs:124-129`), cap its size, re-encode to a small WebP (ImageSharp is already used), store it content-addressed under `/media-cache/` (immutable headers and cache-first already apply), and set `ImageUrl` to the local URL plus `ImageWidth`/`ImageHeight` in `PreviewDto`. Keep the remote URL as a fallback until the local copy exists. Pair with 08 so the local URL survives a restart.

## Risks and what could break
- Disk use and CPU for re-encoding; needs a size cap and the existing media-cache eviction.
- Some hosts block hotlink downloads by Referer or user agent; keep the remote URL as fallback.
- Copyright and caching policy are a product question.

## How to measure it
Resource timing of card images (the Settings debug card already lists image timings) on a far link: time from row render to image load, before and after; count distinct hosts contacted during a room open.
