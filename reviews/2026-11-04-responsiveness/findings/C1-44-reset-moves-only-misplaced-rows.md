---
id: C1-44
title: At a reset, leave kept rows in place instead of moving every node
category: 1
journey: warm-open
effort: S
confidence: medium
behaviour-change: none
estimated-gain: At every open the server's rows follow the device's copy, and at every reconnect the tail comes again; nearly all 50 rows stay. Today all 50 kept nodes are removed and inserted again, which throws away their layout boxes and recomputes style and layout for all of them. After the change, no kept row moves. Exact ms unknown; on a phone a style and layout pass of 50 rows can be tens of ms.
experiment: none
sources: [client-render-10]
files: [Yap/wwwroot/js/ui/timeline.js:46-85]
---

## What the code does now
`reset()` for the same conversation keeps unchanged rows, then appends every row, kept or new, at the end of the list in order (`timeline.js:64-69`):

```js
for (const m of ordered()) {
  const old = m.pending ? null : kept.get(m.id);
  if (old && unchanged(old, m, prev)) { kept.delete(m.id); flow.append(old.node); rows.set(m.id, { node: old.node, message: m }); }
  else flow.append(makeRow(m, prev));
  prev = m;
}
```

`flow.append(old.node)` removes the node and inserts it again, even when it already sits in the right place.

## Why it costs the user time
A node removed from the document and inserted again loses its layout object; the browser rebuilds style and layout for the whole subtree. With 50 kept rows the reset that "draws nothing" (comment `timeline.js:49-52`) still costs a full style and layout pass of the list, at the moment the server's rows arrive (the open, every reconnect). Who pays: everyone at every open and reconnect; phones most.

## The change
Track the expected position and move a node only when it is not already there:

```js
let cursor = spacer;   // the node the next row must follow
for (const m of ordered()) {
  ...
  const node = old && unchanged(old, m, prev) ? keep(old, m) : makeRow(m, prev);
  if (cursor.nextSibling !== node) cursor.after(node);
  cursor = node;
  prev = m;
}
```

`spacer` is the node before the rows (`timeline.js:19`; the `older` handler inserts after it, `timeline.js:164`). Removed rows go as today (`timeline.js:70`). Lobby lines are removed before the loop (`timeline.js:57`), so they do not break the order.

## Risks and what could break
The flow holds the top slot, the spacer, the rows and the lobby lines. The order check must start after `spacer`. Rows that the new tail drops are removed after the loop, as today, so a stale node between kept rows is gone before the next draw; check that the loop handles a stale node between two kept rows (the `nextSibling` test then fails and the node moves, which is correct).

## How to measure it
Open a conversation with a stored tail on a phone, record a performance profile from the device paint to the server's rows. Look at the Recalculate Style and Layout entries after `setOpen` from `openRoom`. Repeat for a reconnect.