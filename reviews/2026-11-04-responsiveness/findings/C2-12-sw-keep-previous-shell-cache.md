---
id: C2-12
title: Keep the previous build's shell cache so an open page's late imports stay cache hits
category: 2
journey: picker-emoji
effort: M
confidence: medium
behaviour-change: none
estimated-gain: After a deploy the new worker takes over the open page (skipWaiting, clients.claim) and deletes the old shell cache. A module the old page imports later (the emoji list at the first picker open, 44 KB; the settings, admin or channel settings page modules) then misses the cache and goes to the network: about 0.9 s plus the transfer for the far user, and it may get the new build's file under the old URL. With the old cache kept, these imports stay local.
experiment: none
sources: [client-render-30]
files: [Yap/wwwroot/service-worker.js:34-45, Yap/wwwroot/service-worker.js:67, Yap/wwwroot/service-worker.js:92-104, Yap/wwwroot/js/ui/emoji-picker.js:28-32]
---

## What the code does now
`install` calls `self.skipWaiting()` (`service-worker.js:38`); `activate` deletes every cache but the current shell, emoji and media caches, then claims the clients (`service-worker.js:41-45`). Shell files go through `cacheFirst(request, SHELL_CACHE)` with the new build's cache name (`service-worker.js:67`). The emoji picker imports `../data/emoji-list.js` on its first open, which the import map turns into `/js/data/emoji-list.js?v=<old build>` (`emoji-picker.js:31`); the comment there counts on a cache hit (PK-11).

## Why it costs the user time
A page that loaded before the deploy keeps running its build. Its lazy imports carry the old stamp; the new worker's cache does not hold them, and the old cache is gone. The request goes to the server, costing a round trip and the file on the slow link at the moment of a tap. The server ignores the query and returns the current file, so the old page can also run a module of the new build (the memory `mixed-build-document` describes that risk). Who pays: anyone with an open page across a deploy who then opens a picker or a page for the first time; far users about a second.

## The change
The `?v=` query names the build of each shell URL. In the fetch handler, for a shell asset whose `v` differs from `BUILD`, look in `yap-shell-<v>` first. In `activate`, keep the newest previous shell cache (delete the others), or delete an old shell cache only when `clients.matchAll()` finds no window of that build (each page has `data-build`; the worker can ask by `postMessage`, or simply keep one previous build).

## Risks and what could break
Storage: one more shell build kept (about 0.5 to 1 MB). The cleanup must still run, so caches do not pile up. Pages of a build two deploys old still miss, as today.

## How to measure it
Load the app, deploy, then open the emoji picker for the first time in the old page on the far link. Network panel: the request for `emoji-list.js` and its timing, before and after.