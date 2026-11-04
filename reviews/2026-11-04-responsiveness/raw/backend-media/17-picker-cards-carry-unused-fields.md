---
id: backend-media-17
title: Send the GIF picker a lean card without tags and library-only fields
area: backend-media
journey: picker-gif
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown, depends on the tag count per GIF. Tags grow with use (search texts, provider titles, up to 12 provider keywords per send or star), and the picker never reads them. An estimate of 30 to 50 % of the bytes of /favorites and /server, which have no paging (PK-35 "no limit on favourites"; pack imports add up to 1,000 at a time).
confidence: medium
files: [Yap/Endpoints/GifEndpoints.cs:21-28, Yap/Endpoints/GifEndpoints.cs:80-87, Yap/Endpoints/GifEndpoints.cs:100-101, Yap/wwwroot/js/ui/gif-picker.js:140-166, Yap/wwwroot/js/ui/gif-picker.js:214-233]
---

## What the code does now
- `/api/gifs/recent`, `/favorites` and `/server` all map entries with `Card(...)` (GifEndpoints.cs:21-28), which returns `GifCardDto(Id, Preview, Src, IsImage, Width, Height, Favorite, Folder, Tags, IsServer, ServerFolder, Uploader, Mine, SizeBytes)` (lines 84-86, 100-101).
- The picker reads `id`, `preview`, `src`, `isImage`, `width`, `height`, `folder` and `serverFolder` (gif-picker.js:145-162, 216-229). It takes the star state from `state.favoriteGifIds`, not from `favorite` (line 219). `tags`, `mine`, `uploader`, `sizeBytes`, `isServer` and `favorite` are used only by Settings (gif-library.js:46-58, 103-138), which calls `/api/gifs/library` and the admin route.
- `Src` and `Preview` repeat the entry id inside their paths.
- `/favorites` and `/server` return every entry with no paging.

## Why it costs the user time
The three requests run in parallel at the first picker open, and today the trending request waits for them (finding 16). The far user pays about 8 ms per KB. A user with hundreds of favourites downloads every tag of every favourite on each first open per page load, and again on every star change (`on('favoriteGifIds', ...)` reloads `/favorites`, gif-picker.js:293).

## The change
GifEndpoints.cs: a `PickerCardDto(Id, Preview, Src, IsImage, Width, Height, Folder)` for `/recent`, `/favorites` and `/server`, where `Folder` is the favourite folder or the server folder (the picker reads `g.folder ?? g.serverFolder`). Keep `GifCardDto` for `/library` and `/search` (its library list could take the lean card too; the picker does not read tags there either). gif-picker.js keeps working with one field rename or none. About 15 lines.

## Risks and what could break
- Any other client of these routes: only gif-picker.js calls them (grep). The browser tests in tests/browser may assert on the shape; check them.

## How to measure it
For an account with many favourites, compare the compressed size of `/api/gifs/favorites` before and after (DevTools, transfer size), and the time to the first picker render on a throttled link.
