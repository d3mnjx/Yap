---
id: C1-52
title: Run the boot's three IndexedDB reads and the chat module's evaluation side by side
category: 1
journey: warm-open
effort: S
confidence: medium
behaviour-change: none
estimated-gain: One to two IndexedDB transaction latencies before the stored rows paint, plus the overlap of the chat module's evaluation with the reads. Each read is a round trip to the browser's storage process; on a phone it is likely a few ms to tens of ms, unknown. Needs measurement.
experiment: none
sources: [client-core-07]
files: [Yap/wwwroot/js/main.js:143-160, Yap/wwwroot/js/main.js:115-126, Yap/wwwroot/js/pages/chat.js:98-104, Yap/wwwroot/js/offline/snapshot.js:97-117, Yap/wwwroot/js/offline/db.js:27-39]
---

## What the code does now
The warm path to the first paint is a chain of awaits:

1. `main.js:144` `let doc = await snapshot.loadBootstrap();` (opens the database, one readonly transaction).
2. `main.js:151-152` `applyBootstrap(doc); hub.connect();`
3. `main.js:157` `state.drafts = await snapshot.loadDrafts();` (a second transaction, started only now).
4. `main.js:159` `router.start()` runs the route handler, which does `const page = await loader();` (main.js:123), the dynamic import of `pages/chat.js`. The module is fetched through the modulepreload link, but it and its three unevaluated dependencies (ui/composer, ui/gif-picker, ui/recorder) evaluate only now.
5. `chat.js:99` `paintStored` does `await snapshot.loadTail(...)` (a third transaction, started only after the mount).
6. `setOpen(stored)` and the timeline draws; `markOnce('paint')`.

Each `db.run` resolves on `tx.oncomplete` (db.js:34).

## Why it costs the user time
The drafts read does not depend on the bootstrap, and the chat module does not depend on either. The tail key depends only on the route and, for `/lobby`, on the stored rooms. Yet each starts after the previous one finished. Three storage round trips and one module evaluation sit in series before the first rows appear. Everyone with a stored copy pays it at every open; the installed app on iOS pays it at each cold launch.

## The change
In `start()`:

```js
const drafts = snapshot.loadDrafts();                       // no dependency on the bootstrap
const chatModule = router.current.page === 'chat' ? pages.chat() : null;   // evaluate while the storage answers
let doc = await snapshot.loadBootstrap();
...
state.drafts = await drafts;
```

`pages.chat()` returns the same module promise the route handler awaits later, so the handler finds it evaluated. Optionally, a second step: `snapshot.js` keeps the promise of one early `loadTail(key)` and returns it to the first caller with the same key; `main.js` starts it right after the bootstrap read, with the key computed like `chat.js` `resolve()` does (the room id from the route, `dm:` and the partner, or the stored lobby's id).

## Risks and what could break
- `pages.chat()` early on a signed-out device loads a module that the login page does not need; guard it with `doc?.user` if that matters, at the cost of the overlap.
- The early tail read duplicates the key logic of `chat.js`; keep it in one exported helper.
- A failed read still gives `null`/`{}` as today (db.js turns errors into null).

## How to measure it
Warm open on a phone (the installed app on an iPhone): add marks after each await in `start()` and read them with the Settings debug card, or compare the boot report's `paint` phase before and after.