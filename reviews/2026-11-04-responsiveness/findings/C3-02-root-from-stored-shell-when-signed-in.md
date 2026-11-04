---
id: C3-02
title: Answer the root from the stored shell on a signed-in device
category: 3
journey: warm-open
effort: M
confidence: medium
behaviour-change: A signed-in browser tab that opens the root URL paints at once from the stored shell (like `/lobby` does today) and, after a deploy, runs the installed build and shows the "Please refresh" strip instead of loading the new build directly.
estimated-gain: A browser-tab user who opens the bare address (a bookmark, a typed domain) waits today for connection set-up plus the page fetch before any paint: about 3 round trips plus 22 KB on the far link, roughly 2.9 s. From the stored shell the paint needs no network, as for the installed app and `/lobby`. Who opens `/` and how often is unknown.
experiment: none
sources: [client-core-19, client-render-31]
files: [Yap/wwwroot/service-worker.js:25-29, Yap/wwwroot/service-worker.js:59-64, Yap/wwwroot/js/update.js:20-43, Yap/wwwroot/js/router.js:36-44, Yap/Endpoints/ShellEndpoints.cs:54-71]
---

## What the code does now
The worker's server-first rule matches the root, because the group is optional (service-worker.js:29):

```js
const SERVER_FIRST = /^\/(?:login|verify\/[^/]+|invite\/[^/]+)?$/;
...
if (SERVER_FIRST.test(url.pathname)) event.respondWith(fetch(request).catch(() => shell()));
```

The reason is the welcome page: the server answers a signed-out visitor at `/` with it when the deployment has one (ShellEndpoints.cs:57-59). The router rewrites `/` to the last route only after the page has loaded (router.js:36-44). `update.js` relies on the same rule: `reloadForNewBuild()` goes through `/` so that the new build comes from the server even when the worker is stuck (update.js:20-43, "every worker since 2026-10-22 included").

## Why it costs the user time
Every other client route paints from the stored shell with no round trip (OF-18). The root does not, and the root is what a bookmark or a typed address opens in a browser tab. After a sleep the TCP and TLS set-up comes first, then the full page (no ETag, see client-core-18). The installed app is not affected (it launches at `/pwa-launch`).

## The change
1. Worker: treat a plain `/` like the other client routes (stored shell) when the device is signed in, and keep it server-first otherwise. The worker can read the signed-in state from the same IndexedDB record the page paints from (`yap` database, `snapshots` store, key `bootstrap`, a document with a `user`). One read per navigation to `/`.
2. Keep an escape for the fresh load of a new build: `reloadForNewBuild()` navigates to `/?fresh=1`; the worker treats any `/` with a query as server-first. Old workers already treat `/?fresh=1` as server-first (they test the path only), so the iOS stuck-worker fix keeps working.
3. Optional: when the deployment has no welcome page, `ShellEndpoints` writes a flag into the worker and the IndexedDB read is skipped.

## Risks and what could break
- A signed-out device with a stale stored bootstrap (a cookie that died) would get the shell, not the welcome page; the page then signs out and shows the login page. The welcome page shows on the next signed-out open.
- The worker's IndexedDB read adds a few ms to that navigation.
- The rule "a page runs the build its worker installed" (OF-18) then also covers `/`; the strip asks for the reload after a deploy, as on `/lobby`.

## How to measure it
Warm open on the far link from a browser tab, once at `/lobby` and once at `/`: the boot report's `html` and `paint` phases. Today `/` should show a large `html` phase; after the change both should match.

## Also found by

The same finding, from another reader's angle: `raw/client-render/31-sw-root-from-cache-when-signed-in.md`. The raw files hold their reasoning and numbers.
