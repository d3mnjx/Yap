---
id: C2-34
title: A newly sent provider GIF is downloaded twice by every reader (Klipy URL first, /gif-cache later)
category: 2
journey: picker-gif
effort: M
confidence: medium
behaviour-change: none
estimated-gain: One full GIF download per reader for each provider GIF that is sent for the first time on the server. The file is Klipy's `md` tier (hundreds of KB to a few MB, unknown; the comment in KlipyGifProvider says 5 MB for the `md` GIF of one example, and the WebP is preferred). For the far reader, seconds per GIF.
experiment: none
sources: [backend-media-24]
files: [Yap/Services/Gifs/GifService.cs:347-388, Yap/Services/Gifs/GifService.cs:947-1016, Yap/Models/Gifs/GifEntry.cs:44-49, Yap/Services/Chat/MessageMapper.cs:67-78]
---

## What the code does now
- `SendProviderGif` creates the entry with only remote URLs and queues the download in the background: `if (NeedsBackgroundNormalization(entry)) QueueNormalization(entry);` then returns at once (GifService.cs:381-387).
- The row's file is `public string? Src => GifUrl ?? RemoteGifUrl ?? ...;` (GifEntry.cs:46), resolved at mapping time (MessageMapper.cs:73). So the send answer and the broadcast carry Klipy's URL.
- When the download ends, `entry.GifUrl = $"/gif-cache/{entry.Id}{ext}"` (GifService.cs:977) and `PersistFormats`. Nothing tells the open clients.
- The next mapping of that message (an `openRoom`, an older page, a reload) carries `/gif-cache/...`. The timeline sees a changed row and draws it again, and the `<img>` fetches the new URL (the worker's media cache misses, it has never seen it).

## Why it costs the user time
Every reader who saw the row live downloads the GIF from Klipy, then downloads the same bytes again from this server on the next open. For the far reader this is the largest single cost of a GIF send, paid twice. The stored snapshot also keeps the Klipy URL until the server's rows replace it.

## The change
Two options; the first is simpler.
1. Wait briefly for the download before broadcasting a new provider GIF: in the send route, when `SendProviderGif` created the entry, await its normalization task for at most about 2 s (keep the task in a dictionary by entry id), then map. The download runs server-to-CDN and is usually fast; on a timeout the row carries the Klipy URL as today.
2. Keep the Klipy URL for that message for good (store the chosen URL on the attachment), so the row never changes; then `/gif-cache` serves only later sends of the same GIF.
Option 1 is about 20 lines in GifService and MessagesEndpoints.

## Risks and what could break
- Option 1 delays the sender's confirmation and the readers' row by the download time for a GIF new to the server (the sender's pending row shows the preview meanwhile, so the tap does not wait). It does not touch the database (memory-first doctrine holds).
- Where the deployment has no edge cache, the far reader may get the first view faster from Klipy's CDN than from this server; option 2 keeps that.

## How to measure it
Send a provider GIF that the server has never seen; on a second device, count the requests for it across one live view and one reload (DevTools, "img" filter).