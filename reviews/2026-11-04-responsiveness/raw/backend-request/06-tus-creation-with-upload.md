---
id: backend-request-06
title: Use tus creation-with-upload so small files go up in the creating request
area: backend-request
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One round trip per file up to the 5 MB chunk size (about 900 ms for the far user); files go in parallel, so about one round trip per batch. Voice messages and most photos are below 5 MB.
confidence: medium
files: [Yap/Endpoints/TusEndpoints.cs:36-66, Yap/wwwroot/js/upload.js:45-47, Yap/wwwroot/js/upload.js:73-75, Yap/Yap.csproj:41]
---

## What the code does now
- The server uses tusdotnet 2.11.0 (Yap.csproj:41) with a `TusDiskStore` (TusEndpoints.cs:38). The tusdotnet 2.11.0 assembly contains the extension name "creation-with-upload" (found in `~/.nuget/packages/tusdotnet/2.11.0/lib/net452/tusdotnet.dll`).
- The client creates each upload with `new tus.Upload(file, { endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [...], withCredentials: true, metadata: ... })` (upload.js:45-47 and 73-75). It does not set `uploadDataDuringCreation`, so tus-js-client sends a POST (create) and waits for its answer, then a PATCH with the data. lib/tus.min.js contains the `uploadDataDuringCreation` option.
- `OnCreateCompleteAsync` records the owner (TusEndpoints.cs:62-66); `OnFileCompleteAsync` removes it when the file completes (line 129).

## Why it costs the user time
The POST carries no data. The far user waits one full round trip before the first byte of the file leaves the phone.

## The change
upload.js: add `uploadDataDuringCreation: true` to both option sets. No server change is expected: tusdotnet advertises the extension in its OPTIONS answer when the store supports it. Check the `Tus-Extension` header of an OPTIONS request to /api/tus.

## Risks and what could break
- The create request now carries up to 5 MB, so a proxy's body limit applies to it (Cloudflare's limit is 100 MB, so 5 MB passes).
- OnBeforeCreate, OnCreateComplete and OnFileComplete then run inside one request. The owner map is written on create and removed on complete in that order; check that a file that completes in the POST leaves no entry behind and that OnAuthorize for the CreateFile intent still passes.
- If the server does not advertise the extension, tus-js-client falls back to POST then PATCH.

## How to measure it
Upload a 1 MB photo on the throttled link; count the tus requests (POST + PATCH becomes POST) and time from tap to the message POST.
