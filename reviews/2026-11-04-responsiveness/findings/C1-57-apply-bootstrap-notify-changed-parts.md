---
id: C1-57
title: Notify only the parts of a bootstrap that changed
category: 1
journey: resume
effort: S
confidence: low
behaviour-change: none
estimated-gain: Unknown, needs measurement. Each bootstrap after a connect runs every listener of twelve parts with the frame mounted, just after the server's rows land: the room list is rebuilt four times in one task, plus the people list, chip, mailbox, title, typing line, the timeline's row-change check twice, and the snapshot timer. Most of it redraws the same content.
experiment: none
sources: [client-core-22]
files: [Yap/wwwroot/js/store.js:36-49, Yap/wwwroot/js/ui/frame.js:40-50, Yap/wwwroot/js/ui/frame.js:266-295, Yap/wwwroot/js/hub.js:124-129]
---

## What the code does now
`applyBootstrap` (store.js:36-49) replaces the shared parts and then fires all of them:

```js
for (const part of ['emojiImages', 'user', 'config', 'texts', 'rooms', 'users', 'presence', 'dms', 'unread', 'mutes', 'emoji', 'favoriteGifIds']) changed(part);
```

With the frame mounted (ui/frame.js:40-50), `renderRooms` listens to `rooms`, `unread`, `mutes` and `user`, so it runs four times in a row; each run clones every room row from the template, runs `inline()` on each name (emoji images), and adds listeners (frame.js:266-295). `renderPeople` is scheduled per frame. `renderChip` runs three times, `renderMailbox` twice, `renderCount` twice, `renderTitle` twice. The timeline runs `redrawIfRowsChanged` for `users` and `emoji`. On a warm open this happens once with the stored copy (before the frame mounts, so few listeners) and once with the server's answer (frame mounted), after every reconnect, and after every sign-in.

## Why it costs the user time
The server's bootstrap of a connect lands about when the server's rows land, the moment the person starts to read and scroll. The redraws run in one task on the main thread. On an iPhone every emoji `<img>` in a rebuilt room name is a request to the worker (static-asset-caching). Most parts are equal to what the stored copy or the previous connect already drew.

## The change
In `applyBootstrap`, compare each incoming part with the current one and fire `changed(part)` only when it differs. A JSON comparison per part is enough and simple; for `users`, compare the list before it becomes a map. Keep `emojiImages` first in the order, as the comment requires.

Separately (for the ui reader): a frame-level guard so `renderRooms` runs at most once per task, as `renderPeople` already does.

## Risks and what could break
- `JSON.stringify` of a large directory costs time too (a few ms at 1,000 accounts on a phone, unknown); it should still be cheaper than the redraws. Measure.
- A listener that relied on being called at every bootstrap (for example to re-pick a random text) would stop doing so. `texts` would then keep its current pick, which is arguably better.

## How to measure it
Journey resume on a phone in a server with many rooms and accounts: a performance profile of the task that applies the server's bootstrap. Count `renderRooms` calls and the task's duration before and after.