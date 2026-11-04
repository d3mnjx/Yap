---
id: client-render-15
title: Strip the indentation text nodes from the message row template
area: client-render
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The row template has 39 elements, 44 whitespace text nodes and 1 comment, so every row clones 84 nodes. Removing the indentation text nodes and the comment once, at the first clone, cuts the clone to 39 nodes and the kept DOM by about 20 to 40 nodes per row (about 1,000 to 2,000 nodes per 50 rows, tens of thousands in a long loaded history). Exact ms unknown; the gain is clone time, memory and style work.
confidence: medium
files: [Yap/wwwroot/js/render/dom.js:29-40, Yap/wwwroot/index.html:412-458]
---

## What the code does now
`clone()` copies the first element of a `<template>` with all its text nodes (`dom.js:32-40`). The `t-message` template is written with indentation and a comment (`index.html:412-458`). A count of the template gives 39 elements, 44 whitespace-only text nodes and 1 comment.

## Why it costs the user time
Every row draw clones the full template, then removes the parts it does not need (`message.js:72`, `83`, `233`, `276`, `299`, `318`, `358`, `361`, `363`). The whitespace nodes between the kept elements stay in the document. They take memory, they are visited by every `querySelector` walk of the row (about 17 per row at draw) and by `querySelectorAll('img')` in `scrollToBottom`, and they sit in every style and layout tree walk. The row's containers are flex boxes (`.message-group`, `.message-meta`, `message.css:208-215`, `324-329`), where whitespace text renders nothing.

## The change
In `clone()`, at the first lookup of a template id that opts in, remove whitespace-only text nodes that contain a line break, and comments, from `template.content`:

```js
const STRIP = new Set(['t-message', 't-user-row', 't-room-row']);
...
if (STRIP.has(id)) strip(template.content);
function strip(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8 || (child.nodeType === 3 && /^\s*\n\s*$/.test(child.data))) child.remove();
    else if (child.nodeType === 1) strip(child);
  }
}
```

It runs once per template per page. The line-break rule keeps a deliberate single space (for example the space between the emoji and the count in `t-reaction-pill`, `index.html:461`).

## Risks and what could break
A space that separates two inline elements and renders as a gap disappears. In `t-message` that could matter only in a container that is not a flex or grid box. `.message-pending` holds inline spans (`index.html:428-436`); check its CSS before including it, or keep the opt-in list to templates whose containers are flex. The screenshots suite in `tests/browser` shows any visual change.

## How to measure it
`document.querySelectorAll('.messages-flow *').length` and the total node count of the flow before and after, for a 50-row tail. A performance profile of a reset on a phone (the Recalculate Style and the clone time).
