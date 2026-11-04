---
id: client-core-30
title: Move the Settings, Channel and Admin templates out of the page every load parses
area: client-core
journey: all
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: About a third of the page's markup (t-settings 19.8 KB, t-channel-settings 7.1 KB, t-admin 5.8 KB, plus their small row templates; about 704 of 2,053 tags) is no longer parsed into template fragments at every start, and about 7 KB gzip less is downloaded at every server-first navigation (client-core-18, -19). The parse time on a phone is unknown, likely a few ms.
confidence: low
files: [Yap/wwwroot/index.html:167-1326, Yap/wwwroot/js/render/dom.js, Yap/wwwroot/js/pages/settings.js:38, Yap/wwwroot/js/pages/channel-settings.js:15, Yap/wwwroot/js/pages/admin.js:52]
---

## What the code does now
`index.html` is 96,885 bytes (21,944 gzip). Its body holds every template of the app; `clone('t-name')` (render/dom.js) copies one. The largest templates belong to pages most starts never open:

| Template | Bytes | Tags |
| --- | --- | --- |
| t-settings | 19,834 | 424 |
| t-channel-settings | 7,069 | 181 |
| t-admin | 5,775 | 99 |
| t-message (every row) | 3,456 | 76 |
| t-composer | 4,193 | 91 |

The HTML parser builds each `<template>`'s content as an inert fragment at parse time, so every start builds the Settings, Channel and Admin page DOM once, unused.

## Why it costs the user time
The page is parsed at every start (from the worker's cache or the network). On a phone the parse is main-thread time before `main.js` runs. On the server-first navigations (`/`, `/login`) the bytes are on the wire too.

## The change
Move the page-only templates into their page modules as a string parsed on first mount (`const t = document.createElement('template'); t.innerHTML = SETTINGS_HTML;`), or into a separate `templates/settings.html` the page module fetches through the worker. The shared templates (frame, message, composer, pickers) stay in the page. `settings.js` already builds icons from fixed strings this way (settings.js:35).

## Risks and what could break
- The HTML of a page moves away from its CSS's comment references (css/README.md describes the templates in index.html).
- A template inside a JS string loses HTML syntax highlighting; a separate `.html` file avoids that but needs a fetch (a worker hit) and a precache entry.
- Small gain; do it only if a profile shows the parse matters.

## How to measure it
A performance profile of a warm start on a phone: the "Parse HTML" task duration before and after.
