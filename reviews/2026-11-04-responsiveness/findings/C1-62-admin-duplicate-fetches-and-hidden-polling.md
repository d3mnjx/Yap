---
id: C1-62
title: Admin page - drop the duplicate settings and status fetches, and pause the 2 s load poll while hidden
category: 1
journey: admin
effort: S
confidence: high
behaviour-change: none
estimated-gain: Two requests fewer when the Settings tab opens; the Invites tab no longer downloads the full admin users table (recent IPs and actions per account) only to fill a select; no polling of `/api/admin/load` every 2 s from a hidden tab. Small for one admin; on the far link the tab's first draw waits less.
experiment: none
sources: [client-core-28]
files: [Yap/wwwroot/js/pages/admin.js:305, Yap/wwwroot/js/pages/admin.js:352, Yap/wwwroot/js/pages/admin.js:403-409, Yap/wwwroot/js/pages/admin.js:698-741, Yap/wwwroot/js/pages/admin.js:745-759]
---

## What the code does now
- At mount (admin.js:745-759) the page fetches `/api/admin/settings` (for the persistence note) and `/api/admin/status` (for the proxy warning).
- The Settings tab fetches both again (admin.js:305 and 352). Opening `/admin#settings` therefore fetches each twice at once.
- The Invites tab fetches `/api/admin/users` (admin.js:406) to fill the "For" select with ids and usernames; the Users tab fetches the same document on its own open.
- Diagnostics polls `/api/admin/load` every 2 s (every 5 s for long ranges) and refreshes the whole tab every 30 s (admin.js:698-699, 739). Nothing stops the timers while the page is hidden.

## Why it costs the user time
The duplicates share the link with the requests the tab waits for. A hidden admin tab keeps a request loop running; on a phone that is radio time and battery, and the server builds a load series each time.

## The change
- Keep the two mount answers in promises and let the Settings tab reuse them (`const settingsAnswer = api.get('/api/admin/settings')` at mount; the tab awaits it).
- Keep the users document of the page in one promise shared by the Users and Invites tabs (both already treat it as "read once per page load", AD-04).
- In `loadCard` and `diagnostics`, skip a tick while `document.visibilityState !== 'visible'` and run one at once on the return.

## Risks and what could break
- The Settings tab would show values read at page mount; the admin reloads after a change already (AD-04 "a load, never a patch").

## How to measure it
Open `/admin#settings` and count requests in the network panel (four today, two after). Leave Diagnostics open in a background tab for five minutes and count `/api/admin/load` requests.