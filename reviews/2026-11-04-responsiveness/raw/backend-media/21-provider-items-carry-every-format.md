---
id: backend-media-21
title: Send provider GIFs to the picker as a lean card, and send back only the source id
area: backend-media
journey: picker-gif
category-guess: 1
behaviour-change: none
effort: M
estimated-gain: Unknown, needs one look at a real answer. Each item carries every format of two Klipy tiers (up to 8 entries with a full CDN URL, type, width, height, size) plus title and tags; the picker uses one preview URL, the size and the title. An estimate of 50 KB raw per page of 30 against about 8 KB lean, on every picker open, every search pause and every "Load more". The send POST and the outbox row also shrink by 1 to 2 KB per provider GIF.
confidence: medium
files: [Yap/Services/Gifs/KlipyGifProvider.cs:272-349, Yap/Services/Gifs/GifSourceModels.cs:3-27, Yap/Endpoints/GifEndpoints.cs:30-50, Yap/Endpoints/GifEndpoints.cs:105-107, Yap/Endpoints/MessagesEndpoints.cs:41-49, Yap/wwwroot/js/ui/gif-picker.js:236-254, Yap/wwwroot/js/sender.js:47-52]
---

## What the code does now
- `ParseResultItem` keeps every playable format of the `md` tier as `Formats` and of the `sm` tier as `PreviewFormats` (mp4, webm, gif, webp each; KlipyGifProvider.cs:290-321), plus `Tags` and `Title`.
- The routes return the items as they are: `new ProviderPageDto(page.Items, page.NextCursor)` and `new SearchDto(library, provider.Items, provider.NextCursor)` (GifEndpoints.cs:34, 49).
- The picker uses one of them: `const formats = item.previewFormats?.length ? item.previewFormats : item.formats ?? []; const video = formats.find(...)` (gif-picker.js:250-253), plus `item.width`, `item.height`, `item.title`.
- A send posts the whole item back: `const gifRequest = g => g.entryId ? {...} : { provider: g.provider, searchText: g.searchText };` (sender.js:52), and stores it in the outbox. The server uses the client's item only for its `SourceId`: `var shown = _shownItems.TryGetValue(item.SourceId, ...); ... item = shown ?? item;` (GifService.cs:352-355).

## Why it costs the user time
Every provider page and every search answer carries about eight long CDN URLs per item that the client never uses. The far user pays about 8 ms per KB on the critical path of each grid. The send POST also carries them up (upload is often the slower direction on mobile).

## The change
- GifEndpoints.cs: map provider items to `ProviderCardDto(SourceId, Title, Width, Height, PreviewUrl, PreviewIsImage)`, choosing the preview on the server with the same rule as `bestPreview` (first video of the preview tier, else the first format). Keep the full items server-side in `_shownItems` as today.
- gif-picker.js: read `item.previewUrl`/`item.previewIsImage` instead of `bestPreview(item)`.
- sender.js and `GifRequest`: send `{ sourceId }` instead of the item; `SendProviderGif` takes the id. The outbox rows written by an old client still carry `provider` objects; accept both for a while (`gif.Provider?.SourceId ?? gif.SourceId`).
About 40 lines in four files.

## Risks and what could break
- The send path after a server restart: today, too, the server refuses an id it never showed and never cached (`if (shown is null && existing is null) return null;`), so a lean request changes nothing there.
- Outbox rows queued before the deploy (offline) must still send; hence the dual read.

## How to measure it
Capture one `/api/gifs/trending` answer in production DevTools: raw and transfer size, before and after. Count bytes of the send POST for a provider GIF.
