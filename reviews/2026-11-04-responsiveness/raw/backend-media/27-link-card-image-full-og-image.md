---
id: backend-media-27
title: Cache and shrink link-card images on the server instead of hotlinking the full og:image
area: backend-media
journey: all
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The card shows the image in an 80x80 box (60x60 on a phone) but loads the site's og:image at its own size, often 1200x630 and 50 to 300 KB (typical values, not measured here). A 160 px WebP is a few KB. The far reader also opens a new connection to each image host (DNS, TCP, TLS: about 2 to 3 round trips when the host is far), where a /media-cache file rides the existing HTTP/2 connection.
confidence: medium
files: [Yap/Services/Chat/ChatService.cs:582-597, Yap/Services/Chat/LinkPreviewService.cs:249, Yap/Services/Chat/LinkPreviewService.cs:110-129, Yap/wwwroot/js/ui/message.js:237-245, Yap/wwwroot/css/message.css:66-90, Yap/Program.cs:393-405]
---

## What the code does now
- The OG scrape stores the remote URL: `preview.ImageUrl = ExtractMetaContent(html, "og:image");` (LinkPreviewService.cs:249); yt-dlp's thumbnail fills it in otherwise (line 125).
- The mapper sends it as it is: `new PreviewDto(url, p.SiteName, p.Title, Cut(p.Description, 300), p.ImageUrl, media)` (ChatService.cs:594).
- The card draws it: `thumb.querySelector('img').src = p.imageUrl;` (message.js:243) in `<div class="link-preview-thumbnail" hidden><img alt="" loading="lazy"></div>` (index.html:574), a box of `width: 80px; height: 80px` and 60 px on a phone (message.css:69-70, 87-88).
- The audio card and the cached-video poster fall back to the same URL (message.js:258, 265).
- The service worker leaves cross-origin images alone (service-worker.js:51-56, only the emoji CDN is handled), so the card image is in the browser's HTTP cache at best.

## Why it costs the user time
Each link card in view costs a full-size third-party image. On a 1 Mbit/s link 200 KB is 1.6 s, and a new host adds its connection setup. Every reader of a room with links pays, and again after the browser drops its HTTP cache.

## The change
In LinkPreviewService, after a successful scrape with an `og:image`: download it with the existing "MediaFetch"-style client (public addresses only), resize with ImageSharp to 160 px on the long side (WebP, lossy), write `/media-cache/{hash}_card.webp` (the folder is already served immutable and cached by the worker), and set `ImageUrl` to that path. On failure keep the remote URL. Run it in the background inside the existing fetch, so no request waits. About 50 lines.

## Risks and what could break
- Server work and disk per link: small files, bounded by the number of links.
- The audio thumbnail and the video poster fallback use the same URL; 160 px is too small for the poster case. Keep the remote URL for those, or make a second, larger size.
- Some og:image hosts refuse non-browser clients; the fallback keeps today's behaviour.
- Also removes a third-party request per reader (a privacy gain, out of scope here).

## How to measure it
Journey "warm-open" in a room with ten link cards on a throttled link: bytes and connection count in DevTools before and after.
