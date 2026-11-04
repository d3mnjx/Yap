---
id: backend-request-05
title: Return the upload's result with the final tus response instead of a separate /api/tus/info round trip
area: backend-request
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One round trip per upload batch (about 900 ms for the far user) for photos, videos, voice messages and GIF library uploads.
confidence: medium
files: [Yap/Endpoints/TusEndpoints.cs:118-150, Yap/Endpoints/TusEndpoints.cs:307-351, Yap/Endpoints/TusEndpoints.cs:357-363, Yap/Program.cs:196-206, Yap/wwwroot/js/upload.js:26-39, Yap/wwwroot/js/upload.js:49, Yap/wwwroot/js/upload.js:81-88]
---

## What the code does now
- `OnFileCompleteAsync` does all the work before the last tus request ends: it moves the file, awaits `imageService.GenerateMediumThumbnailAsync(filePath)` for a picture (TusEndpoints.cs:310), `videoService.GeneratePosterAsync(filePath)` for a video (line 332), `voiceService.TranscodeAsync` for a voice message (line 192), and stores the answer: `void Done(object result) => _completedFiles[file.Id] = new Completed(user?.Id, result);` (line 148).
- The answer is only reachable through a second request: `app.MapGet("/api/tus/info/{fileId}", ...)` (lines 357-363).
- The client asks for it after tus reports success: `onSuccess: async () => { ... const { info: result, reached } = await info(u.url, 30, report); ...` (upload.js:81-86). `info()` fetches `${base}/info/${id}` and, on a miss, sleeps 1 s and tries again (upload.js:26-39).
- The CORS policy exposes `"Upload-Offset", "Upload-Length", "Tus-Resumable", "Location"` (Program.cs:204).

## Why it costs the user time
The result exists when the final PATCH (or POST) ends, so the GET is a pure extra round trip before the client can post the message. The far user waits about 900 ms more for every photo, video and voice message. The row stays in its pending state for that time.

## The change
- TusEndpoints.cs: in `Done`, also write the result into a response header of the current request: `eventContext.HttpContext.Response.Headers["Upload-Result"] = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(result));` (Done needs the event context; pass it in or set the header next to each `Done(...)` call). Keep `_completedFiles` and the info route as the fallback.
- Program.cs:204: add `"Upload-Result"` to `WithExposedHeaders`, so the upload subdomain (ChatSettings:UploadUrl) can read it.
- upload.js: in both `new tus.Upload(...)` option sets, add `onAfterResponse: (req, res) => { const h = res.getHeader('Upload-Result'); if (h) result = JSON.parse(atob(h)); }` (tus-js-client in lib/tus.min.js has `onAfterResponse`). In `onSuccess`, use `result` when present, else call `info()` as today.

## Risks and what could break
- The header must be set before tusdotnet starts the response. tusdotnet calls OnFileCompleteAsync inside the request that completes the file; whether the response has started by then must be checked in a test (medium confidence).
- Header size: the result objects are small (a URL and a type, or a GIF entry id with a size). Base64 keeps non-ASCII safe.
- A retried final PATCH after a lost answer has no header; the info fallback covers it.

## How to measure it
Journey: send a photo and a voice message on the 900 ms / 1 Mbit/s throttle; the time from tus success to the message POST, and the `send` wait. Count requests per upload in the browser's network panel (one `info` GET less).
