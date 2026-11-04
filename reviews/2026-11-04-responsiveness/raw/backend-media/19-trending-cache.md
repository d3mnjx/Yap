---
id: backend-media-19
title: Keep the first page of Klipy trending in memory for a few minutes
area: backend-media
journey: picker-gif
category-guess: 3
behaviour-change: The trending grid can be up to a few minutes older than Klipy's live list.
effort: S
estimated-gain: Removes the server-to-Klipy request from the first picker open of every user after the first in the window. Its latency is unknown (the server logs every Klipy call; the log has the timestamps), plausibly 100 to 500 ms.
confidence: medium
files: [Yap/Endpoints/GifEndpoints.cs:30-35, Yap/Services/Gifs/GifService.cs:293-306, Yap/Services/Gifs/KlipyGifProvider.cs:54-61, Yap/Services/Gifs/KlipyGifProvider.cs:169-267]
---

## What the code does now
- Every first picker open per page load calls `/api/gifs/trending` (gif-picker.js:49), and every tap on Browse calls it again with `reset` (line 63).
- The route awaits the provider each time: `var page = await lib.GetTrendingAsync(cursor, ProviderPage, ct);` (GifEndpoints.cs:33), which builds the URL and does `client.GetAsync(url, ct)`, reads the whole body as a string and parses it (KlipyGifProvider.cs:169-188). The rating is the same for every user (an admin setting).
- `RememberShown` records the items so that a send can use the server's copy (GifService.cs:300-306).

## Why it costs the user time
The picker's Browse grid waits for the client round trip plus the server's Klipy round trip. The trending list is the same for every user of the server with the same rating, and it changes slowly.

## The change
In `GifService.GetTrendingAsync`, for `cursor == null` only: keep the last result with its time, and answer from it when it is younger than, for example, 5 minutes. Still call `RememberShown(result)` on every answer so the send check keeps working. About 10 lines. Optionally warm it when the first user connects.

## Risks and what could break
- Freshness: a GIF that just entered Klipy's trending shows a few minutes later.
- A rating change by the admin must clear the cache (or key it by the rating).
- Klipy's terms may say something about caching API results; check before shipping.

## How to measure it
Read the "Klipy HTTP 200 for ... trending" log lines for their duration, or time the route. Journey "picker-gif": time to the first trending card on a throttled link.
