---
id: backend-media-18
title: Read the favourites folder map once per request, not once per card
area: backend-media
journey: picker-gif
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The work is quadratic in the number of favourites. At 300 favourites, 300 dictionary copies of 300 entries (90,000 inserts, about a millisecond); at 3,000 (pack imports), 9 million inserts plus the garbage, plausibly 100 ms or more of server CPU per /favorites or /library call (estimate, needs measurement).
confidence: high
files: [Yap/Endpoints/GifEndpoints.cs:80-87, Yap/Endpoints/AdminEndpoints.cs:285-306, Yap/Services/Gifs/GifService.Library.cs:84-89, Yap/Services/Gifs/GifService.cs:321-325]
---

## What the code does now
Each card does:
```csharp
lib.IsFavorite(viewerId, e.Id),
lib.GetFavoriteFolderMap(viewerId).GetValueOrDefault(e.Id), ...
```
(GifEndpoints.cs:84-85), and `GetFavoriteFolderMap` copies the whole map under its lock: `lock (map) return new Dictionary<Guid, string?>(map);` (GifService.Library.cs:88). `IsFavorite` takes the same lock per card (GifService.cs:321-325). `/favorites`, `/server`, `/library` and `/search` map every entry through `Card`. The admin's GIFs table does it for every entry of the whole library: `card = GifEndpoints.Card(e, me.Id(), gifs, users)` (AdminEndpoints.cs:299), so its cost is the library size times the admin's favourites.

## Why it costs the user time
The answer waits for the CPU work, and the far user waits one round trip on top. Favourites have no limit (PK-35), and a pack import favourites every file it imports (GifService.Library.cs:364), so a big library makes every picker open and every star change (which reloads `/favorites`) slower for that user, and takes CPU from everyone else.

## The change
In each route, take the map once: `var folders = lib.GetFavoriteFolderMap(me.Id());` and pass it to `Card`, which then uses `folders.TryGetValue(e.Id, out var folder)` for both `Favorite` and `Folder`. About 10 lines in GifEndpoints.cs and AdminEndpoints.cs (which calls `Card` the same way).

## Risks and what could break
None; the values are the same, read from one snapshot instead of many.

## How to measure it
Time the `/api/gifs/favorites` handler for an account with 3,000 favourites (a pack import of a test zip), before and after.
