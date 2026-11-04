---
id: C1-38
title: Move the people window in steps of the overscan, not one row at a time
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: A scroll of the sidebar rebuilds the whole window (about 40 rows) each frame in which the first visible row changes. With the window snapped to multiples of 10 rows, the rebuild happens about once per 10 rows scrolled, so roughly 10 times fewer rebuilds, clones and emoji <img> requests during a sidebar scroll. Exact ms unknown.
experiment: none
sources: [client-render-03]
files: [Yap/wwwroot/js/ui/frame.js:370-398, Yap/wwwroot/js/ui/frame.js:401-408]
---

## What the code does now
A scroll schedules `drawPeopleWindow(false)` once per frame (`frame.js:403`). The window start is the first visible row minus the overscan (`frame.js:378-381`):

```js
const first = Math.floor((scroller.scrollTop - listTop) / peopleRowHeight);
start = Math.max(0, Math.min(n, first - PEOPLE_OVERSCAN));
end = Math.max(start, Math.min(n, first + visible + PEOPLE_OVERSCAN));
```

When `start` or `end` differs by even one row, the function builds every row of the window again and replaces the list (`frame.js:388-391`). After that it reads `rows[0].offsetHeight` and `getComputedStyle(list).rowGap` (`frame.js:396`), a forced layout.

## Why it costs the user time
The overscan exists so that a short scroll needs no redraw (comment at `frame.js:334`). The code does not use it that way: the window follows the first row exactly, so every row of scroll means a full rebuild of about 40 rows (a clone, `inline()` names, two badge images, four or five listeners each) plus a forced layout. On WebKit each rebuild issues the emoji image requests again. Who pays: people who scroll the people list on a server with many accounts, mostly on phones.

## The change
Snap the window to the overscan step:

```js
start = Math.max(0, Math.floor((first - PEOPLE_OVERSCAN) / PEOPLE_OVERSCAN) * PEOPLE_OVERSCAN);
end = Math.min(n, Math.ceil((first + visible + PEOPLE_OVERSCAN) / PEOPLE_OVERSCAN) * PEOPLE_OVERSCAN);
```

The window then changes only when the view crosses a 10-row boundary, and the existing `start === peopleWindow.start && end === peopleWindow.end` check skips the frames in between. Optionally read the row height only when it is 0 or the text size changed, not on every pass.

## Risks and what could break
The padding math stays the same (`paddingTop = start * rowHeight`). Keyboard focus restore (`frame.js:393`) is unchanged. The window holds up to 10 more rows at its edges.

## How to measure it
A server with 2,000 accounts, the sidebar open on a phone. Record a performance profile while flinging the people list. Count calls of `drawPeopleWindow` that rebuild rows, and the scripting time per frame.