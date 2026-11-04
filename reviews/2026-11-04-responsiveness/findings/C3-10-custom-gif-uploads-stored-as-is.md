---
id: C3-10
title: Re-encode large .gif uploads with ffmpeg's native libwebp, which the image already ships
category: 3
journey: all
effort: S
confidence: low
behaviour-change: A large uploaded GIF is shown as an animated WebP capped at 480 px and 15 fps; small GIFs stay as they are.
estimated-gain: Unknown, needs measurement on real GIFs. A multi-MB GIF re-encoded as animated WebP is commonly 2 to 5 times smaller. Chat uploads allow up to the 100 MB upload cap and the picker allows 50 MB per GIF; every reader of the row downloads the full file.
experiment: none
sources: [backend-media-26]
files: [Yap/Services/Gifs/GifService.cs:469-512, Yap/Services/Gifs/GifFfmpegHelper.cs:119-125]
---

## What the code does now
- `.gif` and `.webp` uploads are copied as they are: `if (sourceExt is ".gif" or ".webp") { ... File.Copy(sourceFilePath, localPath, overwrite: true); ...}` (GifService.cs:480-504). Only video sources go through `TranscodeToAnimatedWebpAsync` (15 fps, 480 px, q75, GifFfmpegHelper.cs:124-125).
- The memory note `gif-webp-normalization` records why: an in-process ImageSharp re-encode gave poor quality per byte and was removed; "If revisiting: use a NATIVE libwebp tool". It also notes the unsolved decode cost of multi-MB files on cold loads.
- ffmpeg's `libwebp` encoder is the native libwebp, and the Dockerfile ships the static ffmpeg 9.0, which decodes GIF (any version) and animated WebP (9.0 and later).

## Why it costs the user time
A custom GIF row loads the original file. A 10 MB GIF is 80 s at 1 Mbit/s for every far reader, and phones decode every frame of it. The upload path already runs ffmpeg for the picker preview of the same file (line 570), so the tool is in place.

## The change
For a `.gif` source above a threshold (for example 2 MB), run `TranscodeToAnimatedWebpAsync(sourceFilePath, localPath)` instead of the copy, and keep the result only when it is smaller than the source; otherwise copy as today. Leave `.webp` sources alone (ffmpeg's animated-WebP decode is newer; the preview path already relies on it, so this could follow later). About 15 lines. The encode then sits on the upload's critical path; move the preview to the background at the same time (finding 14).

## Risks and what could break
- Quality and timing change: 15 fps and 480 px caps. Pixel-art GIFs may suffer from lossy encoding (q75); a lossless or higher-quality setting for small palettes could be a follow-up.
- The content hash for deduplication is taken from the source today (line 485); keep it that way so re-imports still converge.
- The user declined new tools before; this uses only ffmpeg, which is present. Confirm with the user anyway, as the memory note asks.

## How to measure it
Run the transcode by hand on ten real GIFs over 2 MB from the uploads folder: size before and after, and a side-by-side look.