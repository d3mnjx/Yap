---
id: backend-media-11
title: A .mov video row points at an .mp4 that exists only after the background encode; remux H.264 .mov at once
area: backend-media
journey: upload
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Today a .mov video does not play for anyone until a full x264 encode at preset medium finishes (seconds to minutes; the timeout is 10 min). For a .mov that already holds H.264, a stream copy makes the .mp4 URL valid inside the upload request (estimate: under a second for a 100 MB file, disk-bound). Unknown how many uploads are H.264 .mov; needs a look at the upload log.
confidence: medium
files: [Yap/Services/Chat/MessageMapper.cs:41-46, Yap/Services/Media/VideoService.cs:86-93, Yap/Services/Media/VideoService.cs:141-207, Yap/Endpoints/TusEndpoints.cs:328-348]
---

## What the code does now
- The row's video source is always the .mp4 name: `new VideoDto(poster, VideoService.GetCompressedUrl(url), ...)` (MessageMapper.cs:45), and `GetCompressedUrl` turns `/uploads/{guid}.mov` into `/uploads/{guid}.mp4` (VideoService.cs:88-93).
- For a .mov, that .mp4 is written by the background task: `_ = Task.Run(async () => { var (compressedPath, durationMs) = await videoService.CompressVideoAsync(filePath); ...` (TusEndpoints.cs:334-346).
- The encode is `-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart -vf "scale='min(1280,iw)':-2"` with a 10 min timeout (VideoService.cs:169-170). The original .mov is deleted after (line 183).
- Until then the static file handler answers 404 for the .mp4 (the immutable header is only set for files that exist).

## Why it costs the user time
Readers see the poster at once, but a tap on play fails until the encode ends. For a one-minute 4K clip on a small server the encode can take minutes. The sender's message is "sent", yet the video does not work for anyone during that time. iPhones upload `.mov`; many of them hold H.264 (the "Most Compatible" camera setting, or the transcode iOS does when Safari picks from the photo library), which every browser plays.

## The change
In TusEndpoints.cs, for a `.mov` (or `.mkv`) upload: probe the video codec (`GifFfmpegHelper.ProbeAsync` already returns `VideoCodec`; the GIF check probes this file anyway at line 254). When it is `h264` and the file is at most 8 MB, stream-copy it to the `.mp4` name (`-c copy -movflags +faststart`) before `Done(...)`, and skip the background encode, like the small-MP4 rule. For bigger or HEVC files keep today's encode. About 25 lines in VideoService and TusEndpoints.

## Risks and what could break
- AAC audio in the .mov copies into MP4 fine; other audio codecs (PCM from some cameras) do not stream-copy into MP4. Fall back to the encode when the copy fails.
- The size cap keeps the "big files get compressed" goal.
- A complete fix for the 404 window of HEVC files (for example a temporary link to the original) is a separate design question.

## How to measure it
Upload an iPhone .mov (H.264) and time from "sent" to the first successful play on a second device. Read the media upload log for the share of .mov uploads and their codecs (ffprobe on the stored files).
