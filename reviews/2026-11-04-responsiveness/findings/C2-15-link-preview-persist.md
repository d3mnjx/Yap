---
id: C2-15
title: Persist scraped link cards across restarts (memory-first, written in the background, loaded at start)
category: 2
journey: switch-room
effort: M
confidence: medium
behaviour-change: none
estimated-gain: After every restart or deploy, every link row in every opened room loses its card, the server re-scrapes every link (seconds each, 10 s timeout) and each row redraws twice (see 07). With persisted cards the first open after a deploy draws the same rows the device already shows. Who pays today: everyone after each deploy, on every room with links.
experiment: none
sources: [backend-services-08]
files: [Yap/Services/Chat/LinkPreviewService.cs:16, Yap/Services/Chat/ChatService.cs:559-565, Yap/Models/Chat/LinkPreview.cs:3-20, Yap/Services/Persistence/Writes.cs:20-66, Yap/Services/Persistence/Loads.cs:16-53]
---

## What the code does now
- Cards live only in `ConcurrentDictionary<string, LinkPreview> _cache` (`LinkPreviewService.cs:16`).
- The design note says so: "Previews live in memory for an hour and not across a restart, so a page of history has none until they are fetched again" (`ChatService.cs:560-561`).
- The cached media files (MR-23) do survive a restart on disk (`MediaCacheService.GetOrLoadCachedMedia`), so a player can come back, but a plain card (title, description, picture) cannot.

## Why it costs the user time
Same mechanism as 07, but for all links at once, right after a deploy, when every client reconnects and reopens its room. It also loads the server with a burst of outbound scrapes during the reconnect storm.

## The change
Follow the memory-first doctrine: memory stays the truth, a copy goes to disk in the background.
- Option A (no DB needed, works with persistence off): a JSON sidecar per URL hash next to the media cache, written by the fetch task after a successful scrape; read at startup in the background, or lazily on first sight with a negative cache.
- Option B (DB): a `LinkPreviews` table, `Writes.LinkPreview(preview)` enqueued after a scrape, `Loads.LinkPreviewsAsync` at start. Works only with persistence on, so option A fits the "no-database mode is a core feature" rule better.
Keep 07's stale-while-revalidate so an old persisted card refreshes quietly.

## Risks and what could break
- Disk growth: one small file per URL ever scraped; needs a cleanup rule (age or count).
- Startup time if loaded before `app.Run` (see 10 and 11); load in the background instead.

## How to measure it
After a deploy, open a room with links: count rows redrawn and outbound scrapes in the first minute.