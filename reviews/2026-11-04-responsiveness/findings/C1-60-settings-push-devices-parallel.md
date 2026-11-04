---
id: C1-60
title: Fetch the push device list in parallel with the service worker lookup on Settings
category: 1
journey: all
effort: S
confidence: high
behaviour-change: none
estimated-gain: The Notifications card's list and state show one local wait sooner, at every Settings visit and at every return to a visible Settings page. When `navigator.serviceWorker.ready` hangs (seen on iOS, push.js:131-139), the request waits the full 3 s bound before it even starts; in parallel it would not.
experiment: none
sources: [client-core-26]
files: [Yap/wwwroot/js/pages/settings.js:250-256, Yap/wwwroot/js/push.js:131-139]
---

## What the code does now
`drawPush` (settings.js:250-256) awaits the subscription first and starts the request after it:

```js
const sub = possible ? await push.current() : null;
let devices = [];
try { devices = await api.get('/api/push/devices'); } catch { /* keep */ }
```

`push.current()` (push.js:133-139) races `navigator.serviceWorker.ready` against 3 s, then calls `getSubscription()`.

## Why it costs the user time
The two waits do not depend on each other. In series the card waits for the worker lookup (fast in the normal case, up to 3 s when `ready` hangs) plus the request's round trip (900 ms far). The function also runs at every `visibilitychange` to visible (settings.js:303) and after each push action.

## The change
```js
const [sub, devices] = await Promise.all([
  possible ? push.current() : null,
  api.get('/api/push/devices').catch(() => []),
]);
```

## Risks and what could break
None known; the drawing code uses both values only after both are known, as today.

## How to measure it
Open Settings on an iPhone in the installed app over the far link and time until the Notifications card shows its device list.