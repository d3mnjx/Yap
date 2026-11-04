---
id: C1-04
title: Give the page and the worker script an ETag so their revalidation is a 304
category: 1
journey: warm-open
effort: S
confidence: high
behaviour-change: none
estimated-gain: Every navigation the worker sends to the server (`/`, `/login`, `/verify/...`, `/invite/...`) downloads the whole page again today: 96,885 bytes raw, 21,944 gzip, about 175 ms at 1 Mbit/s. With an ETag that becomes a 304 of a few hundred bytes. The browser's worker update check at each navigation (the worker template, 11.7 KB raw plus the shell list) shrinks the same way, if the browser revalidates it conditionally (not verified).
experiment: E04
sources: [client-core-18, backend-request-10]
files: [Yap/Endpoints/ShellEndpoints.cs:36-50, Yap/Endpoints/ShellEndpoints.cs:70-71, Yap/Endpoints/ShellEndpoints.cs:77-81, Yap/wwwroot/service-worker.js:25-29, Yap/wwwroot/service-worker.js:59-64]
---

## What the code does now
The page and the worker are templates filled once per process in Production (ShellEndpoints.cs:36-39) and returned with `no-cache` and no validator (ShellEndpoints.cs:70-71, 77-80):

```cs
http.Response.Headers.CacheControl = "no-cache";   // always revalidate: the service worker, not the HTTP cache, serves the shell
return Results.Content(Shell(), "text/html; charset=utf-8");
```

`Results.Content` sets no `ETag` and no `Last-Modified`. `no-cache` tells the browser to revalidate, but without a validator it cannot ask "has it changed?", so every revalidation is a full 200. The worker answers `/`, `/login`, `/verify/*` and `/invite/*` network-first (service-worker.js:29, 62), so these navigations always reach the server.

## Why it costs the user time
A browser-tab user who opens the root, and every visitor of the login page, waits for the whole page before the paint. On the far link 22 KB is about 175 ms on top of the round trip. The worker script's update check runs after each navigation and competes with the boot's own requests.

## The change
In `MapShell`, compute one strong ETag per filled template (the build stamp plus a hash of the project name is enough in Production, since the strings are cached per process; in Development hash the string). Before `Results.Content`, compare `If-None-Match` and return `Results.StatusCode(304)` with the same `ETag` and `Cache-Control` headers when it matches. Same for `/service-worker.js`. About 15 lines.

## Risks and what could break
- The welcome page at `/` (signed-out visitors, AD-36) is a different document; give it its own ETag or none, so a 304 never answers a signed-out visitor with the signed-in shell (the request for `/` carries the cookie, but the browser's cached copy may be of the other kind; including the signed-in state in the ETag avoids that).
- The visitor log at `/login` (AD-20) runs before the answer and keeps working with a 304.
- Response compression and a 304 work together; the 304 has no body.

## How to measure it
Open `/login` twice in a browser tab with the worker installed and the network panel open: today two 200s of about 22 KB, after the change one 200 and one 304. Repeat for `/service-worker.js` after a navigation.

## Also found by

The same finding, from another reader's angle: `raw/backend-request/10-shell-page-etag.md`. The raw files hold their reasoning and numbers.
