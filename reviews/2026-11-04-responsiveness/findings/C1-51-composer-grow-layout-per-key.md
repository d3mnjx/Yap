---
id: C1-51
title: Size the draft box without a forced layout on every keystroke
category: 1
journey: send
effort: S
confidence: low
behaviour-change: none
estimated-gain: Each keystroke sets the textarea height to auto, reads scrollHeight (a forced layout) and sets the height again. The layout is local when the height does not change, but it runs inside the input event before the next frame. Gain unknown, needs measurement on a phone with a long loaded history.
experiment: none
sources: [client-render-34]
files: [Yap/wwwroot/js/ui/composer.js:120-131]
---

## What the code does now
```js
function grow() {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, 200)}px`;
}
area.addEventListener('input', () => {
  ...
  grow();
  caret = area.selectionStart;
  saveDraft();
  noteTyping();
});
```
(`composer.js:120-131`). `saveDraft` fires the store's `drafts` part on every key (the device write waits 500 ms, `offline/snapshot.js:74`).

## Why it costs the user time
The write of `auto` and the read of `scrollHeight` force a synchronous layout inside every input event. The textarea sits in the same flex column as the message list; when the height changes, the list resizes and its `ResizeObserver` scrolls (`timeline.js:379-385`). Typing latency on a phone is what the person feels most often. Who pays: phones; unknown how much.

## The change
Option 1: CSS `field-sizing: content` with `max-height: 200px` on `.message-input`, and call `grow()` only where the browser lacks it (`CSS.supports('field-sizing', 'content')`). Option 2: skip `grow()` when the value grew without a line break and the scroll height cannot have changed (for example: run it only when the value length changed by more than one character, or contains a new `\n`, or every 100 ms).

## Risks and what could break
IB-04 (the box grows to 200 px) must hold. `field-sizing` support differs by browser; the fallback keeps today's path.

## How to measure it
Chrome DevTools on a throttled phone profile: the Event Timing entries (`input` duration) while typing, in a room with 1,000 loaded rows.