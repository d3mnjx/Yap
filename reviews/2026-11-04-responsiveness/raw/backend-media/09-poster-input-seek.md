---
id: backend-media-09
title: Seek before the input for the video poster frame
area: backend-media
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown, needs measurement. Today ffmpeg decodes every frame of the first second before it writes the poster; with input seeking it starts at the keyframe before 1 s. For a 4K HEVC phone clip on a small CPU this could be up to about a second of the final PATCH, which the sender waits for.
confidence: low
files: [Yap/Services/Media/VideoService.cs:99-134, Yap/Endpoints/TusEndpoints.cs:328-348]
---

## What the code does now
- The final PATCH of a video waits for the poster: `await videoService.GeneratePosterAsync(filePath);` (TusEndpoints.cs:332).
- `var args = $"-i \"{videoPath}\" -ss 00:00:01 -frames:v 1 -vf \"scale=800:-2\" -y \"{posterPath}\"";` (VideoService.cs:110). `-ss` after `-i` is output seeking: ffmpeg decodes and drops every frame up to 1 s.
- When that fails (a clip shorter than 1 s) a second ffmpeg run takes the frame at 0 s (lines 113-118).
- The source is the original upload, for example a 4K HEVC `.mov` from an iPhone.

## Why it costs the user time
Every video send waits for this step before the message can be posted. Decoding 30 to 60 frames of 4K HEVC in software takes noticeable CPU time on a small server. The sender pays; the receivers see the message that much later.

## The change
VideoService.cs:110: put `-ss 00:00:01` before `-i` (input seeking). ffmpeg then seeks to the keyframe before 1 s and decodes only from there. Keep the 0 s fallback; a clip shorter than 1 s still produces no frame on the first run. One line.

## Risks and what could break
- Input seeking picks the frame nearest after the keyframe position, accurate to the frame with modern ffmpeg (it decodes from the keyframe to the exact time). The poster may differ by a frame or so from today's.
- The same function serves the media-cache posters (`EnsurePosterAsync`, MediaCacheService.cs:629-635) and the backfill; both gain the same way.

## How to measure it
Time `GeneratePosterAsync` for a real iPhone 4K clip and an Android 1080p clip on the production box, before and after.
