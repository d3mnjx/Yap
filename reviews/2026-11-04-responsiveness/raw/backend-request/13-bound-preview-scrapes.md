---
id: backend-request-13
title: Bound the number of link-card scrapes that run at once
area: backend-request
journey: older
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown, needs measurement. Today one page of 50 history rows can start up to 250 page downloads at once (5 links per row), each reading up to 2 MB, on the server's shared link and CPU.
confidence: medium
files: [Yap/Services/Chat/LinkPreviewService.cs:21-25, Yap/Services/Chat/LinkPreviewService.cs:134-165, Yap/Services/Chat/ChatService.cs:566-578, Yap/Endpoints/ChatHub.cs:102-107, Yap/Endpoints/ChatHub.cs:165-172, Yap/Program.cs:106-120]
---

## What the code does now
- `QueueFetch` dedupes by URL and then starts `_ = Task.Run(async () => { var preview = await FetchPreviewAsync(url); ... })` (LinkPreviewService.cs:134-165). Nothing limits how many run together.
- `FetchPreviewAsync` reads the page until `</head>`, up to `MaxResponseBytes = 2 * 1024 * 1024` ("YouTube's head alone is ~715KB", lines 22-25), then runs regexes over it.
- `EnsurePreviews` queues a fetch for every link without a cached card, up to `MaxLinksPerMessage = 5` per row (ChatService.cs:566-578). The hub calls it for every tail (`Open`, ChatHub.cs:169) and every older page (`Older`, ChatHub.cs:105).
- MediaCacheService limits its yt-dlp downloads with `_downloadSemaphore`; LinkPreviewService has no such limit.

## Why it costs the user time
A person who scrolls up through a link-heavy history asks for a page of 50 rows every few seconds. Each page can start tens to hundreds of downloads of several hundred KB each. On a small server or a home uplink these bursts use the bandwidth and CPU that every user's answers also need, so other users' sends and opens slow down. The cards of the rows on screen also compete with the cards of rows already scrolled past.

## The change
LinkPreviewService: `private static readonly SemaphoreSlim _fetchSlots = new(4);` and in the `Task.Run` body `await _fetchSlots.WaitAsync(); try { ... } finally { _fetchSlots.Release(); }`. Four is a starting value; the comment should say it bounds the server's outbound burst, not the client's wait. About 5 lines.

## Risks and what could break
During a burst, the last cards of a page arrive later than today (they wait for a slot). The `_inFlight` dedupe stays correct because the URL is added before the wait.

## How to measure it
Scroll up through 10 pages of a link-heavy room; watch the server's network throughput and the thread-pool queue in /api/admin/load, and another client's `send` wait at the same time.
