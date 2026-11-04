---
id: client-core-13
title: Return the processed file's info in the final tus answer and drop the info poll
area: client-core
journey: upload
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: One round trip per upload message (about 900 ms for the far user), and up to 1 s plus a round trip more when a poll finds the file not ready yet. tus-js-client 4 gives `onSuccess` the last response, so the client can read a header from it.
confidence: medium
files: [Yap/wwwroot/js/upload.js:26-40, Yap/wwwroot/js/upload.js:49, Yap/wwwroot/js/upload.js:81-88, Yap/Endpoints/TusEndpoints.cs:118-148, Yap/Endpoints/TusEndpoints.cs:357-363, Yap/Program.cs:198-205]
---

## What the code does now
After the last chunk, `onSuccess` polls for the server's result (upload.js:81-88, 26-40):

```js
const res = await fetch(`${base}/info/${id}`, { credentials: 'same-origin' });
reached = true;
if (res.ok) return { info: await res.json(), reached };
...
await new Promise(r => setTimeout(r, 1000));
```

The server stores the result when `OnFileCompleteAsync` finishes (`Done(...)`, TusEndpoints.cs:148) and answers it once at `GET /api/tus/info/{fileId}` (TusEndpoints.cs:357-363). `OnFileCompleteAsync` runs inside the final `PATCH` (it uses `eventContext.HttpContext.RequestServices`), and video compression runs in a `Task.Run` after `Done`, so the result is normally ready when the `PATCH` answers.

## Why it costs the user time
The info `GET` is a full extra round trip after the bytes are up and before the message `POST` can leave: upload, info, post is three waits in series for the far user. When processing takes longer than the `PATCH` (a large image), the poll adds a 1 s sleep plus another round trip per miss.

## The change
1. Server, `OnFileCompleteAsync`: when `Done(result)` runs, also write the result as JSON into a response header of the current request, for example `eventContext.HttpContext.Response.Headers["Upload-Result"] = JsonSerializer.Serialize(result)`. Add `Upload-Result` to `WithExposedHeaders` of the `TusUpload` CORS policy (Program.cs:204), needed for the upload subdomain.
2. Client: `onSuccess: async ({ lastResponse }) => { const header = lastResponse?.getHeader('Upload-Result'); if (header) finish({ info: JSON.parse(header) }); else /* poll as today */ }`. Same in `uploadOne`.
3. Keep `/info/{id}` as the fallback (an old server, a header the proxy dropped).

## Risks and what could break
- The header must be set before tusdotnet writes the response; verify that `OnFileCompleteAsync` completes before the 204 is sent in tusdotnet 2.11.
- Header size limits of proxies (usually 8 KB or more); the result is a few URLs and numbers.
- The single-use rule of `/info` (the `TryRemove`) must still clear the stored entry, or entries pile up; remove it when the header is sent.

## How to measure it
Journey upload on the far link: one photo. Count the requests after the last `PATCH` (one `info` today) and the time from the `PATCH` answer to the message `POST`.
