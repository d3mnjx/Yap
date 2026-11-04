---
id: C1-61
title: Admin Users tab - open a row's detail without rebuilding the whole table
category: 1
journey: admin
effort: S
confidence: high
behaviour-change: none
estimated-gain: A tap on a user row today rebuilds every row of the table (avatar, inline emoji name, seven cells) plus the theme cards and re-attaches the danger zone. At 1,000 accounts that is thousands of elements per tap on the main thread; the size in ms is unknown (an admin is usually on a desktop).
experiment: none
sources: [client-core-27]
files: [Yap/wwwroot/js/pages/admin.js:75-106]
---

## What the code does now
`admin.js:83-97`: every row's click handler sets `selected` and calls `render()`, and `render()` replaces the whole host:

```js
const tr = el('tr', { class: 'clickable-row', onclick: () => { selected = selected === u ? null : u; render(); } }, ...);
...
const render = () => replace(host, [ header(...), table([...], data.users.flatMap(u => { ... })), ... ]);
```

Each rebuild also runs `inline()` on every display name and `avatar()` per row, and the detail panel's `api.get('/api/admin/users/{name}')` (admin.js:112) runs inside `detail(u)`, so it fires once per render of the selected row.

## Why it costs the user time
The person taps a row and waits for the whole table to be rebuilt before the detail row appears. With many accounts the tap feels slow, and the page's scroll position may jump because the table is replaced.

## The change
Toggle only the detail row: in the click handler, remove an existing `.detail-row` and the `selected` class, then insert `el('tr', { class: 'detail-row' }, el('td', { colspan: 7 }, detail(u)))` after the clicked `tr` and add the class to it. Keep `render()` for loads.

## Risks and what could break
- The danger zone's account list and the theme cards stay as drawn at load; they do not depend on the selection.

## How to measure it
Admin journey with the 1,000-account load-test data: a performance profile of one row tap, before and after.