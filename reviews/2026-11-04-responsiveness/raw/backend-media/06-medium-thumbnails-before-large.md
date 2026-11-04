---
id: backend-media-06
title: Let the waiting 800 px thumbnails go before the background 1600 px ones
area: backend-media
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown, needs measurement. When the pictures of one message finish uploading at different times, the 800 px thumbnail of a later picture can wait behind the 1600 px thumbnail of an earlier one (a full decode plus a 1600 px encode, several hundred ms or more). The sender's message waits for the last picture.
confidence: low
files: [Yap/wwwroot/js/ui/gallery.js:24-25, Yap/Services/Media/ImageService.cs:26-29, Yap/Services/Media/ImageService.cs:47-70, Yap/Endpoints/TusEndpoints.cs:307-327]
---

## What the code does now
- One process-wide gate for every decode: `private static readonly SemaphoreSlim Gate = new(1, 1);` (ImageService.cs:29). The comment says four concurrent decodes crashed a Windows dev machine.
- After the 800 px thumbnail, the request starts the 1600 px one in the background, which takes the same gate: `_ = Task.Run(async () => { ... await imageService.GenerateLargeThumbnailAsync(filePath); ...` (TusEndpoints.cs:313-326).
- The 1600 px thumbnail decodes the original again (`Image.LoadAsync`, ImageService.cs:59).

## Why it costs the user time
The 800 px thumbnail is on the critical path of the send (the PATCH answer waits for it); the 1600 px one is only for the viewer. The gate serves waiters in arrival order. If picture 1's PATCH completes while picture 2 is still uploading, picture 1's large thumbnail takes the gate, and picture 2's medium thumbnail waits for it. Senders of multi-picture messages pay; the far sender's pictures finish at different times more often, because the shared 1 Mbit/s link spreads them out.

## The change
Keep the single gate (the memory limit), but give the medium thumbnails priority. Smallest form: a static counter of waiting medium thumbnails (`Interlocked.Increment` before `Gate.WaitAsync()`, decrement after), and the large thumbnail waits until the counter is zero before it asks for the gate (a short `await Task.Delay(50)` loop). About 10 lines in ImageService.cs, with a comment that says why.

## Risks and what could break
- A steady stream of photo uploads could delay the 1600 px files; the viewer already falls back to the 800 px file while the large one is missing (`img.addEventListener('error', () => { img.src = item.image.medium; }, { once: true });`, gallery.js:25, with the comment "the large file may still be in the making"). On a chat server this stream ends quickly.
- The polling loop is a little crude; a two-queue gate class is the clean version (about 25 lines).

## How to measure it
Send a message with four 4 MB photos over a throttled link; log the wait time on the gate per medium thumbnail. Compare the time from tap to "sent".
