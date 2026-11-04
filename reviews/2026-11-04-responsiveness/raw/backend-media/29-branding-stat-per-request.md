---
id: backend-media-29
title: Look up branding overrides from a list read at startup, not with a file-system call per request
area: backend-media
journey: all
category-guess: 1
behaviour-change: A new file dropped into Data/branding takes effect after a restart (or after the folder watcher fires), not on the next request.
effort: S
estimated-gain: Small. One file-system existence check per HTTP request (every API call, every upload chunk, every static file, the hub negotiate). Microseconds on a local disk; more on a bind-mounted or network volume (Data is a Docker volume). Unknown, needs measurement; listed because it runs for every request of every user.
confidence: low
files: [Yap/Program.cs:271-297]
---

## What the code does now
```csharp
app.Use(async (context, next) =>
{
    if (context.Request.Path != "/manifest.webmanifest")
    {
        var fileInfo = brandingProvider.GetFileInfo(context.Request.Path.Value ?? "");
        if (fileInfo.Exists && ...
```
(Program.cs:279-297). It runs first in the pipeline after compression, for every request, and `PhysicalFileProvider.GetFileInfo(...).Exists` asks the file system each time.

## Why it costs the user time
It is a fixed cost on every request, including the hot ones (sends, bootstrap, tus chunks, every `/uploads` image). On a Docker volume on some hosts (for example a Windows or macOS host with a bind mount) a stat can take tens to hundreds of microseconds or more.

## The change
At startup, read the file names in Data/branding once into a `HashSet<string>` (case as the file system), and check the set before calling `GetFileInfo`. Optionally refresh the set with `brandingProvider.Watch("**/*")`. About 8 lines.

## Risks and what could break
- A deployer who drops a branding file must restart (or the watcher must fire). Today a dropped file works at once. Document it in the comment.

## How to measure it
A micro-benchmark of the middleware on the production host's volume, or a request-rate test of `/api/bootstrap` with and without it.
