---
id: backend-request-09
title: Compress the shell files once per build at the highest level instead of at the fastest level per request
area: backend-request
journey: cold-open
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Measured with gzip as a stand-in (no brotli tool here): the 54 text files of a cold load are 980,026 B raw, 333,611 B at gzip -1 and 285,273 B at gzip -9, so about 48 KB (14 %) less, about 0.4 s at 1 Mbit/s. Brotli at its top quality is usually smaller again than gzip -9 on JS and CSS (unknown here). Also less CPU: one compression per file per process instead of one per response.
confidence: medium
files: [Yap/Program.cs:77-84, Yap/Program.cs:269, Yap/Program.cs:358-373, Yap/Endpoints/ShellEndpoints.cs:70-71]
---

## What the code does now
- `builder.Services.AddResponseCompression(o => { o.EnableForHttps = true; o.MimeTypes = [...] });` (Program.cs:80-84) sets no provider options. The Brotli and Gzip providers then use their default level, `CompressionLevel.Fastest`. docs/performance-notes.md also says "the server uses the framework default, the fastest".
- `app.UseResponseCompression()` (Program.cs:269) sits before the static file handlers, so every `.js`, `.css` and the page are compressed on the fly for each response.
- Versioned `.js`/`.css` are immutable (Program.cs:369), so a client downloads each file once per build; every deploy makes every client download all of them again (the worker's install, in the background).
- The cold load measured 803 KB on the wire (performance-notes.md table); the regular font is 352,240 B of that and is already compressed.

## Why it costs the user time
On a first visit the far user downloads all scripts and styles before the first paint. Fastest-level compression sends roughly 14 % more than the best gzip level, and Brotli's best level is better still. That is a few hundred milliseconds on 1 Mbit/s for every new device and every new browser profile.

## The change
A small in-memory store for the shell's static text files (simplest readable form):
- A singleton `PrecompressedShell` keeps `ConcurrentDictionary<string, Lazy<(byte[] Br, byte[] Gz)>>` keyed by the request path.
- A middleware placed before `UseStaticFiles` handles GET requests for `.js`/`.css` paths with a `v` query: it resolves the file from `env.WebRootFileProvider`, compresses it once with `BrotliEncoder`/`GZipStream` at `CompressionLevel.SmallestSize`, and writes the bytes with `Content-Encoding`, `Vary: Accept-Encoding`, the content type and the immutable `Cache-Control`. Without a matching `Accept-Encoding` it calls `next()`. The response compression middleware skips a response that already has `Content-Encoding`.
- The page (finding backend-request-10) can use the same store.
- Option: fill the store in the background right after start for the files in `ShellAssets`' list, so no request pays the first compression (about 1 MB at the top level, roughly a second of CPU once per process; not measured).
`MapStaticAssets` (build-time compression) is the framework's own way, but it brings its own fingerprinting and cache headers and would conflict with the `?v=` scheme and the page template; this note does not recommend it.

## Risks and what could break
- Memory: about 2 x 250 to 300 KB per process.
- Range requests and HEAD for these files: send them to the normal handler (`next()`).
- A proxy that recompresses (Cloudflare can) may change the result; measure at the browser.

## How to measure it
`npm run load` cold: bytes on the wire and the `scripts` phase; `curl -H 'Accept-Encoding: br' --compressed -so /dev/null -w '%{size_download}'` per file before and after.
