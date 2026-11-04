---
id: C1-08
title: Build the reaction emoji picker once per page and reuse it
category: 1
journey: picker-emoji
effort: S
confidence: high
behaviour-change: none
estimated-gain: Every tap on "Add Reaction" builds a new picker of about 1,000 cells (925 Unicode emoji plus 76 pack emoji): about 2,000 elements, 3,000 listeners and 1,000 lazy images, and fills Recent twice. After the change the second and later opens only refresh Recent and the search. Exact ms unknown; on a phone the build is likely tens to over a hundred ms between the tap and the picker.
experiment: E07
sources: [client-render-18]
files: [Yap/wwwroot/js/ui/emoji-picker.js:14-55, Yap/wwwroot/js/ui/emoji-picker.js:57-71, Yap/wwwroot/js/ui/emoji-picker.js:126-132, Yap/wwwroot/js/ui/emoji-picker.js:137-148, Yap/wwwroot/js/ui/message.js:366-369]
---

## What the code does now
```js
export function reactionPicker(rowNode, anchor, onPick, onClose) {
  ...
  const picker = EmojiPicker({ onPick: emoji => { close(); onPick(emoji); }, recordUse: false });
  wrapper.append(picker.element);
  rowNode.append(backdrop, wrapper);
  picker.opened();
```
(`emoji-picker.js:137-143`). `EmojiPicker` clones a fresh template and `opened()` runs `build()` because `built` is false for the new instance (`emoji-picker.js:22`, `127`). `build()` creates a button with an `<img>` for each emoji (`emoji-picker.js:41-53`), each button with two listeners (`emoji-picker.js:64-69`) and each image with an error listener (`text.js:95`). It then calls `fillRecent()`, and `opened()` calls it again (`emoji-picker.js:54`, `128`), then `filter('')` walks every button (`emoji-picker.js:94-103`). The composer's picker, by contrast, lives once per page (`composer.js:381-389`).

The list counts: 10 categories with 925 emoji (`js/data/emoji-list.js`), and the `wechat` pack with 76 images (`wwwroot/emoji-packs/wechat`).

## Why it costs the user time
The reaction picker opens from a tap; the person waits for it. The whole build sits between the tap and the first useful frame of the picker, on every open. Who pays: everyone who reacts with the picker, most on phones.

## The change
In `emoji-picker.js`, keep one module-level instance for reactions:

```js
let shared = null, pickHandler = null;
function reactionInstance() {
  shared ??= EmojiPicker({ onPick: emoji => pickHandler?.(emoji), recordUse: false });
  return shared;
}
```

`reactionPicker` sets `pickHandler` for this opening, appends `shared.element` to the new wrapper (moving it from the last row), and calls `opened()`. On close, the wrapper goes; the picker element moves with the next open. Also drop the second `fillRecent()` in `build()` (the `opened()` call fills it).

## Risks and what could break
`rowReplaced` moves the open picker wrapper to a redrawn row (`message.js:546`); moving the same picker element works the same. Only one reaction picker is open at a time (the overlay stack closes the previous one on an outside tap), so one instance is enough. The packs come from `state.emojiImages`; a pack change after the first build would not show until a reload. Rebuild the instance when `emojiImages` changes (listen to `emojiImages` in the store) to keep today's behaviour.

## How to measure it
On a phone, tap "Add Reaction" on a row and record a performance profile. Measure from the click to the first paint of the grid; compare the second open before and after.