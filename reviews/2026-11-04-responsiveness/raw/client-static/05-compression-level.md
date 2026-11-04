---
id: client-static-05
title: Compress the stylesheets and the page at a better level than Fastest
area: client-static
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: "Measured with gzip on the files: the nine stylesheets 78.8 KB at level 1 to 64.4 KB at level 6 (-14.4 KB); the page 26.3 KB to 21.9 KB (-4.4 KB). About 150 ms at 1 Mbit/s on a first visit and at every worker install after a deploy, plus the scripts (other reader). Brotli quality 1 against 4 not measured (no brotli tool in the sandbox)."
confidence: medium
files: [Yap/Program.cs:77-84, Yap/Program.cs:269]
---

## What the code does now
`Program.cs:80-84`:
```csharp
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.MimeTypes = [.. ResponseCompressionDefaults.MimeTypes, "image/svg+xml", "application/manifest+json"];
});
```
No `BrotliCompressionProviderOptions` or `GzipCompressionProviderOptions` are set, so both providers use the framework default level, `Fastest` (performance-notes.md says the same). Every response is compressed again on every request; nothing caches the compressed bytes.

Sizes per file (raw / gzip 1 / gzip 6 / gzip 9):

| file | raw | gz1 | gz6 | gz9 |
| --- | --- | --- | --- | --- |
| app.css | 27,302 | 9,912 | 8,789 | 8,776 |
| themes.css | 19,212 | 6,969 | 6,160 | 6,120 |
| themes/teahouse.css | 22,788 | 3,082 | 2,405 | 2,385 |
| css/frame.css | 33,603 | 10,393 | 8,498 | 8,416 |
| css/pickers.css | 16,604 | 4,945 | 4,139 | 4,104 |
| css/timeline.css | 13,123 | 5,079 | 4,568 | 4,553 |
| css/composer.css | 22,361 | 7,436 | 6,321 | 6,260 |
| css/message.css | 32,554 | 10,421 | 8,508 | 8,422 |
| css/pages.css | 85,548 | 20,555 | 14,967 | 14,674 |
| sum CSS | 273,095 | 78,792 | 64,355 | 63,710 |
| index.html | 96,885 | 26,348 | 21,944 | 21,794 |

## Why it costs the user time
The stylesheets are render-blocking and script-blocking, so their bytes sit on the path to the first paint and to `main.js` on a first visit. Level 1 leaves about 18 % more CSS bytes than level 6. The page is the first response of a cold load. Who pays: first visits, and every device after a deploy (the new worker fetches the whole shell again).

## The change
After `AddResponseCompression` in `Program.cs`:
```csharp
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
```
A later step, if the numbers justify it: compress each versioned file once at startup with Brotli quality 11 (the same scan as `ShellAssets`) and serve the stored bytes.

## Risks and what could break
More CPU per uncached response. Versioned files are immutable, so a browser, a Cloudflare edge or the worker asks the origin once per deploy. The page is `no-cache` but the worker serves it cache-first. Measure the server time of a cold load (the 85 KB pages.css is the largest file).

## How to measure it
Boot report `bytes` for first visits; `npm run load` cold `scripts` phase; `curl -H 'Accept-Encoding: br' -so /dev/null -w '%{size_download}'` per file before and after.
