---
id: backend-services-17
title: Leave the users directory out of the bootstrap when the client's copy is current (a directory stamp, like emojiStamp)
area: backend-services
journey: resume
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The bootstrap sends every account (username, display name, avatar URL, bio, location, createdAt, two flags; about 230 to 380 bytes of JSON each) after every connect and reconnect, in parallel with openRoom on the same slow link. Estimated 90 to 120 bytes per account after compression: about 10 KB at 100 accounts (80 ms at 1 Mbit/s) and about 100 KB at 1,000 accounts (0.8 s). Because the two downloads share the link, the rows arrive later by part of that. Unknown real account counts per instance.
confidence: medium
files: [Yap/Endpoints/BootstrapEndpoints.cs:33-66, Yap/Models/Accounts/UserDto.cs:4-8, Yap/Services/Accounts/UserService.cs:27, Yap/Services/Emoji/EmojiImages.cs:46-50]
---

## What the code does now
- `Users: users.GetAllUsers().Select(u => UserDto.From(u, users.IsAdmin(u.Id), bot.IsBotUser(u.Username))).ToList()` (`BootstrapEndpoints.cs:58`).
- `UserDto(string Username, string? DisplayName, string? AvatarUrl, string? Bio, string? Location, DateTime CreatedAt, bool IsAdmin, bool IsBot)` (`UserDto.cs:4`).
- The client fetches the bootstrap after every hub connect (`js/hub.js:120`) and also gets `profile` and `accountDeleted` events live (`ChatHubBroadcaster.cs:67`, `:70`).
- The emoji rules already use the pattern this finding proposes: the client names the stamp it holds and the server sends null while it matches (`BootstrapEndpoints.cs:65`, `EmojiImages.cs:46-50`).

## Why it costs the user time
On a reconnect the client already holds the directory from its last bootstrap plus the live `profile` events. Resending it costs bandwidth exactly while the user waits for rows.

## The change
- `UserService` keeps a directory stamp: a random value per process start plus a counter bumped on every create, profile change, removal and admin change.
- The bootstrap accepts `?usersStamp=` and returns `users: null` and the current stamp when they match.
- The client keeps its stored users when it gets null (client area), and stores the stamp with the bootstrap.
Bio, location and createdAt could also move to the profile card on demand, but the stamp alone removes the repeat cost without a new request.

## Risks and what could break
- A missed bump leaves a stale name or avatar until the next process start; every write path to the profile fields must bump (UpdateProfile, CreateUser, Remove, RevokeAdmin).
- The first load and each process restart still send the whole list.

## How to measure it
Bootstrap response size (transferSize) per reconnect, and the AD-41 `rows` phase on a server with many accounts under the 1 Mbit/s throttle.
