---
id: backend-media-15
title: Lower the 30 s limit for turning silent video uploads into animated WebP
area: backend-media
journey: upload
category-guess: 3
behaviour-change: A silent clip between the new limit (for example 10 s) and 30 s stays a video with a play button instead of becoming a looping GIF.
effort: S
estimated-gain: Unknown, needs measurement with real clips. For a 30 s silent clip, the sender waits for a full animated-WebP encode (up to the 120 s timeout) plus a preview encode inside the upload request, and every reader downloads an animated WebP that is likely several times larger than the MP4 (animated WebP has no motion prediction between frames).
confidence: medium
files: [Yap/Endpoints/TusEndpoints.cs:229-298, Yap/Services/Gifs/GifService.cs:457-467, Yap/Services/Gifs/GifService.cs:505-512, Yap/Services/Gifs/GifFfmpegHelper.cs:124-125]
---

## What the code does now
- Every chat video upload with `.mp4`, `.webm`, `.mov` or `.mkv` is probed for the GIF rule (TusEndpoints.cs:231-233).
- `const double MaxGifDurationSec = 30.0;` and `var qualifies = isExplicitGif || (probe is { HasAudio: false, VideoCodec: not null } && probe.DurationSeconds <= MaxGifDurationSec && probe.DurationSeconds > 0);` (GifService.cs:458-466).
- A qualifying clip is transcoded in the request: `produced = await _ffmpeg.TranscodeToAnimatedWebpAsync(sourceFilePath, localPath, ct);` (line 509), at 15 fps, 480 px wide, q75 (GifFfmpegHelper.cs:124-125), with a 120 s timeout (line 17). The preview follows (finding 14).
- The chat row shows the full animated WebP in an `<img>` (message.js:181).

## Why it costs the user time
Animated WebP encodes every frame as an independent picture. A 30 s clip at 15 fps is 450 frames; at 480 px wide, each lossy frame is plausibly 10 to 40 KB (estimate), so the file can be several MB where the MP4 was smaller. The encode of 450 frames takes seconds on the sender's critical path. Every reader of the row downloads the WebP at once (`<img loading="lazy">` in view), with no play button to opt out. A screen recording without sound is a common silent clip.

## The change
GifService.cs:458: use a lower limit for auto-classified clips, for example 10 s, and keep the explicit `kind=gif` path unchanged. One line. Optionally also compare the produced file size with the source and keep the video when the WebP is larger.

## Risks and what could break
- Short silent clips of 10 to 30 s that people meant as GIFs become videos. The user should pick the limit.
- No effect on explicit GIF uploads from the picker.

## How to measure it
Take three real silent clips (5 s, 15 s, 30 s); compare the MP4 size, the produced WebP size and the encode time on the production box. Read the GIF table in Admin for existing entries with `DurationSeconds` over 10 and their `FileSizeBytes`.
