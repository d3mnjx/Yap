---
id: C1-79
title: Remux small MP4 uploads with the index at the front (faststart)
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: For an MP4 whose index (moov) sits at the end, the browser needs a second range request before playback can start: about one round trip (900 ms) for the far reader on every first play, plus the body bytes already in flight that it throws away. The one small MP4 upload on disk has its moov at the end.
experiment: none
sources: [backend-media-10]
files: [Yap/Services/Media/VideoService.cs:21-22, Yap/Services/Media/VideoService.cs:153-159, Yap/Endpoints/TusEndpoints.cs:328-348]
---

## What the code does now
- `if (extension == ".mp4" && fileSize <= CompressionThreshold) { ... return (videoPath, 0); }` with `CompressionThreshold = 8 * 1024 * 1024` (VideoService.cs:22, 155-159). Such a file is served as uploaded.
- The compression path uses `-movflags +faststart` (line 169), so only the compressed files have the index at the front.
- Measured on disk (top-level MP4 boxes, read-only): `wwwroot/uploads/97303493-...mp4` is `ftyp, free, mdat, moov` (index at the end). The media-cache files and the voice `.m4a` files are `ftyp, moov, free, mdat`.
- The row's player is `<video preload="none">` (index.html:548), so all of this happens at the tap on play.

## Why it costs the user time
With the moov at the end, the browser requests the file, reads the `mdat` header, aborts, and requests the end of the file to find the index, then requests the start again. On a 900 ms link that is about one extra round trip before the first frame, for every reader and every first play. Phone recorders often write the index at the end.

## The change
In `CompressVideoAsync`, for the small MP4 case, run `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` and replace the file before the URL is handed out. To keep the URL stable under the immutable header, do it in the request (TusEndpoints.cs, next to the poster at line 332), not in the background: a stream copy of 8 MB is disk-bound and takes tens of ms (estimate). Or check the box order first (read the first boxes, as in a tiny helper) and remux only when `moov` follows `mdat`. About 15 lines.

## Risks and what could break
- An in-place change of bytes under an immutable URL would corrupt a range-cached copy in a browser that already fetched part of it. That is why the remux must finish before `Done(...)` hands out the URL. (The existing in-place compression of MP4 files over 8 MB has this risk today; see the note in the final report.)
- A stream copy can fail on unusual files; keep the original when ffmpeg fails.

## How to measure it
Play journey on a throttled link: in DevTools, count the range requests and the time from the tap to the first frame for a phone-recorded MP4 under 8 MB, before and after.