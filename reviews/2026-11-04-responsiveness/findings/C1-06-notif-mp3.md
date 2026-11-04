---
id: C1-06
title: Strip the cover art from notif.mp3 and re-encode it (43.9 KB to 9.8 KB)
category: 1
journey: cold-open
effort: S
confidence: high
behaviour-change: none expected (a 0.75 s chime at 96 kb/s instead of 320 kb/s; check by ear)
estimated-gain: "-11.4 KB with a lossless remux that only drops the embedded picture; -34.1 KB at 96 kb/s stereo; -37.3 KB at 64 kb/s mono. The file loads at the first tap or key press of a first visit and in the worker's first install; 34 KB is about 270 ms at 1 Mbit/s."
experiment: E05
sources: [client-static-07]
files: [Yap/wwwroot/notif.mp3, Yap/wwwroot/js/notify.js:19-26, Yap/Endpoints/ShellAssets.cs:30]
---

## What the code does now
- `notif.mp3` is 43,860 B. `ffprobe`: duration 0.75 s, stream 0 MP3 at 320 kb/s stereo, stream 1 a 512 x 512 PNG "attached pic" (cover art). The audio alone is about 30 KB; the picture and tags are the rest.
- `notify.js:19-26`: on the first `pointerdown` or `keydown`, `new Audio('/notif.mp3')` with `preload = 'auto'` and `load()`.
- The worker precaches root `*.mp3` (`ShellAssets.cs:30`), so a first visit also fetches it during the install.
- Measured in the scratchpad with ffmpeg: audio copied without the picture 32,435 B; 96 kb/s stereo 9,761 B; 64 kb/s mono 6,521 B.

## Why it costs the user time
On a first visit the first tap is usually the user's first action (open a room, start a draft). The sound's download starts in the same moment and shares the link with what that action needs (`openRoom`, emoji, avatars). Who pays: first visits on the far link.

## The change
Replace the file. Lossless first step: `ffmpeg -i notif.mp3 -map 0:a -map_metadata -1 -c:a copy notif.mp3.new`. Smaller step: `-map 0:a -map_metadata -1 -b:a 96k`. Keep the name and the MP3 format (Safari). No code change.

## Risks and what could break
Audible quality at 96 kb/s: listen on a phone speaker and on headphones. The name stays, so a browser with the old file in its HTTP cache keeps it until the cache expires (the file has no Cache-Control).

## How to measure it
Resource timing of `notif.mp3` in a throttled first visit, around the first tap; its overlap with the `open` wait.