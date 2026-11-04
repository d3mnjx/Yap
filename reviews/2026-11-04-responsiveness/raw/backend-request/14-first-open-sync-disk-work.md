---
id: backend-request-14
title: Avoid synchronous disk work in openRoom after a restart (image sizes, media-cache directory scans)
area: backend-request
journey: resume
category-guess: 1
behaviour-change: none
effort: M
estimated-gain: Unknown, needs measurement. Per new image URL one `File.Exists` plus an ImageSharp `Image.Identify` read; per new link URL one enumeration of the whole Data/media-cache directory plus sidecar reads. Paid once per URL per process, inside the hub call, and by many clients at once in the reconnect wave after a deploy.
confidence: medium
files: [Yap/Services/Media/MediaSizes.cs:14-38, Yap/Services/Chat/MessageMapper.cs:34-46, Yap/Services/Chat/MediaCacheService.cs:126-158, Yap/Services/Chat/MediaCacheService.cs:164-175, Yap/Services/Chat/MediaCacheService.cs:502-529, Yap/Services/Chat/ChatService.cs:575, Yap/Services/Chat/ChatService.cs:590]
---

## What the code does now
- `MediaSizes.Of(url) => _sizes.GetOrAdd(url, Read)`; `Read` does `File.Exists(path)` and `Image.Identify(path)` synchronously (MediaSizes.cs:21-38). `ConcurrentDictionary.GetOrAdd` can run the factory more than once for the same key under concurrency.
- MessageMapper calls it for every image and video poster of every mapped row (MessageMapper.cs:34-46): tails, older pages and broadcasts.
- `GetOrLoadCachedMedia(url)`, on a first miss, calls `FindOutputFile(hash)`, which runs `Directory.GetFiles(CacheDirectory, $"{hash}.*")` (MediaCacheService.cs:506), an enumeration of the whole cache folder; then `ReadTitleSidecar`, `ReadDimensionsSidecar` and `File.Exists(PosterPath(hash))` (lines 142-150). Misses are remembered in `_notOnDisk`, hits in `_cache`.
- It is called for every link without cached media by `ChatService.Previews` (line 590), which the mapper calls per row, and by `QueueDownload` (line 174) from `EnsurePreviews` (line 575) and from the send path (`QueuePreviews`).
- `IsKnownMediaExtension` accepts 8 extensions (MediaCacheService.cs:521-529).

## Why it costs the user time
After a restart all memory caches are empty. The first openRoom of each conversation does this disk work synchronously on a thread-pool thread before it answers. After a deploy, many clients open the same lobby within seconds and each repeats the same reads (no in-flight sharing). Blocked pool threads delay every other request and hub call until the pool grows. The far user's first rows after a deploy come later.

## The change
- MediaCacheService.FindOutputFile: probe the 8 known extensions with `File.Exists(Path.Combine(CacheDirectory, hash + ext))` instead of enumerating the folder. Same answer (video first), constant cost.
- Warm the two caches in the background once the server listens: `app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(() => { foreach (var room in chat.Rooms()) { var (rows, _, _) = chat.Tail(room.Id, 50, adminOrSystemViewer); foreach (var m in rows) map.From(m, null); } }))`. A small public `WarmTails()` method on ChatService or MessageMapper reads better than this inline lambda.
- Optional: wrap the `MediaSizes` factory in `Lazy<T>` so concurrent callers share one read.

## Risks and what could break
The warm-up competes with the first real requests for disk; it runs after Kestrel listens and is bounded by rooms x 50 rows. The `Tail` call needs a viewer id; use one that sees everything (the admin's id or a dedicated internal path) and do not raise events (Tail raises none).

## How to measure it
After a restart: the HubLatencyFilter slow events (over 100 ms) on openRoom in the admin diagnostics, and the thread-pool thread count and queue in /api/admin/load during the reconnect wave. A Stopwatch around `FindOutputFile` with a media-cache folder of a production size.
