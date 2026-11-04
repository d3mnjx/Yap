---
id: backend-request-04
title: Start listening sooner after a deploy: the log clean-up and three child-process probes run in series before Kestrel opens
area: backend-request
journey: resume
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The server accepts connections earlier by the clean-up time plus the sum of the probes minus the longest one. Each probe may take up to its 3 s timeout. The client retries at 1, 3, 7, 15 and 31 s after the drop (delays 1, 2, 4, 8, 16 s), so one second saved at the edge can move a reconnect from the 15 s try to the 7 s try for everyone. Unknown, needs the startup log timestamps.
confidence: medium
files: [Yap/Program.cs:208-226, Yap/Program.cs:440, Yap/Services/Admin/UserActionLogService.cs:45-90, Yap/Services/Chat/MediaCacheService.cs:57-110, Yap/Services/Media/VideoService.cs:24-66, Yap/Services/Gifs/GifFfmpegHelper.cs:22-60, Yap/Dockerfile:15-18, Yap/wwwroot/js/hub.js:157-162]
---

## What the code does now
- Kestrel starts at `app.Run()` (Program.cs:440). Before it, Program.cs awaits in series: migrations, users, links, mutes, the chat load, the GIF load, push subscriptions, the bot, then `await app.Services.GetRequiredService<UserActionLogService>().CleanupAsync();` (Program.cs:212-226).
- `CleanupAsync` runs `ExecuteDeleteAsync` for rows older than six months, a `GroupBy(l => l.UserUid).Where(g => g.Count() > 100)` over the whole table, and a trim per user (UserActionLogService.cs:45-90). The table gets one HTTP_REQUEST row per API request (RequestLoggingMiddleware.cs:109-114), 88 % of the rows in the dev database.
- Resolving ChatService constructs MediaCacheService, whose constructor runs `DetectYtDlp()` (MediaCacheService.cs:66): a `yt-dlp --version` child process with `WaitForExit(3000)` (line 96). The image ships `yt-dlp_linux`, a PyInstaller build (Dockerfile:15-18), which unpacks itself at each start (start time not measured here).
- VideoService's constructor runs `ffmpeg -version` with `WaitForExit(3000)` (VideoService.cs:34-56). GifFfmpegHelper does the same again (GifFfmpegHelper.cs:52). All three run one after the other on the start path.
- The client retries with `Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5))` (hub.js:160).

## Why it costs the user time
After each deploy every client is disconnected until Kestrel listens. Work that only maintains a log, and probes that could run side by side, extend that window. Because of the exponential backoff, a longer window costs more than its own length: a client that misses the 7 s try waits until the 15 s try. Everyone connected at deploy time pays, the far user most because each try also costs round trips.

## The change
- Program.cs: run the clean-up after start: `app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(() => app.Services.GetRequiredService<UserActionLogService>().CleanupAsync()));`. It is maintenance; nothing reads its result.
- Run the three probes in parallel before the chat load: `await Task.WhenAll(Task.Run(() => app.Services.GetRequiredService<VideoService>()), Task.Run(() => app.Services.GetRequiredService<GifFfmpegHelper>()), Task.Run(() => app.Services.GetRequiredService<MediaCacheService>()));` Each singleton is then built once, and the later resolutions reuse it. Keep the existing comments about why the probe runs at start.

## Risks and what could break
- The clean-up then runs while requests write action-log rows. SQLite serializes writers; the PersistenceWriter may wait on the lock for the clean-up's duration (it retries in its pass; check its busy timeout).
- Parallel singleton construction: each service is resolved on its own thread; MediaCacheService depends on VideoService, so the container builds VideoService once and the other task waits (the default container locks per service). Verify with a start-up test.
- A start without ffmpeg or yt-dlp still logs the same warnings.

## How to measure it
The startup log: the time from the process start to "Now listening on". Compare before and after on the production image. In the field: the `reconnect` wait (AD-26) of the sessions right after a deploy.
