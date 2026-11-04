---
id: client-render-27
title: Update the room rows' badges in place instead of rebuilding the room list on every unread change
area: client-render
journey: all
category-guess: 1
behaviour-change: none
effort: M
estimated-gain: Every unread count change (a message in any other conversation), every open, every mute change and every user change rebuilds all room rows, their names through inline() and their listeners. On WebKit each emoji in a room name is a new image request per rebuild. Small per rebuild (a few rooms), but it runs on every message elsewhere in a busy server. Exact ms unknown.
confidence: medium
files: [Yap/wwwroot/js/ui/frame.js:266-296, Yap/wwwroot/js/ui/frame.js:45, Yap/wwwroot/js/store.js:299-302]
---

## What the code does now
`renderRooms` builds every row from the template and replaces the list (`frame.js:268-295`). It runs on `rooms`, `unread`, `mutes`, `open` and `user` (`frame.js:45`). `setUnread` fires `unread` for every count change from the server (`store.js:299-302`).

## Why it costs the user time
The room list changes its names and order only on `rooms`. On `unread`, `open` and `mutes` only the classes, the bell, the dot and the badge change. A full rebuild costs clones, `inline()` for every name (new emoji images), two listeners and a key handler per row, and a layout of the sidebar. In a busy server the unread counts change all the time. Who pays: everyone, a little; WebKit pays image requests for emoji in room names.

## The change
Split `renderRooms`:
- `buildRooms()` on `rooms` and `user` (admin state changes the gear): today's code, plus a `Map` from room id to row.
- `markRooms()` on `unread`, `open`, `mutes`: for each room, set the `active` and `has-unread` classes, the bell, the dot and the badge text on the existing row.

## Risks and what could break
A room added or removed arrives as `rooms`, which rebuilds. The open room's click handler closes over `room`; a rename arrives as `rooms` too.

## How to measure it
A busy server with messages in other rooms at one per second; count `renderRooms` calls and the emoji requests on the iPhone debug card while the sidebar shows.
