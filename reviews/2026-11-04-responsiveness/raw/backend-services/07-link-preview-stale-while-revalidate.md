---
id: backend-services-07
title: Keep link cards longer than one hour and serve an expired card while it is fetched again, so rows do not lose their card and redraw twice
area: backend-services
journey: switch-room
category-guess: 3
behaviour-change: A card older than the cache window shows its last known title, picture and description instead of disappearing for a moment; its content may be up to the new window old.
effort: S
estimated-gain: For every row with a link whose card is older than one hour, an open today draws the row without the card, then the card arrives seconds later (a remote page fetch with a 10 s timeout) and the row redraws again. With the change the row matches the device copy, the timeline's "unchanged" check keeps it, and no remote fetch runs on the open. Saves two row redraws and a card pop-in per link row per open, plus one outbound fetch per link per hour. Who pays: everyone who opens a room with links more than an hour after the link was scraped.
confidence: high
files: [Yap/Services/Chat/LinkPreviewService.cs:21, Yap/Services/Chat/LinkPreviewService.cs:80-91, Yap/Services/Chat/LinkPreviewService.cs:134-166, Yap/Services/Chat/ChatService.cs:566-597, Yap/Endpoints/ChatHub.cs:165-172]
---

## What the code does now
- `private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);` (`LinkPreviewService.cs:21`).
- `GetCachedPreview` deletes an expired entry and returns null: `_cache.TryRemove(url, out _); ... return null;` (`:84-90`).
- `Open` calls `chat.EnsurePreviews(messages)` and then maps the rows (`ChatHub.cs:169-170`). `EnsurePreviews` queues a fetch for each link whose card is not in memory (`ChatService.cs:574`), and `Previews(m)` in the mapper then finds nothing and the row goes out with `previews: []` (or a card with only the cached media, `ChatService.cs:590`).
- When the fetch finishes, `OnPreviewsReady` broadcasts `previews` to the room (`ChatHubBroadcaster.cs:53`), and the client replaces the row (`store.js:224-229`).
- The client compares each server row with the stored copy by `JSON.stringify` and keeps unchanged rows (`ui/timeline.js:43`). The stored copy has the card; the server row does not, so the row is redrawn without its card.

## Why it costs the user time
The user sees the card vanish and come back seconds later, the row height changes twice (scroll position work in the timeline), and the server makes a remote request per link per hour per open. On a phone each redraw of a row with images costs layout and image requests.

## The change
In `LinkPreviewService`:
1. Raise `CacheTtl` to, for example, 24 hours (a deployment choice).
2. Add a `FreshFor` window (for example 1 hour). `GetCachedPreview` returns the entry whatever its age and never removes it; a new `IsStale(preview)` says whether it is older than `FreshFor`.
3. `ChatService.EnsurePreviews` queues a fetch when the card is missing or stale (`QueueFetch` already dedupes by URL); `QueueFetch`'s early "already cached" branch must not fire for a stale entry.
4. A failed refetch keeps the old good entry instead of replacing it with `Failed = true`.
About 15 lines in two files. Comment at the TTL: serving the stale card is what keeps the client's "unchanged" check true.

## Risks and what could break
- A card whose page changed shows old text until the background fetch lands and the `previews` event replaces it.
- Memory: entries live longer; the dictionary is never trimmed today either (one entry per URL ever seen). A size cap may be wanted.

## How to measure it
Open a room with link rows after the cache window passed: count `previews` events and row redraws (Performance panel, or the Settings debug card), and server outbound fetches in the log, before and after.
