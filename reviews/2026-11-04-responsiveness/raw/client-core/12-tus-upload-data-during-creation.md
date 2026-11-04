---
id: client-core-12
title: Send the file's bytes with the tus creation request
area: client-core
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One round trip per upload message (the files of a message upload in parallel), about 900 ms for the far user, for every file that fits in one chunk (5 MB). Requires the server to support the tus "creation-with-upload" extension; tusdotnet 2.11 is expected to, not verified.
confidence: medium
files: [Yap/wwwroot/js/upload.js:43-53, Yap/wwwroot/js/upload.js:60-92, Yap/Endpoints/TusEndpoints.cs:36-41]
---

## What the code does now
Both tus uploads use the client's defaults apart from the chunk size and retries (upload.js:73-74):

```js
const u = new tus.Upload(file, {
  endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000], withCredentials: true,
```

The vendored tus-js-client 4.3.1 has `uploadDataDuringCreation: false` by default (checked in `lib/tus.min.js`). So each file is a `POST` (create, answer with `Location`) and then a `PATCH` with the bytes. The server is tusdotnet 2.11.0 (`Yap.csproj:41`, `MapTus` in TusEndpoints.cs:36).

## Why it costs the user time
The `PATCH` can only start after the `POST` answer. For a photo or a voice note (well under 5 MB), the creation round trip is pure waiting: 900 ms on the far link, before any byte moves. The message's own POST waits for the upload, so the pending row shows "uploading" one round trip longer.

## The change
Add `uploadDataDuringCreation: true` to both option objects in `upload.js` (lines 46 and 74). The client then sends the first chunk in the creation `POST` (`Upload-Length` plus the body); for a file of one chunk, the upload is a single request. Check the server's `OPTIONS /api/tus` answer first: its `Tus-Extension` header must list `creation-with-upload`. Whether tus-js-client recovers cleanly when a server ignores the body is not verified, so do not ship the option before that check (or before an upgrade of tusdotnet).

## Risks and what could break
- `OnBeforeCreateAsync` checks (quota, size, kind) run before the body is read, as today.
- `OnFileCompleteAsync` then runs inside the `POST` instead of the `PATCH`; the code reads the file from the store either way.
- The Cloudflare request size limit (the reason for the upload subdomain, admin.js) applies to the POST body the same as to a PATCH chunk.

## How to measure it
Journey upload on the far link: one photo of 2 MB. Count the requests to `/api/tus` (2 before, 1 after) and the time from Send to the confirmed row. The `send` wait of AD-26 excludes uploads, so use a manual mark.
