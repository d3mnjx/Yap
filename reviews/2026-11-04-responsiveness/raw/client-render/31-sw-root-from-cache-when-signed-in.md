---
id: client-render-31
title: Answer the root URL from the stored shell for a signed-in device
area: client-render
journey: warm-open
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The root `/` is network-first. A signed-in person who opens the site at `/` (a bookmark, typing the address, or an installed app whose manifest was fetched before sign-in and so has start_url "/") waits one round trip plus the page download before any paint, about 1 s or more for the far user, on every such open. The network fetch has no timeout, so a weak link that does not fail outright holds the blank page. From the cache the paint needs no round trip.
confidence: medium
files: [Yap/wwwroot/service-worker.js:25-29, Yap/wwwroot/service-worker.js:59-66, Yap/Endpoints/ShellEndpoints.cs:54-71, Yap/Endpoints/PwaEndpoints.cs:36-44]
---

## What the code does now
```js
const SERVER_FIRST = /^\/(?:login|verify\/[^/]+|invite\/[^/]+)?$/;
...
if (SERVER_FIRST.test(url.pathname)) event.respondWith(fetch(request).catch(() => shell()));
```
(`service-worker.js:29`, `63`). The pattern matches `/` (the empty group). The server answers a signed-in visitor at `/` with the same shell as every route; only a signed-out visitor can get the welcome page (`ShellEndpoints.cs:56-59`). The manifest's `start_url` is `/` when the manifest was fetched without a session (`PwaEndpoints.cs:36`, comment at `44`).

## Why it costs the user time
The worker cannot read the HttpOnly cookie, so it asks the server first at `/`. For a signed-in device the answer is always the shell it already has. The far user pays about 0.9 s for the round trip plus the page body before the first paint. The `fetch` has no timeout; only a thrown error falls back to the stored shell. Who pays: signed-in people who land on `/`, including installed apps with `start_url` "/".

## The change
The page tells the worker that this device is signed in. Simplest form: after a successful bootstrap with a user, the page writes a marker entry into the current shell cache (`cache.put('/__signed-in', new Response('1'))`), and the sign-out path (session.js, GEN-05) deletes it. In the worker:

```js
if (url.pathname === '/' && await hasMarker()) return shell(request);
```

(inside `respondWith`, with `hasMarker()` reading the marker once per worker life and on each `/` navigation). A signed-out device keeps the network-first path and the welcome page. Optionally add a timeout (for example 4 s) to the network-first branch with the stored shell as the fallback; that is a behaviour change for signed-out visitors on a weak link (category 3).

## Risks and what could break
A sign-out on another device (or an expired cookie) leaves the marker on this device; the page then starts from the shell and finds itself signed out, as the installed app at `/pwa-launch` already does (performance-notes step 3). The welcome page and the visitor log (AD-20, AD-36) see only signed-out visits, as today. The update path (`update.js` `reloadForNewBuild`) relies on `/` reaching the server for a fresh page (`update.js:18-29`, `40-42`); it must bypass the marker, for example with a query (`/?fresh=1`) that the worker sends to the network.

## How to measure it
The boot report's `html` and `paint` phases for loads whose navigation URL is `/`, before and after. On the far link: time to first paint when opening `/` while signed in.
