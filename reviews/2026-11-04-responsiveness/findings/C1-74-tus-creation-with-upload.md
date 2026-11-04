---
id: C1-74
title: Send the first chunk with the tus create request (creation-with-upload)
category: 1
journey: upload
effort: S
confidence: medium
behaviour-change: none
estimated-gain: One round trip per media message (about 900 ms for the far sender). With finding 01, a photo of 5 MB or less goes from four round trips to two before the message POST.
experiment: none
sources: [backend-media-02, backend-request-06, client-core-12]
files: [Yap/wwwroot/js/upload.js:43-53, Yap/wwwroot/js/upload.js:73-89, Yap/Endpoints/TusEndpoints.cs:36-41]
---

## What the code does now
- The client creates each upload with an empty POST, then sends the bytes in PATCH requests: `new tus.Upload(file, { endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [...], withCredentials: true, metadata: ... })` (upload.js:73-75, and 45-47 for one file). `uploadDataDuringCreation` is not set, so it is false.
- The server uses tusdotnet 2.11.0 (Yap.csproj:41) with `TusDiskStore` (TusEndpoints.cs:38). The package's documentation lists `StoreExtensions.CreationWithUpload` ("Supports creation-with-upload"), and the vendored tus-js-client 4.3.1 contains the `uploadDataDuringCreation` option.

## Why it costs the user time
The empty POST costs a full round trip before the first byte of the file leaves the phone. Every media send pays it: photos, videos, voice messages, GIF uploads. For the far sender it is about 900 ms per message (the files of one message create in parallel).

## The change
In upload.js, add `uploadDataDuringCreation: true` to both `tus.Upload` option objects. The POST then carries the first 5 MB. A file of 5 MB or less is complete after one request, and tusdotnet runs `OnFileCompleteAsync` inside that POST. Nothing changes on the server, as long as tusdotnet advertises `creation-with-upload` in `Tus-Extension` for the disk store (check the OPTIONS answer).

## Risks and what could break
- `OnAuthorizeAsync` (TusEndpoints.cs:43-60) skips the owner check for the `CreateFile` intent, and `OnCreateCompleteAsync` records the owner. Check that the write inside the POST does not hit the owner check before `_owners` is set.
- If the POST breaks mid-body, the client does not yet know the upload URL and starts over instead of resuming. That loses at most the first chunk (5 MB).
- `OnBeforeCreateAsync` still runs before any byte is written, so the quota and ffmpeg checks keep working.

## How to measure it
Upload journey on a throttled link (900 ms RTT, 1 Mbit/s): count requests per photo in DevTools (today POST + PATCH + GET info + POST message) and the time from tap to "sent". Expect one request and about 900 ms less.

## Also found by

The same finding, from another reader's angle: `raw/backend-request/06-tus-creation-with-upload.md`, `raw/client-core/12-tus-upload-data-during-creation.md`. The raw files hold their reasoning and numbers.
