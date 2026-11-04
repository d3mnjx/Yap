---
id: C1-80
title: Run background ffmpeg and yt-dlp work at a lower CPU priority
category: 1
journey: all
effort: S
confidence: low
behaviour-change: none
estimated-gain: Unknown, needs measurement on a small server. A preset-medium x264 encode uses every core for seconds to minutes; while it runs, every API request, hub call and broadcast competes with it for the CPU. On a 1 to 2 core VPS this can add tens to hundreds of ms to each request of every user during the encode.
experiment: none
sources: [backend-media-12]
files: [Yap/Services/Media/VideoService.cs:209-237, Yap/Services/Gifs/GifFfmpegHelper.cs:175-206, Yap/Services/Chat/MediaCacheService.cs:709-745, Yap/Services/Chat/MediaCacheService.cs:776-808, Yap/Services/Chat/MediaCacheService.TikTok.cs:244-247]
---

## What the code does now
- Every external process starts at normal priority with no thread limit: `var psi = new ProcessStartInfo("ffmpeg", args) { ... };` (VideoService.cs:211), `RunProcessAsync` (GifFfmpegHelper.cs:178), `RunYtDlpAsync` (MediaCacheService.cs:714), `RunProcessAsync` (MediaCacheService.cs:778).
- Background jobs that use them: video compression at `-preset medium` (VideoService.cs:169), H.264 re-encode of cached media at `-preset fast` (MediaCacheService.cs:316), TikTok slideshow render (TikTok.cs:244-247), GIF transcodes and preview backfills (GifService.cs:177, 953-958).
- Video compression has no concurrency limit: each video upload starts its own encode (TusEndpoints.cs:334).

## Why it costs the user time
x264 and libwebp use all cores by default. Kestrel's request threads and the SignalR broadcaster then share the CPU with the encoder at the same priority. Every user's sends, opens and reactions slow down while someone's video encodes. The cost grows on small servers and with two videos at once.

## The change
After `Process.Start` for background work, set `process.PriorityClass = ProcessPriorityClass.BelowNormal` (on Linux this maps to a higher nice value), wrapped in try/catch. Do it in `VideoService.RunFfmpegAsync` for the compression, and in the MediaCacheService runners. Keep normal priority for the steps a user waits for in the request (poster, voice transcode, GIF transcode of an upload). Optionally add `-threads 2` to the compression. About 10 lines.

## Risks and what could break
- Background encodes take longer when the server is busy, which delays when a compressed video or a cached link video is ready.
- Setting the priority can throw on some platforms or containers without the capability to lower it; the try/catch keeps the job running.

## How to measure it
On a 2-core box, upload a 100 MB video, and during the encode measure the latency of `/api/bootstrap` and the hub `send` wait (the admin latency table, AD-26), with and without the change.