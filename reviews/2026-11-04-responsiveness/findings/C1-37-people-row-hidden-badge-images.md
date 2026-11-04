---
id: C1-37
title: Build the admin and bot badge emoji only for rows that show them
category: 1
journey: all
effort: S
confidence: high
behaviour-change: none
estimated-gain: Two <img> elements less per people row in nearly every row. A window holds about 40 rows (PEOPLE_FALLBACK, or the view plus 2 x 10 overscan), so about 80 image requests to the service worker less per people pass on WebKit, where each <img> element is a request of its own. Exact ms unknown, needs measurement.
experiment: none
sources: [client-render-02]
files: [Yap/wwwroot/js/ui/frame.js:410-419, Yap/wwwroot/index.html:313-326]
---

## What the code does now
Every people row fills both badges with an emoji image, and only then the `hidden` flag decides what shows (`frame.js:416-419`):

```js
row.querySelector('.admin-badge').hidden = !u?.isAdmin;
row.querySelector('.bot-badge').hidden = !u?.isBot;
replace(row.querySelector('.admin-badge'), inline('👑'));
replace(row.querySelector('.bot-badge'), inline('🤖'));
```

`inline()` returns an `<img class="emoji">` for each emoji (`render/text.js:91-96`). The images are eager (no `loading`), so a hidden span still loads its image.

## Why it costs the user time
On the iPhone every `<img>` element is a request of its own to the service worker (memory `static-asset-caching`, measured 2026-10-31). A people pass rebuilds every row in the window (`drawPeopleWindow`, `frame.js:388-391`) when the facts change, and a scroll of the sidebar rebuilds them when the window moves. Each pass adds about 80 requests for badges that nearly nobody shows (most people are neither admin nor bot). Who pays: WebKit users (iPhone, iPad, the installed app), on servers with churn in presence.

## The change
Fill a badge only when it shows:

```js
const admin = row.querySelector('.admin-badge'), bot = row.querySelector('.bot-badge');
if (u?.isAdmin) replace(admin, inline('👑')); else admin.remove();
if (u?.isBot) replace(bot, inline('🤖')); else bot.remove();
```

Removing the span (instead of `hidden`) also cuts two nodes per row. Check `frame.css` for a selector that expects the empty badge span; if one exists, keep `hidden` and skip only the `inline()` call.

## Risks and what could break
None for the look: a hidden badge showed nothing before. The `title` on the span goes with the span.

## How to measure it
The Settings debug card (ST-25) on the iPhone: emoji requests per 250 ms while the sidebar is open on a server with many accounts, before and after. Also the count of `img.emoji` in `.users-list` (DevTools: `document.querySelectorAll('.users-list img.emoji').length`).