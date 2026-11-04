---
id: backend-media-30
title: Warm the per-URL disk lookups at startup instead of on the first openRoom after a restart
area: backend-media
journey: warm-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Small and only after a restart or deploy. The first mapping of each picture or video reads its file header synchronously, and the first mapping of each link lists the media-cache folder and reads two sidecar files, on the request or hub thread. A first page of 50 rows with 20 pictures and 10 links is about 50 small synchronous reads (well under 100 ms on an SSD; more on a slow volume). Unknown, needs measurement.
confidence: low
files: [Yap/Services/Media/MediaSizes.cs:21-38, Yap/Services/Chat/MessageMapper.cs:34-46, Yap/Services/Chat/MediaCacheService.cs:126-158, Yap/Services/Chat/MediaCacheService.cs:502-519, Yap/Services/Chat/ChatService.cs:582-597, Yap/Program.cs:216-221]
---

## What the code does now
- `public (int Width, int Height)? Of(string url) => _sizes.GetOrAdd(url, Read);` (MediaSizes.cs:21), and `Read` does `File.Exists(path)` and `Image.Identify(path)` (lines 26-31), synchronously. The mapper calls it for every picture and video of every mapped message (MessageMapper.cs:37, 44).
- For every link of a text message the mapper calls `GetOrLoadCachedMedia(url)` (ChatService.cs:590), which on its first call per URL runs `Directory.GetFiles(CacheDirectory, $"{hash}.*")` (MediaCacheService.cs:506), then `ReadTitleSidecar` and `ReadDimensionsSidecar` (`File.ReadAllText`, lines 142, 148), synchronously. Both cache their answers in memory, so the cost is once per URL per process.
- Startup already walks every media URL in memory for the poster backfill (`chat.MediaUrls()`, VideoPosterBackfill.cs:17).

## Why it costs the user time
After a deploy, the first users to open each room pay these reads inside their `openRoom` and older-page answers, and the hub thread blocks on disk meanwhile. `Directory.GetFiles` with a pattern lists the whole media-cache folder on most file systems, so its cost grows with the folder.

## The change
At startup, in the background (`Task.Run`, after `ChatService.InitializeAsync`): call `sizes.Of(...)` for the medium and poster URL of every media URL in memory, and let MediaCacheService list its folder once into a `hash -> file` dictionary that `FindOutputFile` uses (updated when a download completes). About 20 lines.

## Risks and what could break
- Startup I/O for a large history; it runs in the background and the existing per-URL path still answers anything not warmed yet.
- The folder index must stay in step with downloads and deletions (one writer: the download task).

## How to measure it
Restart the server, then time the first `openRoom` of a media-heavy room (the admin latency table's `open` wait, AD-26), with and without the warm-up.
