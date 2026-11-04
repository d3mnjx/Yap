---
id: client-render-25
title: Add stale-while-revalidate to the profile picture header
area: client-render
journey: warm-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Profile pictures carry max-age=300 and pass the worker untouched. On every open more than 5 minutes after the last one, each distinct avatar on screen needs a revalidation round trip before it shows; the far user sees empty avatar circles for about 0.9 s (the requests run in parallel over HTTP/2). With stale-while-revalidate the cached picture shows at once and the check runs in the background.
confidence: medium
files: [Yap/Program.cs:316-327, Yap/wwwroot/service-worker.js:69-73, Yap/wwwroot/js/render/avatar.js:23-37]
---

## What the code does now
```csharp
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(profilesRoot),
    RequestPath = "/uploads/profiles",
    OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=300"
});
```
(`Program.cs:321-327`). The comment above it says the stored URL carries `?v=<upload time>`, so a new picture is a new URL (`Program.cs:316-320`). The worker skips `/uploads/profiles/` on purpose (`service-worker.js:71`). `avatar()` sets `img.src = pictureUrl` with no placeholder picture (`avatar.js:29-31`).

## Why it costs the user time
After 300 s the cached entry is stale. A stale entry with validators makes the browser send a conditional request and wait for the 304 before it paints the image. Every header row's avatar, the reply quotes, the DM header and the pins panel wait one round trip at every open after five minutes. Who pays: everyone, far users about 0.9 s of empty avatars at each open.

## The change
In `Program.cs` (backend reader's file; the effect is on the client's avatar path):

```csharp
ctx.Context.Response.Headers.CacheControl = "public, max-age=300, stale-while-revalidate=604800";
```

The stable URL and the short max-age stay, as the doctrine asks (memory `static-asset-caching`): the browser still checks after five minutes, but in the background, and uses the new file from the next view on. Because the URL carries `?v=`, a changed picture is a new URL anyway, so a stale answer never shows an old picture under a new URL.

## Risks and what could break
A client that holds the old URL (before it learned the new `?v=`) shows the old picture for one more view. That is the case the short max-age covers today, and it gets one view later than now. Browser support: Chrome and Firefox honour `stale-while-revalidate`; WebKit support needs a check on the iPhone (unknown here).

## How to measure it
Open the app, wait 6 minutes, open it again on the far link (or a throttled phone). Network panel: avatar requests with status 304 and their timing relative to the row paint, before and after.
