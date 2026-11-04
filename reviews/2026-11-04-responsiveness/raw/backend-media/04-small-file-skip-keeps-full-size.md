---
id: backend-media-04
title: Resize every picture wider than the target, also files under 500 KB
area: backend-media
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: For an affected picture, the 800 px file has the pixels of the original instead of 800 px. A 1170 px wide phone screenshot under 500 KB gives a 1170 px "800 px" file with 2.1 times the pixels needed; the bytes scale roughly with the pixels. The share of such uploads is unknown; 4 of the 154 local test thumbnails are wider than 800 px for this reason.
confidence: medium
files: [Yap/Services/Media/ImageService.cs:23-24, Yap/Services/Media/ImageService.cs:72-79, Yap/Services/Media/ImageService.cs:81-87]
---

## What the code does now
- `private const int SmallFileThreshold = 500 * 1024;` (ImageService.cs:24) with the comment "Skip processing for small files (already optimized)".
- `var skipResizing = new FileInfo(originalPath).Length < SmallFileThreshold;` (line 77).
- `if (skipResizing || image.Width <= size) { await image.SaveAsync(thumbPath, WebpEncoder); }` (lines 83-87): a small file is re-encoded at its full width, for the 800 px file and the 1600 px file alike.
- Measured: 4 local thumbnails named `_800px.webp` are 1000 px, 1600 px and 900x1600 (test images under 500 KB).

## Why it costs the user time
The decision uses the byte size, not the pixel size. A JPEG photo of 400 KB can be 2000 px wide, and a flat screenshot of 300 KB can be 1170x2532. The row shows the file in a box of at most 400 CSS px wide and 350 px tall (message.css:427, 471), so the extra pixels only cost bytes and decode time. Every reader pays, the far reader most, and phones also pay the decode of the bigger bitmap.

## The change
Delete the threshold and the `skipResizing` flag: resize whenever `image.Width > size` (keep `Mode = ResizeMode.Max`). About 5 lines in ImageService.cs. The re-encode already happens for small files, so the server does the same work plus one resize.

## Risks and what could break
- None visible: the row draws the picture at the same CSS size, and the viewer uses the 1600 px file.
- The row box comes from the medium file's size (`MediaSizes`, MessageMapper.cs:36-38), so new uploads get smaller numbers in `width` and `height`; the CSS uses only their ratio and a cap (message.css:487-490).

## How to measure it
Upload a 1170x2532 screenshot under 500 KB; compare the `_800px.webp` size and pixel size before and after.
