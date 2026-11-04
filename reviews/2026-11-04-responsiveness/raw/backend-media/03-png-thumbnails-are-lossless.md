---
id: backend-media-03
title: Encode thumbnails as lossy WebP; PNG uploads give lossless 800 px files of 600 to 800 KB
area: backend-media
journey: all
category-guess: 3
behaviour-change: Screenshots and other PNG pictures in rows and in the viewer become lossy WebP; fine text can show light artefacts at high zoom.
effort: S
estimated-gain: Measured on the files in Yap/wwwroot/uploads, the three real PNG pictures give 800 px thumbnails of 590 KB, 758 KB and 818 KB. A lossy WebP of 800 px is typically 60 to 150 KB (estimate, not measured here). For the far reader that is about 4 to 6 s less per PNG picture row at 1 Mbit/s, and more for the 1600 px viewer file (2.78 MB for one of them).
confidence: high
files: [Yap/Services/Media/ImageService.cs:21, Yap/Services/Media/ImageService.cs:81-106, Yap/Services/Media/ImageService.cs:135-173]
---

## What the code does now
- `private static readonly WebpEncoder WebpEncoder = new() { Quality = 90 };` (ImageService.cs:21). `FileFormat` is not set.
- ImageSharp 3 then takes the format from the source's metadata: a PNG source maps to lossless WebP, a JPEG source to lossy.
- Measured on disk (a script over Yap/wwwroot/uploads, read-only): all 150 thumbnails made from PNG sources are lossless (`VP8L` chunk); all 4 made from JPEG sources are lossy (`VP8 `). The three non-trivial PNG uploads:
  - 832x1216 PNG, 1.33 MB: 800 px file 818 KB (VP8L), 1600 px file 872 KB.
  - 1536x1536 PNG, 5.53 MB: 800 px file 758 KB (VP8L), 1600 px file 2.78 MB.
  - 1024x1024 PNG, 1.59 MB: 800 px file 590 KB (VP8L), 1600 px file 949 KB.
- The same encoder writes the 128 px profile pictures (ImageService.cs:164), so a PNG avatar is lossless too.
- The EXIF profile is kept in the thumbnails (EXIF chunks of 95 to 1,206 bytes in the samples).

## Why it costs the user time
The row shows the 800 px file (`src: img.medium`, message.js:142). Pasted screenshots arrive as `image/png` (upload.js:15), and phone screenshots are PNG too, so this is a common case. Every reader downloads the lossless file. The far reader pays about 8 ms per KB: 818 KB is about 6.5 s for one picture. The viewer's 1600 px file is worse. The sender is not affected; every reader is, on every device, once per picture.

## The change
ImageService.cs:21: `new() { Quality = 85, FileFormat = WebpFileFormatType.Lossy }` (needs `using SixLabors.ImageSharp.Formats.Webp;`, already there). Optionally clear the metadata before saving (`image.Metadata.ExifProfile = null;` after `AutoOrient`, which already applied the orientation). One or two lines. Existing thumbnails stay as they are; only new uploads change.

## Risks and what could break
- Visible quality: lossy WebP on text screenshots can blur thin text a little. Quality 85 to 90 is usually safe for screenshots. The user should look at a few real screenshots before and after.
- The memory note `gif-webp-normalization` says ImageSharp's lossy WebP encoder gives poor quality per byte on animated content. Still images at 800 px are a different case, and the JPEG-sourced thumbnails already use this encoder (125 KB for an 800x800 picture in the samples).
- PNGs with transparency: lossy WebP keeps an alpha channel, so stickers and logos stay transparent.

## How to measure it
Upload the same three PNGs before and after on a dev build; compare the `_800px.webp` sizes and look at them side by side. Journey "all" for a far reader: bytes per picture row in DevTools.
