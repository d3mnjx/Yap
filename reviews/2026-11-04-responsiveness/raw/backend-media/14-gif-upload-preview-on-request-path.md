---
id: backend-media-14
title: Make the picker preview of an uploaded GIF in the background, and move the file instead of copying it
area: backend-media
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The preview transcode is about 0.5 s per file per the code comment, more for long GIFs, and runs for every GIF upload of 300 KB or more before the PATCH answers. The full-file copy and the SHA-256 add tens of ms for a multi-MB file. The sender of a GIF (chat attach or the picker's +) waits for all of it.
confidence: medium
files: [Yap/Services/Gifs/GifService.cs:480-504, Yap/Services/Gifs/GifService.cs:567-578, Yap/Services/Gifs/GifService.cs:1026-1040, Yap/Endpoints/TusEndpoints.cs:253-283]
---

## What the code does now
- `TryAcceptAsGifAsync` runs inside the final PATCH (TusEndpoints.cs:254-255) for `kind=gif`, every `.gif`, and every video upload (probe for the short-clip rule).
- For `.gif`/`.webp`: `contentHash = TryHashFile(sourceFilePath);` (GifService.cs:485), a synchronous SHA-256 over the whole file, then `File.Copy(sourceFilePath, localPath, overwrite: true);` (line 496), and at the end `TryDelete(sourceFilePath);` (line 576). Source and target are on the same volume (`uploads.Gifs` is under `uploads.Root`).
- Before returning: `await TryGeneratePreviewAsync(entry, isAnimatedImageSource ? localPath : sourceFilePath);` (line 570), which runs `TranscodeToPreviewWebpAsync` (12 fps, 320 px, q60) for any source of 300 KB or more (lines 1031-1036), through the shared ffmpeg gate.
- The preview is used only by the picker and the library grids (GifEntry.cs:30-37); the chat row shows the full file.

## Why it costs the user time
The sender's GIF row stays pending until the PATCH answers and the info and POST follow. The preview is not needed for the send or for any reader's row. The copy doubles the disk writes of a multi-MB file for nothing, since the source is deleted right after.

## The change
- Replace `File.Copy` with `File.Move(sourceFilePath, localPath)` for the copy-as-is branch, and drop the final delete for that branch. Hash before the move, as today.
- After `PersistNewEntry`/`IndexEntry`, start the preview in the background: `_ = Task.Run(async () => { if (await TryGeneratePreviewAsync(entry, path)) _writer.Enqueue(Writes.GifEntry(entry)); })`. For a video source, the background task must own the source file and delete it after the preview (today line 576 deletes it right away).
About 15 lines.

## Risks and what could break
- A picker opened within a second of the upload shows the full file as the card (the existing fallback `g.preview ?? g.src`, gif-picker.js:217) until the preview exists.
- The pack import calls the same method; in the import the background preview would start one task per entry. Keep the inline preview for the import (a parameter), where nobody waits.

## How to measure it
Upload a 3 MB GIF from the picker on a throttled link; time from the end of the upload to the PATCH answer, before and after (server log timestamps).
