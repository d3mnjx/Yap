---
id: backend-request-21
title: Stop resending texts and themes in every bootstrap, and stop binding the text lists per request
area: backend-request
journey: resume
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: A synthetic bootstrap for 30 people, 10 rooms and 5 direct messages is 14,618 B raw, 4,910 B at gzip -1. Texts (710 B) and themes (512 B) are about a quarter of the compressed size and change only at a restart or config reload: about 10 ms per connect at 1 Mbit/s. Plus 12 configuration binds per request (CPU, small). The users list is the largest part (1,833 B of 4,910) and grows with the server (about 60 KB compressed at 1,000 people, estimate).
confidence: medium
files: [Yap/Endpoints/BootstrapEndpoints.cs:41-66, Yap/Configuration/ServerConfig.cs:17-36, Yap/Services/Accounts/ThemeRegistry.cs:24-100, Yap/Services/Emoji/EmojiImages.cs:46-50, Yap/wwwroot/js/hub.js:84-90]
---

## What the code does now
- The bootstrap builds `Config: new ClientConfigDto(..., BuildInfo.Time, gate.SmartMode, ThemeRegistry.All)` and `Texts: config.Texts()` on every request (BootstrapEndpoints.cs:51-56). `ThemeRegistry.All` is 11 fixed entries.
- `ServerConfig.Texts()` calls `List(...)` 12 times; each is `configuration.GetSection($"ChatSettings:FunnyTexts:{key}").Get<string[]>()` (ServerConfig.cs:17-36), a configuration binder call per list per request.
- The emoji image rules already use a stamp: `EmojiImages: images.Rules.Stamp == emojiStamp ? null : images.Rules` (BootstrapEndpoints.cs:65); the client sends `?emojiStamp=` (hub.js:84-90).
- The client fetches the bootstrap after every connect (hub.js:119-120), on a phone many times a day.
- Sizes from a synthetic document in the server's shape (30 people with avatars, a third with a bio; texts from appsettings.json): user 363 B, config 705 B (themes 512 B inside), texts 710 B, rooms 564 B, users 1,833 B, the rest under 300 B each (gzip -1).

## Why it costs the user time
On each reconnect the far user downloads unchanged texts and themes again. The bootstrap runs in parallel with openRoom and competes with it for the link. The gain is small at 30 people.

## The change
- Category 1 part: compute `Texts()` once and recompute on configuration change (`ChangeToken.OnChange(configuration.GetReloadToken, ...)`), so a request reads a field.
- Category 2 part: extend the stamp idea. Hash texts plus themes (plus the project name) into a `staticStamp`; the client sends it like `emojiStamp`; the server sends `texts: null` and `config.themes: null` when they match, and the client keeps its stored copy. The stored bootstrap already holds them (hub.js saves the merged document).
- The users list could follow the same idea at scale (a stamp of the directory, or a delta since a version), but that is a larger design and not needed at 30 people.

## Risks and what could break
The client must merge a null part with its stored part (as it does for `emojiImages`). A device without a stored copy sends no stamp and gets everything.

## How to measure it
Bootstrap response size per connect (RequestLogs CSV has no size; use the browser's network panel or the boot report's `bytes`).
