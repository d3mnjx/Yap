---
id: client-render-17
title: Keep only the most recent join and leave lines in the lobby
area: client-render
journey: all
category-guess: 3
behaviour-change: Old "joined" and "left" lines above the newest few dozen disappear while the lobby stays open.
effort: S
estimated-gain: Each presence tick in the lobby appends one line per join or leave and never removes it until a reset. On a server with many people the open lobby gains thousands of nodes over a session (the 2026-10-18 load test had waves of a thousand). Each line also runs inline() (emoji images for names with emoji) and asks for a scroll frame. A cap keeps the list size flat. Exact gain depends on churn; unknown.
confidence: medium
files: [Yap/wwwroot/js/ui/timeline.js:458-473, Yap/wwwroot/js/ui/timeline.js:57]
---

## What the code does now
```js
for (const { username, kind } of detail.changes) {
  if (kind !== 'join' && kind !== 'leave') continue;
  const line = clone('t-system-line');
  line.classList.add('lobby-line');
  ...
  flow.append(line);
  added = true;
}
if (added && following) scrollToBottom();
```
(`timeline.js:463-472`). The lines go only at a reset (`timeline.js:57`).

## Why it costs the user time
The flow grows by one node tree per join or leave. Every later layout, `querySelectorAll('img')` walk (`timeline.js:274`) and style pass covers them. In a busy lobby the lines can outnumber the messages. Who pays: people who keep the lobby open on big servers.

## The change
After the append loop, remove the oldest lobby lines beyond a cap (for example 50):

```js
const lines = flow.querySelectorAll('.lobby-line');
for (let i = 0; i < lines.length - 50; i++) lines[i].remove();
```

## Risks and what could break
MR-73 must allow a cap; this is a visible change, so it needs the product owner's word. A removed line above the view can shift content; the lines sit at the bottom of the flow, and the follow rule keeps the bottom in view, but a reader scrolled up might see a small jump. Removing only lines above the view avoids that.

## How to measure it
A load-test run with join and leave waves and one real browser in the lobby: node count of the flow after 10 minutes, and frame times.
