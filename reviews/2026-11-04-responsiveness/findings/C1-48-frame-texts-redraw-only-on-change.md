---
id: C1-48
title: Redraw the status chip, the people header and the title only when their text changes
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: Every presence tick rebuilds the chip name and the people header with inline(), and every profile event rebuilds the title, even when the text is the same. Each rebuild makes new text nodes and new emoji images (a request each on WebKit). Small per tick; presence ticks are frequent on a big server. Exact ms unknown.
experiment: none
sources: [client-render-28]
files: [Yap/wwwroot/js/ui/frame.js:43-49, Yap/wwwroot/js/ui/frame.js:75-95, Yap/wwwroot/js/ui/frame.js:106-111, Yap/wwwroot/js/ui/frame.js:195-201]
---

## What the code does now
- `renderChip` runs on `user`, `users`, `presence` and `connection` (`frame.js:43`) and always does `replace(button.querySelector('.status-username'), inline(displayName(state.user.username)))` (`frame.js:110`).
- `renderCount` runs on `presence` and `texts` (`frame.js:48`) and always does `replace(frame.querySelector('.people-header'), inline(peoplePick.text))` (`frame.js:200`), even when the count did not change. The configured header texts (`texts.peopleHeaders`) can hold emoji.
- `renderTitle` runs on every `users` change (`frame.js:49`) and rebuilds the header title block, with a new avatar element for a DM (`frame.js:80-94`).

## Why it costs the user time
These nodes do not change on most ticks. Each rebuild still replaces them, and on WebKit every emoji image in them is requested again. Who pays: everyone on busy servers; WebKit pays the requests.

## The change
Keep the last drawn input per part and return early when it is the same:
- chip: the class and the name text separately; `replace` the name only when `displayName(me)` changed.
- count: `replace` the header only when `peoplePick.text` changed (it changes only with the count).
- title: a key of `title.kind|title.text|title.partner|displayName(partner)|avatarUrl(partner)`.

## Risks and what could break
A change of the emoji rules (`emojiImages`) changes how the same text draws. Include a counter that `emojiImages` bumps in the keys, or redraw all three on `emojiImages`.

## How to measure it
Count calls that reach `replace` during a presence wave; the iPhone debug card for emoji requests.