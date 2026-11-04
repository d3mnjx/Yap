---
id: backend-request-12
title: Keep link cards longer than an hour (and across restarts) so tails arrive with their cards
area: backend-request
journey: switch-room
category-guess: 3
behaviour-change: A conversation opened more than an hour after its links were last scraped (or after a restart) shows its link cards at once, instead of rows without cards that grow when the cards arrive; a card's title or picture can be up to days old.
effort: S
estimated-gain: Removes the wait for the scrape (an outbound page fetch, up to the 10 s client timeout) plus the `previews` event before the cards show, and the layout shift when they appear. Unknown per site; needs measurement.
confidence: medium
files: [Yap/Services/Chat/LinkPreviewService.cs:15-21, Yap/Services/Chat/LinkPreviewService.cs:80-91, Yap/Services/Chat/LinkPreviewService.cs:134-165, Yap/Services/Chat/ChatService.cs:556-578, Yap/Services/Chat/ChatService.cs:582-597, Yap/Endpoints/ChatHub.cs:165-172, Yap/Endpoints/ChatHubBroadcaster.cs:53, Yap/Program.cs:106-120]
---

## What the code does now
- Cards live in a memory dictionary with a one-hour life: `private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);` (LinkPreviewService.cs:21). `GetCachedPreview` removes an expired entry and returns null (lines 80-91). Failed scrapes are cached the same way (lines 157-160).
- ChatService says it in its comment: "Previews live in memory for an hour and not across a restart, so a page of history has none until they are fetched again: the hub calls this for every page it serves, the fetch runs in the background, and the "previews" message fills the rows in" (ChatService.cs:556-561).
- `Open` maps the tail with `chat.Previews(m)` (no card when the cache misses) and calls `EnsurePreviews` (ChatHub.cs:169-170), which queues a scrape per link (ChatService.cs:566-578). The `LinkPreview` HTTP client has a 10 s timeout (Program.cs:108).
- When a scrape ends, the broadcaster sends `previews` per message (ChatHubBroadcaster.cs:53).
- The client's stored tail keeps the cards it had; the server's tail without cards replaces it (timeline.js compares rows by JSON), so a stored card disappears and returns later.

## Why it costs the user time
Every conversation with links that nobody opened within the last hour, and every conversation after a deploy, opens with bare links. The cards appear only after the server fetched each page again, which can take seconds, and each card then pushes the rows. For the far user the wait adds to the 900 ms round trips, and on a phone the late growth of rows moves what they read.

## The change
- Small (S): raise `CacheTtl` for successful cards to, for example, 7 days, keep one hour for failed scrapes, and cap the dictionary (for example 10,000 entries; on overflow drop the oldest by `FetchedAt`). This covers the hourly expiry, not the restart.
- Full (M to L): store the card fields as a memory-first copy (a `Writes.LinkPreview` row in the PersistenceWriter, loaded at startup with the messages), so a restart keeps them too. Nothing awaits the database, which fits the memory-first doctrine; with persistence off, the cards last until restart as today.

## Risks and what could break
- Freshness: a page that changes its og:title or image keeps the old card for the new TTL (that is why this is category 3).
- Memory: a capped dictionary bounds it.
- The media-cache attach (`AttachMedia`) uses the same TTL through `GetOrCreatePreview`; keep both rules in one place.

## How to measure it
Open a link-heavy conversation more than an hour after its last view on the throttled link: time from the `rows` phase to the last card on screen, and the count of `previews` events. After a deploy, the same.
