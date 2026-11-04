# client-core: the paths as the code runs them (context for the findings)

Facts from the code on 2026-11-04. RTT = one round trip, about 900 ms for the far user.

## Warm open (worker installed, stored bootstrap, signed in, route not `/`)
1. Navigation: the worker answers from `yap-shell-{build}` `/login` (service-worker.js:59-64). No network. (`/`, `/login`, `/verify/*`, `/invite/*` are network-first: client-core-19.)
2. HTML parse (96,885 B): inline theme script (localStorage reads, index.html:20-91); 9 stylesheets (render-blocking, worker cache); import map; 42 `modulepreload` links (worker cache); all templates; `lib/signalr.min.js` (47,953 B) and `lib/tus.min.js` (87,020 B), both parser-blocking classic scripts; then `js/main.js` (module).
3. Evaluation of main.js's static graph (29 modules). `performance.mark('scripts')`. `serviceWorker.register` (main.js:89-94).
4. `start()` (main.js:143-160), in series:
   - `await snapshot.loadBootstrap()` (IndexedDB open + get #1)
   - `applyBootstrap(doc)` (12 parts; the frame is not mounted yet)
   - `hub.connect()` (not awaited): `connection.start()`, direct WebSocket (`skipNegotiation`), hub.js:96-101
   - `await snapshot.loadDrafts()` (IndexedDB get #2)
   - `router.start()`: route handler, `frame.mount` (`renderAll`), `await import('./pages/chat.js')` (evaluates chat, composer, gif-picker, recorder), mark `page-mount`, `chat.mount`: `Timeline` + `Composer`, `paintStored`: `await snapshot.loadTail(key)` (IndexedDB get #3), `setOpen(stored, fromDevice)`, mark `paint`. `open()` calls `hub.invoke('openRoom')`, which fails at once ("Needs a connection").
5. Network: [TCP+TLS if the socket has no warm connection: 2 RTT] upgrade (1) and SignalR handshake (1). Mark `socket`. `retryFailedImages()`.
6. `Promise.allSettled([GET /api/bootstrap?emojiStamp=..., chat open hook (invoke openRoom, 1 RTT), sender wake])` (hub.js:119-122).
7. `openRoom` answer: `setOpen(result)`, the timeline keeps unchanged rows, mark `rows` (chat.js:122-137).
8. Bootstrap answer (an HTTP request; on a cold HTTP connection 2 RTT set-up + 1): `applyBootstrap` (12 parts, frame mounted), `saveBootstrap` (IDB put), `beacon()` (invoke `beaconNonce` + cross-host fetch), mark `bootstrap`, `settleFirst()`, then `reportLoad` sends.
9. Later: snapshot tail write 800 ms after the rows; bootstrap write 2 s after the last part change; the browser's worker update check (GET /service-worker.js, no validator).

Rows for the far user: upgrade + handshake + openRoom = 3 RTT, plus 2 RTT of connection set-up when the socket cannot reuse a warm connection.

## Cold first visit (no worker, no stored copy, valid cookie)
HTML (network: set-up + GET) → all 60 subresources at once (CSS, 42 modules, 2 classic scripts, the 352 KB font) → main.js → `loadBootstrap()` null → `await fetchBootstrap()` (1 RTT) → mark `bootstrap`, `saveBootstrap` → `applyBootstrap` → `hub.connect()` → drafts → router → chat mount with an empty "loading" placeholder → socket (upgrade + handshake) → `openRoom` + a second bootstrap GET (by design) → rows. The worker registers at step 3 and its install precaches the shell list in parallel with everything after it (client-core-17).

## Resume (hidden > 30 s, page alive)
`visibilitychange` → `restart()` (hub.js:188-215): new HubConnection, the old one stops in the background, `connect()` → socket (likely new TCP+TLS, upgrade, handshake) → `openRoom` + bootstrap GET (likely a new HTTP connection) + sender wake (POSTs over HTTP) + beacon. The pill ends at the `openRoom` answer. Hidden < 30 s: `reconnectNow()` acts only when the state is Disconnected; a silently dead socket waits for SignalR's 30 s server timeout (client-core-06).

## Send (text)
Enter → `sender.queueMessage` → row → `publish(row)`: `outbox.save` (IDB put, not awaited) + `setPending` → the pending row draws in the same task → `flush()` → `await ready()` (resolved) → `api.post(/api/channels/{id}/messages)` (1 RTT on a warm HTTP connection) → `await outbox.remove(row)` (IDB commit, client-core-09) → `addMessage` → the row is confirmed. The hub's `message` event confirms it a second time and redraws the row (client-core-10).
With files: tus `POST` create (1 RTT) → `PATCH` bytes (1 RTT + transfer) → `GET /api/tus/info/{id}` (1 RTT, then 1 s sleeps while not ready) → message `POST` (1 RTT).

## SignalR client configuration
`@microsoft/signalr` 10.0.11 (47,953 B raw, 13,898 B gzip), JSON protocol, `skipNegotiation` + WebSockets with a negotiated fallback that sticks for the page's life (client-core-01), no `withAutomaticReconnect` (own loop: 1, 2, 4, 8, 16, 30 s, at once on `online`, visible, dot tap), default `serverTimeout` 30 s and `keepAliveInterval` 15 s, heartbeat invoke every 10 s visible / 60 s hidden. Server: `AddSignalR()` with no option overrides, `MapHub` with no options.
`tus-js-client` 4.3.1 (87,020 B raw, 22,424 B gzip): defaults except chunk size and retries.

## Module graph (static imports)
- Edges from main.js: store, update, api, hub, router, ui/frame, ui/overlays, session, render/text, render/time, render/dom, sender, notify, scene, offline/snapshot.
- Static closure of main.js: 29 modules: api, hub, main, notify, offline/db, offline/outbox, offline/snapshot, push, pwa, render/avatar, render/dom, render/text, render/time, router, scene, sender, session, store, ui/confirm, ui/emoji-picker, ui/frame, ui/gallery, ui/message, ui/overlays, ui/pins, ui/timeline, ui/voice, update, upload.
- The chat route adds 4: pages/chat, ui/composer, ui/gif-picker, ui/recorder (33 for a signed-in open).
- Sign-in pages add 3: pages/login, pages/verify, pages/invite.
- Only a page needs 6: pages/admin, pages/settings, pages/settings-debug, pages/channel-settings, ui/gif-library, ui/tooltip (148,942 B raw, 46,808 B gzip).
- Only a picker or action needs, yet sits in the boot closure: ui/emoji-picker, ui/gif-picker, ui/gallery, ui/pins, pwa, ui/recorder, upload, ui/confirm (60,284 B raw, 22,516 B gzip).
- `js/data/emoji-list.js` (44,024 B raw, 16,158 B gzip): dynamic import from ui/emoji-picker on first open only; in the import map and the worker's list, not preloaded. Already correct.
- All 43 modules: 475 KB raw excluding data; 42 get a modulepreload link.
