---
id: C1-73
title: Put the upload result in the last tus response and drop the GET /api/tus/info round trip
category: 1
journey: upload
effort: S
confidence: medium
behaviour-change: none
estimated-gain: One round trip per media message (about 900 ms for the far sender). The files of one message upload in parallel, so their info calls overlap and the saving is one RTT per message, before the message POST can start.
experiment: none
sources: [backend-media-01, backend-request-05, client-core-13]
files: [Yap/Endpoints/TusEndpoints.cs:118-351, Yap/Endpoints/TusEndpoints.cs:357-363, Yap/Program.cs:196-205, Yap/wwwroot/js/upload.js:26-40, Yap/wwwroot/js/upload.js:81-88]
---

## What the code does now
- The server does all the processing inside `OnFileCompleteAsync` (TusEndpoints.cs:118), which tusdotnet runs for the last PATCH. The result goes into a dictionary: `void Done(object result) => _completedFiles[file.Id] = new Completed(user?.Id, result);` (line 148).
- The client reads it with a second request after tus reports success: `const res = await fetch(\`${base}/info/${id}\`, ...)` (upload.js:32), with a 1 s sleep and up to 30 polls when it is not there yet (upload.js:30-38).
- `onSuccess: async () => { ... const { info: result, reached } = await info(u.url, 30, report);` (upload.js:81-83). Only after this does sender.js POST the message (sender.js:114).
- tus-js-client 4.3.1 (vendored, lib/tus.min.js) calls `onSuccess({lastResponse})`, so the last response is available to the client.
- The CORS policy exposes only `Upload-Offset`, `Upload-Length`, `Tus-Resumable`, `Location` (Program.cs:204).

## Why it costs the user time
The critical path of a media send is: create (1 RTT), PATCH chunks (transfer plus 1 RTT each), info (1 RTT), message POST (1 RTT). The info GET carries nothing the last PATCH could not carry. Every sender pays it; the far sender pays about 900 ms per media message, voice messages and GIF uploads from the picker included (`uploadOne`, upload.js:49).

## The change
- TusEndpoints.cs: in `Done`, also write the result to a response header of the current request, for example `eventContext.HttpContext.Response.Headers["Yap-Upload"] = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(result))`. Keep `_completedFiles` and the info endpoint as the fallback.
- Program.cs:204: add `"Yap-Upload"` to `WithExposedHeaders` (the upload subdomain is cross-origin).
- upload.js: in both `onSuccess` handlers, read `payload.lastResponse.getHeader('Yap-Upload')`; when present, decode it (`JSON.parse(atob(...))`) and use it; when absent, call `info()` as today.
About 15 lines in three files.

## Risks and what could break
- This needs tusdotnet to run `OnFileCompleteAsync` before it writes the 204. The client's polling loop hints that someone expected the result to come later. Verify with a test before relying on it; the fallback keeps today's behaviour if the header is missing.
- Header size: the result is under 200 bytes (url and type, or a GIF id and size). Proxies allow 8 KB or more.
- The `_completedFiles` entry is then never read and stays in memory; remove it when the header was set, or let the endpoint stay as is (it already leaks entries for clients that never call it).

## How to measure it
Journey "upload" with `npm run load`-style throttling (900 ms RTT): time from the last progress event to the message POST. Before: about 1 RTT plus the info answer. After: zero. Count requests per media send in DevTools: one fewer per file.

## Also found by

The same finding, from another reader's angle: `raw/backend-request/05-tus-result-in-final-response.md`, `raw/client-core/13-tus-result-in-final-response.md`. The raw files hold their reasoning and numbers.
