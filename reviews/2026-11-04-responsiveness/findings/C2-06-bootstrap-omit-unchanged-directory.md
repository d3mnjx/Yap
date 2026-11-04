---
id: C2-06
title: Leave the unchanged users directory, texts and themes out of the reconnect bootstrap
category: 2
journey: resume
effort: M
confidence: medium
behaviour-change: none
estimated-gain: The users list on every reconnect. Estimate (not measured) from UserDto: 150 to 200 bytes of JSON per account, so about 150 to 200 KB raw and roughly 30 to 40 KB compressed at 1,000 accounts, 250 to 320 ms at 1 Mbit/s, plus the JSON parse, the `users` rebuild and the listeners on the phone. Texts and themes add about 4 KB raw. Small servers gain little.
experiment: none
sources: [client-core-05, backend-services-17, backend-services-18, backend-request-21]
files: [Yap/Endpoints/BootstrapEndpoints.cs:216-232, Yap/wwwroot/js/hub.js:84-90, Yap/wwwroot/js/store.js:36-49]
---

## What the code does now
The bootstrap already skips the largest static part when the client holds it (BootstrapEndpoints.cs:232, hub.js:87-90):

```cs
EmojiImages: images.Rules.Stamp == emojiStamp ? null : images.Rules));
```

Everything else is sent in full at every connect, including after every reconnect of a phone:

```cs
Users: users.GetAllUsers().Select(u => UserDto.From(u, users.IsAdmin(u.Id), bot.IsBotUser(u.Username))).ToList(),
```

plus `Texts: config.Texts()` (the funny-text lists, about 2.7 KB in the default `appsettings.json`) and `config.Themes` (`ThemeRegistry.All`, 11 entries, read only by Settings and Admin). `store.applyBootstrap` (store.js:42) rebuilds the users map with `Object.fromEntries(doc.users.map(...))` and fires `users`, which runs `renderPeople`, `renderChip`, `renderTitle`, the timeline's `redrawIfRowsChanged`, the composer's `renderTyping` and the snapshot write.

## Why it costs the user time
The directory changes rarely (a new account, a profile edit), and while connected the hub's `profile` and `accountDeleted` messages keep it current. A reconnect after a sleep still downloads the whole directory. On a server with many accounts this is the bulk of the bootstrap. For the far user on 1 Mbit/s it competes with the `openRoom` answer for the link, and the parse and the listeners run on the phone's main thread just when the rows arrive.

## The change
Use the same mechanism as `emojiStamp`:
1. Server: keep a directory version in `UserService` (a counter bumped on every create, delete, profile change, admin or bot flag change; start it at the process start time so a restart never matches an old value). Return it as `usersStamp`; return `users: null` when the request's `usersStamp` equals it.
2. Same for a `staticStamp` covering `texts` and `config.themes` (a hash of both, computed once per process, since the texts come from `appsettings.json` and change with a restart, not with the build).
3. Client: `bootstrapUrl()` adds the stamps the store holds; `applyBootstrap` keeps `state.users` (and texts, themes) when the answer has null, like `emojiImages` today (store.js:39); it fires `users` only when the list came.

## Risks and what could break
- A change path that forgets to bump the counter leaves a stale name or avatar on the device until the next full answer. Profile picture URLs are stable (`/uploads/profiles/{id}.webp`, see static-asset-caching), so a new picture does not need a directory change, only the cache's 300 s.
- The stored bootstrap must keep the full directory; `saveBootstrap` in hub.js:128 already re-adds `emojiImages` from the store and must do the same for `users`.
- Presence, unread, dms, rooms and mutes stay in every answer: they change during a sleep.

## How to measure it
Journey resume on a server with many accounts (the load-test setup with 1,000 users). Read the transfer size of `/api/bootstrap?emojiStamp=...` after a reconnect before and after, and the time from the socket to the bootstrap mark.

## Also found by

The same finding, from another reader's angle: `raw/backend-services/17-bootstrap-users-stamp.md`, `raw/backend-services/18-bootstrap-static-parts.md`, `raw/backend-request/21-bootstrap-static-parts.md`. The raw files hold their reasoning and numbers.
