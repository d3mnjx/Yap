---
id: backend-media-25
title: Measure Klipy's MP4 against the animated WebP the GIF rows load, and consider the MP4 for rows
area: backend-media
journey: all
category-guess: 3
behaviour-change: Provider GIF rows play as muted looping videos instead of images; in iOS Low Power Mode a video may not autoplay and needs a tap.
effort: L
estimated-gain: Unknown, needs measurement. Klipy reports each format's size in the item (`size`, parsed into `MediaFormat.SizeBytes`), so the ratio of the `md` WebP to the `md` MP4 can be logged without any client change. Video codecs are usually several times smaller than animated WebP for the same clip. The far reader pays the GIF bytes for every GIF row in view.
confidence: low
files: [Yap/Services/Gifs/GifService.cs:871-875, Yap/Services/Gifs/GifService.cs:961-980, Yap/Services/Gifs/KlipyGifProvider.cs:285-306, Yap/wwwroot/js/ui/message.js:174-195]
---

## What the code does now
- For the row file, the entry prefers an animated image: `entry.RemoteGifUrl = formats.FirstOrDefault(f => f.ContentType == "image/webp")?.Url ?? formats.FirstOrDefault(f => f.ContentType == "image/gif")?.Url;` (GifService.cs:874-875), from the `md` tier (KlipyGifProvider.cs:286-294; the comment there: "gif is ~3x smaller than hd (5MB vs 17MB on the cat example), while mp4/webm are byte-identical between tiers").
- The cache download keeps that file as it is (GifService.cs:966-979), and `Src` prefers `GifUrl`.
- The row draws it with `<img loading="lazy">` (message.js:181), at most 360 CSS px wide (line 176).
- The design reason is in the code: `<img>` has no autoplay policy (GifService.cs:963-965). The picker already uses `<video autoplay muted loop>` previews (gif-picker.js:258).

## Why it costs the user time
Animated WebP and GIF encode each frame on its own; MP4 (H.264) predicts frames from each other. For the same clip the image formats are often several times larger. Every reader of a GIF row pays the bytes; on a 1 Mbit/s link each MB is 8 s, and a busy room has many GIF rows.

## The change
Step 1 (no visible change, S): in `RememberShown`, log the `md` WebP and MP4 `SizeBytes` of each item for a day, and look at the ratio.
Step 2 (only if the ratio is large): store the MP4 as the row file for provider GIFs (the entry has `RemoteMp4Url` and `Mp4Url` slots already) and render rows with the picker's muted looping video; keep the WebP for the picker preview fallback and for custom uploads.

## Risks and what could break
- Autoplay: muted inline video autoplays in Chrome, Firefox and Safari, but not in iOS Low Power Mode; the picker already lives with that (PK-19).
- Many concurrent videos in a long history cost decoders; rows would need the in-view start of finding 22.
- This reverses a deliberate design choice; it is the user's call.

## How to measure it
The log of step 1. Then, journey "warm-open" in a GIF-heavy room on a throttled link: bytes in the first screen.
