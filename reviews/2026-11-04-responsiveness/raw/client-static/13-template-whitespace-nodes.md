---
id: client-static-13
title: Remove the indentation text nodes and comments from the templates once, not in every clone
area: client-static
journey: all
category-guess: 1
behaviour-change: none, if only newline-indentation nodes go (single spaces between inline elements stay)
effort: S
estimated-gain: "A message row clone goes from 84 nodes to 39: 44 whitespace-only text nodes and 1 comment fewer per row clone. A drawn row keeps an estimated 30 indentation text nodes today (the removed parts take theirs with them). 50 rows per open, up to two draws, 50 per older page. Unknown ms (clone and memory), small per row, multiplied by every row."
confidence: medium
files: [Yap/wwwroot/index.html:412-458, Yap/wwwroot/js/render/dom.js:32-40]
---

## What the code does now
- `clone()` (`dom.js:32-40`) returns `template.content.firstElementChild.cloneNode(true)`. The templates in `index.html` are indented, so each clone copies the indentation as text nodes.
- Counted with an HTML parser over the page: `t-message` has 39 elements, 44 whitespace-only text nodes, 3 text nodes and 1 comment (`<!-- the header avatar is inserted here ... -->`, `index.html:418`). `t-frame` 40 elements and 48 whitespace nodes; `t-composer` 45 and 49 plus 3 comments; `t-room-row` 11 and 9; `t-user-row` 16 and 11; `t-link-card` 7 and 7.
- The whitespace nodes sit in flex and block containers between block children, so they draw nothing. They cost clone time and memory, and every `querySelector` and `replaceChildren` walks past them.

## Why it costs the user time
Each row clone copies twice the nodes it needs. Rows are cloned at every open, every older page and every row redraw. Who pays: everyone; phones and long sessions most.

## The change
In `dom.js`, clean a template once, at its first lookup (the `templates` map already caches it):
```js
function tidy(content) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  const drop = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.nodeType === Node.COMMENT_NODE || (/^\s*$/.test(n.data) && n.data.includes('\n'))) drop.push(n);
  drop.forEach(n => n.remove());
}
```
Only whitespace that contains a line break goes; a single space between inline elements stays (for example `t-reaction-pill` and the `t-login` guide line).

## Risks and what could break
A line break between two inline elements inside a block (not flex) container renders as a space. Removing it would join the two words. Review each template for that case before the change (the flex rows are safe); the risk is a missing space in a static text.

## How to measure it
`document.getElementsByTagName('*').length` and a TreeWalker count of text nodes after a 50-row open; Performance trace of the reset on a phone, before and after.
