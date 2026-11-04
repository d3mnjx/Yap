---
id: backend-media-07
title: Add a 400 px picture size for gallery cells of two and three per row
area: backend-media
journey: all
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: A gallery cell is at most about 198 CSS px wide but loads the 800 px file, four times the pixels a DPR-2 screen needs. For a four-picture message of 100 KB files, about 400 KB becomes about 100 to 130 KB, about 2 s less for the far reader per such message in view (estimate; bytes scale roughly with pixels).
confidence: medium
files: [Yap/Services/Media/ImageService.cs:16-18, Yap/Services/Chat/MessageMapper.cs:34-39, Yap/Models/Chat/MessageDto.cs:39, Yap/wwwroot/js/ui/message.js:138-157, Yap/wwwroot/css/message.css:427-463]
---

## What the code does now
- Two sizes exist: `SizeMedium = 800` and `SizeLarge = 1600` (ImageService.cs:17-18).
- Every gallery cell uses the 800 px file: `const attrs = { src: img.medium, ... loading: 'lazy', width: 800, height: single ? 600 : 800, ...}` (message.js:142).
- The gallery is at most 400 px wide (`max-width: 400px`, message.css:427). With two or three pictures per row (`ROWS`, message.js:136), each cell is a square of about 198 or 130 CSS px (`.gallery-row .gallery-image { width: 100%; aspect-ratio: 1; object-fit: cover; }`, message.css:456-463).

## Why it costs the user time
A message with 2 to 10 pictures loads 2 to 10 files of 800 px for cells of 130 to 198 CSS px. At DPR 2 a 400 px file covers a 198 px cell. The far reader pays the bytes of every cell in view; phones also decode bitmaps four times larger than needed, which costs memory and main-thread decode time while scrolling a history with many pictures.

## The change
- ImageService: a third size, `SizeSmall = 400`, generated in the background task next to the 1600 px one (TusEndpoints.cs:313-326), so the send path does not wait for it.
- MessageMapper/ImageDto: add `Small` (`GetSizedUrl(url, 400)`).
- message.js: use `img.small` for cells when `m.images.length > 1`, with `onerror` falling back to `img.medium` (the small file is missing for old uploads and for a few seconds after a new one).
- A backfill for old uploads, like `VideoPosterBackfill`, is optional; the fallback covers them.

## Risks and what could break
- A reader who opens the room within a second of the send may request the small file before it exists and fall back to the medium file (one extra failed request).
- The SW media cache stores both sizes for pictures seen in both forms.
- DPR-3 phones get 400 px for a 198 px cell (2x instead of 3x). The difference is hard to see at that size, but a designer should look.

## How to measure it
Journey "older" and "warm-open" in a room with many multi-picture messages: bytes per screen in DevTools on a throttled link, and decode time in a performance trace on a phone.
