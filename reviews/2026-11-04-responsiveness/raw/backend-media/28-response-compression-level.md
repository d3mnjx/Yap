---
id: backend-media-28
title: Compress responses at the Optimal level instead of the framework's Fastest
area: backend-media
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Measured with gzip on the 55 shell files (1,024,050 bytes raw): level 1 gives 351,211 bytes, level 6 gives 302,351 bytes, 49 KB (14 %) less, about 0.4 s at 1 Mbit/s. That applies to a first visit, to the new worker's download of the whole shell after every deploy (the Reload button waits for that install, up to 15 s), and in proportion to every JSON answer (the bootstrap, the GIF lists). Brotli was not measured here (no brotli tool in the sandbox).
confidence: high
files: [Yap/Program.cs:77-84, Yap/Program.cs:269]
---

## What the code does now
```csharp
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.MimeTypes = [.. ResponseCompressionDefaults.MimeTypes, "image/svg+xml", "application/manifest+json"];
});
```
(Program.cs:80-84). No `BrotliCompressionProviderOptions` or `GzipCompressionProviderOptions` are configured, so both use their default level, `CompressionLevel.Fastest`. `app.UseResponseCompression()` (line 269) runs before the static file handlers, so the shell's scripts and styles are compressed on the fly per request. docs/performance-notes.md mentions the fastest level as a fact, with no decision to keep it.

## Why it costs the user time
The scripts and styles are fetched once per device per build (immutable), so a better ratio saves bytes exactly when the user waits for them: the first visit (803 KB on the wire in the measured cold load) and the post-deploy install that the "Please refresh" Reload button waits for. JSON answers (the bootstrap at every connect, the GIF lists) gain too. The extra CPU is small: level 6 on 1 MB of text is in the tens of ms, once per device per build.

## The change
```csharp
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
```
Two lines plus `using System.IO.Compression;`, with a comment on why. A larger step, not proposed now: compress each shell file once at startup at the smallest size (`ShellAssets` already scans wwwroot) and serve the stored bytes; Brotli at quality 11 is commonly 15 to 20 % below gzip 9 for JavaScript.

## Risks and what could break
- CPU per compressed response grows a few times. For the bootstrap of a server with 1,000 users (a large JSON) it is still in the low milliseconds; check the load-test numbers once.
- What `Optimal` means for Brotli in .NET 10 (quality 4, as far as I know) should be checked in the docs; any value between 4 and 6 is a fair trade for per-request compression.

## How to measure it
`npm run load` cold load: "on the wire" bytes before and after. On the server, `curl -H 'Accept-Encoding: br' --compressed -so /dev/null -w '%{size_download}'` for app.css and a big module.
