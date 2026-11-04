---
id: backend-media-05
title: Decode JPEGs at a reduced size for the 800 px thumbnail (ImageSharp DecoderOptions.TargetSize)
area: backend-media
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown, needs measurement on the production box. The memory note imagesharp-stays-on-3 records 1.4 s in ImageSharp for the two thumbnails of a 3.9 MB JPEG on the dev box (two full decodes). A JPEG decode at half scale handles a quarter of the pixels, so the 800 px thumbnail, which the last PATCH waits for, could drop by several hundred ms per photo. Less memory per decode too (the 2026-10-15 crash was concurrent decodes).
confidence: low
files: [Yap/Services/Media/ImageService.cs:47-70, Yap/Endpoints/TusEndpoints.cs:307-311]
---

## What the code does now
- The final PATCH of a picture waits for the 800 px thumbnail: `await imageService.GenerateMediumThumbnailAsync(filePath);` (TusEndpoints.cs:310), before `Done(...)`.
- The thumbnail decodes the whole original: `using var image = await Image.LoadAsync(originalPath); image.Mutate(x => x.AutoOrient());` (ImageService.cs:59-60), then resizes with Lanczos3 to 800 px wide (lines 97-102).
- One decode at a time for the whole process: `private static readonly SemaphoreSlim Gate = new(1, 1);` (line 29).

## Why it costs the user time
The sender's row stays "uploading" until the PATCH answers, and the message POST starts only after it. A 12 MP phone JPEG is about 4000x3000 pixels; a full decode of 12 million pixels, then a Lanczos3 resize from 4000 to 800, is most of the server time of a photo send. With several photos in one message, the gate makes them wait for each other, so the last photo waits for the sum.

## The change
In `GenerateSingleThumbnailAsync`, load with a target size for the medium thumbnail only:
`var options = new DecoderOptions { TargetSize = new Size(size * 2, size * 2) }; using var image = await Image.LoadAsync(options, originalPath);`
The JPEG decoder of ImageSharp 3 then decodes at the largest DCT scale (1/2, 1/4, 1/8) that still covers the target, and the existing resize to 800 px wide runs on the smaller bitmap. The bounding box of twice the size keeps the final dimensions the same as today for any EXIF orientation (the box applies before `AutoOrient`). For the 1600 px file (background) leave the code as it is. About 5 lines.

## Risks and what could break
- PNG and WebP sources gain nothing (no scaled decode); the code path is the same.
- The picture goes through two resamplers (the decoder's, then Lanczos3). At 2x the target size the visual difference is negligible; compare a few photos.
- The exact ImageSharp 3.1 behaviour of `TargetSize` for JPEG (scaled IDCT then resize to the box) should be checked in a unit test that asserts the output size for a rotated (EXIF 6) photo.

## How to measure it
Time `GenerateMediumThumbnailAsync` for real phone JPEGs (3 to 5 MB) on the production box, before and after (the upload log already stores a duration: `SetCompressDuration`, TusEndpoints.cs:320). Journey "upload": time from the last byte to the PATCH answer.
