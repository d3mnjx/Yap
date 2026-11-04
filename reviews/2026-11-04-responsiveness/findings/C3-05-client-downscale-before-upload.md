---
id: C3-05
title: Downscale photos on the device before the upload
category: 3
journey: upload
effort: M
confidence: medium
behaviour-change: The stored original becomes a 2048 px (or similar) JPEG/WebP; the viewer's Download control saves that file instead of the camera original.
estimated-gain: A 3 to 4 MB phone photo becomes about 0.4 to 0.6 MB at 2048 px (estimate). At 1 Mbit/s up that is about 24 to 28 s less per photo for the far sender, and less server decode time (finding 05).
experiment: none
sources: [backend-media-08]
files: [Yap/wwwroot/js/upload.js:60-103, Yap/wwwroot/js/sender.js:144-170, Yap/Endpoints/TusEndpoints.cs:209-227, Yap/Models/Chat/MessageDto.cs:36-39]
---

## What the code does now
- The client uploads the picked file as it is: `new tus.Upload(file, {...})` (upload.js:73). The only checks are type and size (upload.js:9-21).
- The server keeps the original in the uploads folder and serves it as the `Original` of the image (MessageDto.cs:36-39: "Original is the file as uploaded ... which the viewer's Download control saves (TL-24)").
- Rows show only the 800 px file and the viewer the 1600 px file; nothing displays more than 1600 px.

## Why it costs the user time
Upload bandwidth is the largest single cost of a photo send on a slow link: 4 MB at 1 Mbit/s is 32 s, and mobile upload links are often slower than download. Everything after the upload (thumbnail, POST, broadcast) is under 2 s. Only the sender pays, but every photo send pays it.

## The change
In upload.js, before `new tus.Upload`, for `image/jpeg` and `image/png` files wider or taller than 2048 px: draw into an `OffscreenCanvas` (or a canvas) at 2048 px on the long side, `convertToBlob({ type: 'image/jpeg', quality: 0.85 })`, and upload that Blob with the original name. Skip GIF and WebP (animation). Respect EXIF orientation (`createImageBitmap(file, { imageOrientation: 'from-image' })`). About 30 lines. Optionally a "Send original" toggle in the attach menu for people who want the camera file.

## Risks and what could break
- The Download control no longer gives the camera original (TL-24). This is a product decision for the user.
- EXIF data (place, camera) is lost from the stored file; usually a privacy gain.
- Canvas encode on an old phone takes a few hundred ms per photo; it runs while the row already shows as pending, so the user does not wait for it at the tap.
- The offline outbox stores Blobs (sender.js); store the downscaled Blob so a retry does not redo the work.

## How to measure it
Upload journey on a throttled link (1 Mbit/s up): time from tap to "sent" for a 4 MB photo, and the bytes of the PATCH requests.