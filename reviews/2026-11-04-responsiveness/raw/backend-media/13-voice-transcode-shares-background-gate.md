---
id: backend-media-13
title: Keep voice transcodes out of the queue that background GIF work fills
area: backend-media
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Unknown; zero on a quiet server. In a burst (after a deploy with a preview backfill, or while new provider GIFs normalize) a voice message waits for every ffmpeg job queued before it, about 0.5 s each per the code comment, two at a time. The sender's voice row stays "uploading" for that time.
confidence: low
files: [Yap/Services/Gifs/GifFfmpegHelper.cs:14, Yap/Services/Gifs/GifFfmpegHelper.cs:137-172, Yap/Services/Media/VoiceService.cs:32-48, Yap/Services/Gifs/GifService.cs:144-178, Yap/Services/Gifs/GifService.cs:947-1012]
---

## What the code does now
- One gate of two for these ffmpeg runs: `private readonly SemaphoreSlim _transcodeSemaphore = new(2);` (GifFfmpegHelper.cs:14), used by `LimitedAsync` (lines 167-172).
- The voice transcode, which the sender waits for, goes through it: `await ffmpeg.LimitedAsync(() => ffmpeg.RunProcessAsync("ffmpeg", args, TranscodeTimeoutMs, ct), ct);` (VoiceService.cs:40).
- Background work goes through the same gate: the startup preview backfill (GifService.cs:171-178, one at a time), the startup normalization of provider entries, one `Task.Run` per entry, all at once (lines 147-153 and 947-958), and the normalization of every newly sent provider GIF with its preview (lines 961-1016).
- `SemaphoreSlim` hands the slots to async waiters in arrival order, so a voice job waits behind everything queued before it.

## Why it costs the user time
A voice message is posted only after the transcode (TusEndpoints.cs:188-206). The sender sees the pending row until then, and the receivers get the message later. The background jobs have no deadline; the voice job has a person waiting.

## The change
Give the background work its own gate of one, and leave the shared gate of two for the work a person waits for (voice, the transcode of a GIF upload). In GifFfmpegHelper: a second `SemaphoreSlim(1)` and a `LimitedBackgroundAsync` used by `NormalizeProviderEntryAsync` and the backfills (via a flag on `TranscodeToPreviewWebpAsync`/`TranscodeToAnimatedWebpAsync`). The process-wide cap becomes three encoders instead of two; or keep two by making the background gate wait for a free foreground slot too. About 15 lines.

## Risks and what could break
- One more encoder at a time raises peak CPU (see finding 12 for the priority).
- The comment on `LimitedAsync` says "a burst of either must not start more encoders than the box has cores"; the new gate must keep that promise.

## How to measure it
Log the gate wait inside `LimitedAsync` (time from call to slot) with the caller's name. Read it after a deploy that triggers a backfill and on a busy day.
