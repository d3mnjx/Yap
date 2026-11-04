---
id: client-core-23
title: After a sign-in, open the socket while the bootstrap is fetched
area: client-core
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One round trip (about 900 ms for the far user) on the way from the sign-in tap to the first rows, on every sign-in, link redeem and approval. The sign-in also fetches the bootstrap twice (once before the connect, once after); the second fetch costs bandwidth, not a round trip.
confidence: medium
files: [Yap/wwwroot/js/session.js:31-41, Yap/wwwroot/js/hub.js:96-131, Yap/wwwroot/js/pages/login.js:101-124, Yap/wwwroot/js/pages/invite.js:83-95, Yap/wwwroot/js/pages/verify.js:20-33]
---

## What the code does now
`session.signedIn()` (session.js:31-41):

```js
const doc = await api.get('/api/bootstrap');
if (!doc.user) return false;
setNotice(null);
store.applyBootstrap(doc);
hub.resume();
hub.connect();
router.navigate(takeReturnTo() || '/', { replace: true });
```

The login, verify and invite pages call it after their sign-in `POST` answers (login.js:110 through its wrapper at login.js:119, verify.js:27, invite.js:90). `hub.connect()` then fetches the bootstrap again after the handshake (hub.js:119-122). So the chain is: sign-in POST, bootstrap GET, socket set-up (upgrade and handshake), `openRoom`, with the second bootstrap in parallel to `openRoom`.

## Why it costs the user time
The socket needs only the cookie, which the sign-in answer set. Starting it after the bootstrap answer adds that answer's round trip to the time until the rows. The new person is waiting on the "Joining…" button at that moment.

## The change
Start the socket right after the sign-in answer and fetch the bootstrap at the same time:

```js
hub.resume();
hub.connect();                                   // the cookie is set; the socket needs nothing else
const doc = await api.get('/api/bootstrap');
if (!doc.user) { hub.stop(); return false; }
```

The chat page mounts after the bootstrap (it needs the rooms) and, when the socket is already up, its mount calls `openRoom` at once; otherwise the connected hook does, as today. A further step (server side): the sign-in answer itself could carry the bootstrap document, which removes the GET from this path.

## Risks and what could break
- When the socket connects before the bootstrap is applied, the hub's own bootstrap applies first and the sign-in's applies second; both are fresh, so the order is harmless. `hub.synced()` can guard it if wanted.
- A `signedIn()` that returns false must stop the hub again (`hub.stop()` sets the signed-out dot; the login page already shows the signed-out state).

## How to measure it
The sign-in journey on the far link with a throttled browser: time from the Join tap to the `rows` mark. One round trip less expected.
