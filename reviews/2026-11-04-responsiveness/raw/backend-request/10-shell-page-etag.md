---
id: backend-request-10
title: Give the page an ETag so a revalidation is a 304, and build its bytes once
area: backend-request
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The page body (96,885 B raw template, about 22 to 26 KB compressed) on each revalidation, about 0.2 s at 1 Mbit/s for the far user. The round trip itself stays. Applies to network-first navigations (root, /login, /verify/*, /invite/*), first visits that return, and the worker's install fetch of /login.
confidence: medium
files: [Yap/Endpoints/ShellEndpoints.cs:36-50, Yap/Endpoints/ShellEndpoints.cs:52-72, Yap/wwwroot/index.html:1-3]
---

## What the code does now
- The page is a string built once per process in Production: `string Shell() => env.IsDevelopment() ? Read("index.html") : cachedShell ??= Read("index.html");` (ShellEndpoints.cs:38).
- Each route answers `http.Response.Headers.CacheControl = "no-cache"; return Results.Content(Shell(), "text/html; charset=utf-8");` (lines 70-71). There is no ETag and no Last-Modified.
- `index.html` is 96,885 B raw; gzip -1 gives 26,348 B, gzip -9 21,794 B.
- docs/performance-notes.md (step 3): the worker serves signed-in routes cache-first, and keeps "the root, the login page, the verification page and an invite" network-first.

## Why it costs the user time
`no-cache` allows the browser to store the page, but without a validator it cannot ask "has it changed?". Every network fetch of the page is a full 200 with the whole compressed body. A browser-tab user who opens the root goes through the network each time and downloads about 22 to 26 KB again after the round trip. The page changes only with a deploy or a project-name change.

## The change
In MapShell, in Production, compute once next to `cachedShell`: the UTF-8 bytes and `var etag = $"W/\"{BuildInfo.Time}-{Convert.ToHexString(SHA256.HashData(bytes))[..12]}\""`. In the route handler, after the welcome and visitor-log branches: set `ETag` and `Cache-Control: no-cache`; when `If-None-Match` equals the ETag, return `Results.StatusCode(304)`; else return `Results.Bytes(bytes, "text/html; charset=utf-8")`. In Development compute the ETag from the freshly read bytes (cheap) or skip it. Optional: serve the precompressed bytes from backend-request-09.

## Risks and what could break
- The visitor log (AD-20) must still run before the 304 path; keep the order of the branches.
- The welcome page (signed-out root) has its own content; it must not get the shell's ETag.
- A weak ETag is right here because the response compression changes the bytes on the wire.

## How to measure it
Open the root twice in a browser tab with the worker active on the throttled link: the second navigation should show 304 and about 300 B instead of about 25 KB. Admin Load time table: `html` phase and `bytes` for tab loads.
