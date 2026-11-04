---
id: C1-39
title: Redraw timeline rows only for the person whose profile changed
category: 1
journey: all
effort: S
confidence: high
behaviour-change: none
estimated-gain: Removes a full redraw of every loaded row when someone who has no row on screen changes a bio, a location or joins the server. Removes one JSON string of all accounts (570 KB for 2,000 accounts, 5.9 ms per call in a sandbox V8 check) on every bootstrap (twice), every reset, every profile event and every emoji use. On a phone these are likely 20 ms or more each; a full redraw also re-requests every emoji image and restarts every GIF video.
experiment: none
sources: [client-render-04]
files: [Yap/wwwroot/js/ui/timeline.js:109-119, Yap/wwwroot/js/ui/timeline.js:71, Yap/wwwroot/js/ui/timeline.js:512-514, Yap/wwwroot/js/store.js:314-321, Yap/Models/Accounts/UserDto.cs:4]
---

## What the code does now
The rows remember a string of everything about every account (`timeline.js:113`):

```js
const rowFacts = () => JSON.stringify([Object.keys(state.users).sort().map(k => state.users[k]), state.emoji?.quickReactions]);
```

`redrawIfRowsChanged` builds this string on every `users` and `emoji` change and redraws every row when it differs (`timeline.js:114-119`, `redrawAll` at `103-107`). `reset()` builds it too (`timeline.js:71`). `store.setUser` fires `users` for one person's `profile` event (`store.js:314-316`). `UserDto` carries `Bio`, `Location` and `CreatedAt` (`UserDto.cs:4`), which no row shows.

## Why it costs the user time
Three costs:
1. The string. 2,000 accounts give a 570 KB string; a sandbox V8 check measured 5.9 ms per call (desktop, a check only). It runs twice per bootstrap (`users` and `emoji`), at every reset (every open and every server answer), at every `profile` event, and at every `me` event with emoji (every reaction and every picker pick records a use, `ChatHubBroadcaster.cs:72`).
2. The full redraw. A change to any account, even one with no row in this conversation (a new sign-up, a bio edit), rebuilds every loaded row. A rebuild creates every emoji `<img>` again (a request each on WebKit) and every GIF `<video>` again (a new load and a restart).
3. Memory: `drawnFacts` keeps the 570 KB string.

Who pays: everyone on a server with many accounts; big histories pay most for the redraw.

## The change
Track only what rows show, for the people who appear in the rows:
- In `store.setUser`, pass the username in the detail: `changed('users', { username: u.username })`.
- In `timeline.js`, on `users` with a `username` detail: if that person's `displayName`, `avatarUrl` or `isBot` did not change (keep a small map `username -> "displayName|avatarUrl|isBot"` for the authors drawn), do nothing; else redraw only the rows whose `message.username` (or `replyTo.username`) is that person.
- On a `users` change without a detail (the bootstrap), compare the small map for the drawn authors only.
- Keep `quickReactions` out of this check (see client-render-05).

About 25 lines in `timeline.js` and one line in `store.js`.

## Risks and what could break
A field that rows show must be in the per-person key: `displayName`, `avatarUrl`, `isBot` (`message.js:56-83`, `117`). Reaction pill titles use `displayName` of reacting users (`message.js:281`): include reaction users in "people in the rows", or accept that a renamed reactor shows the old name in a tooltip until the next redraw. `removeUser` fires `users` with `{ removed }` and keeps rows as they are (comment `store.js:324-326`); keep that.

## How to measure it
A server with 2,000 accounts. Profile the tab while another account edits its bio, and while the client reconnects (bootstrap). Count `renderRow` calls and the time in `rowFacts`. On the iPhone, the Settings debug card shows the emoji requests a redraw causes.