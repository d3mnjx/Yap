---
id: client-static-09
title: Let profile pictures paint from the cache while they revalidate (stale-while-revalidate)
area: client-static
journey: warm-open
category-guess: 1
behaviour-change: none; the URL carries ?v=<upload time>, so a changed picture is a new URL and is never shown stale
effort: S
estimated-gain: "At every open more than 5 minutes after the last fetch of a picture, each distinct avatar on screen waits one conditional request before it paints: about 900 ms of empty avatar circles for the far user. With stale-while-revalidate the cached picture paints at once and the 304 runs in the background. Browsers without support behave as today."
confidence: medium
files: [Yap/Program.cs:316-327, Yap/wwwroot/service-worker.js:69-72, Yap/Services/Media/ImageService.cs:152, Yap/wwwroot/js/render/avatar.js:24-37]
---

## What the code does now
- `Program.cs:321-327`: `/uploads/profiles` gets `Cache-Control: public, max-age=300`.
- The worker leaves profile pictures to the HTTP cache (`service-worker.js:71`, `!url.pathname.startsWith('/uploads/profiles/')`).
- `ImageService.cs:152`: the stored URL is `/uploads/profiles/{userId}.webp?v={ms}`. A new upload gives a new URL.
- `avatar.js:30-31`: the avatar `<img>` gets the URL; the gradient initials are removed when a picture exists, so the circle is empty until the image paints.

## Why it costs the user time
After 300 s the browser must revalidate before it may use the cached copy. The rows of a warm open paint at about 88 ms from the stored copy (performance-notes.md), and the avatars follow one round trip later. For the far user that is about 900 ms of blank circles at most opens; on a resume after an hour, the same. Who pays: everyone who opens the app more than 5 minutes after the last time; far users most.

## The change
`Program.cs:326`:
```csharp
ctx.Context.Response.Headers.CacheControl = "public, max-age=300, stale-while-revalidate=604800"
```
The doctrine stays: the path is stable and the max-age stays 5 minutes. A client holding the old URL already shows the old picture today.

## Risks and what could break
- Safari support for `stale-while-revalidate` is unknown to me; Chrome (75+) and Firefox (68+) support it. Where unsupported, nothing changes.
- A deleted account's picture can show for one more open from the cache (it does today within 5 minutes).

## How to measure it
On a throttled warm open more than 5 minutes after the last: resource timing of `/uploads/profiles/*` (transferSize 0 vs a 304 with a round trip), and a screenshot at the `paint` mark.
