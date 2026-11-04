---
id: backend-services-22
title: Warm picture sizes and cached-media lookups for the newest rows in the background after start, so the first opens after a deploy do not read the disk on the hub thread
area: backend-services
journey: switch-room
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: After a restart the first mapping of each picture reads the file header from disk (File.Exists plus ImageSharp Identify) and the first mapping of each link enumerates the media-cache directory (Directory.GetFiles with a pattern lists the whole folder on Linux). Both run synchronously inside openRoom, older and the live broadcast. A 50-row page with many pictures or links after a deploy may spend tens to a few hundred ms here (not measured; depends on disk and folder size). It happens once per file per process, exactly during the post-deploy reconnect storm.
confidence: medium
files: [Yap/Services/Chat/MessageMapper.cs:34-46, Yap/Services/Chat/ChatService.cs:582-597, Yap/Services/Media/MediaSizes.cs:21-38, Yap/Services/Chat/MediaCacheService.cs:126-158, Yap/Services/Chat/MediaCacheService.cs:502-511, Yap/Program.cs:217-221]
---

## What the code does now
- The mapper asks `sizes.Of(medium)` for every picture and `sizes.Of(poster)` for every video (`MessageMapper.cs:37`, `:44`). `MediaSizes.Of` is `_sizes.GetOrAdd(url, Read)`, and `Read` does `File.Exists(path)` and `Image.Identify(path)` (`MediaSizes.cs:21-32`).
- `ChatService.Previews(m)` calls `_mediaCacheService.GetOrLoadCachedMedia(url)` for each link without a cached player (`ChatService.cs:590`), whatever the media-caching setting. On a first sight it runs `FindOutputFile(hash)` = `Directory.GetFiles(CacheDirectory, $"{hash}.*")` (`MediaCacheService.cs:506`), then reads sidecar files and maybe a poster (`:142-150`). Negative answers are cached (`_notOnDisk`).
- Startup already warms other things in order (`Program.cs:217-221`: the ffmpeg probe, GIF entries, pin media, the poster backfill), but not these two.

## Why it costs the user time
These reads sit inside the hub call whose answer the user waits for, and they happen on the first opens after a deploy, when every client opens a room at the same time.

## The change
After `app.Start` (or as a background task started where `VideoPosterBackfill.Start()` is called), walk the last 50 messages of each conversation and call `sizes.Of(...)` for each picture and poster and `GetOrLoadCachedMedia(url)` for each link. About 15 lines. Separately (MediaCacheService owner): build an in-memory set of the media-cache file names once at start, so `FindOutputFile` needs no directory listing.

## Risks and what could break
- Startup disk I/O competes with the first requests; run it at low priority and in one pass.
- `GetOrLoadCachedMedia` may queue a lazy describe (ffprobe) for incomplete entries; that already happens on first sight today.

## How to measure it
Server time of the first `openRoom` per room after a restart (HubLatencyFilter slow events; a debug Stopwatch), on a room with many pictures and links.
