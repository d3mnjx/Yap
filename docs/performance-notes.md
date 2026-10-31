# Fast load and resume: design notes

Written 2026-10-22 and checked against the code the same day. These notes guide the work on load time and resume time for one user on a slow connection. They record the decisions of the design dialogue of that day. They are not the product spec.

## The target

The target user is far from the server and has a bad connection. Production data from 2026-08-11 gave a round trip of about 900 ms for such a user, while the slowest server send cost 71 ms. The wire dominates. Every round trip on the critical path costs that user about a second.

The changes are universal. A change that removes a round trip from the critical path helps every user. Nothing in this plan is specific to one device or one network.

Constraints:

- The app and the build need only dotnet. No node, no bundler. The `{{build}}` stamp is already substituted into the page by C# (`Endpoints/ShellEndpoints.cs`): once per process in Production, on the first request, and on every request in Development. The stamp has the form `2026-10-22-1815`. The new generated parts use the same mechanism.
- The existing tests in `tests/browser` use node and Playwright. That stays the only place node appears. The app never depends on it.
- The font stays as it is. Inter covers Latin, Greek and Cyrillic (2,852 code points in the regular file, 2,816 in the italic) and no Arabic, Hebrew or CJK. The browser draws those from a system font. A subset would drop Greek and Cyrillic for no gain, because the font loads once per device and then stays cached.
- Simplicity wins. Build on the mechanisms that exist (the build stamp, the per-build worker cache, the heartbeat telemetry, the admin diagnostics, the connection dot).

## What the code does today

Facts from the code on 2026-10-22, before any change.

**The shell over HTTP.** The page, all scripts and all stylesheets are served with `Cache-Control: no-cache` (`Program.cs` for every `.js` and `.css` file, `ShellEndpoints.cs` for the page). The fonts, the icons, the images and the notification sound have no cache header at all, so the browser applies its own heuristic. The page makes the browser fetch 52 files: the page, 9 stylesheets, 39 preloaded modules, 2 classic scripts and the font, plus the icon and the manifest. 51 of them are `no-cache`, so every open goes to the network for them before it paints. The service worker fetches the page, the scripts, the styles and the fonts network-first with no timeout (`service-worker.js`). It falls back to the cache only when the fetch throws, so a 5xx from a proxy reaches the page. Its precached stylesheets never match, because the list holds `/app.css` and the page asks for `app.css?v=…`. The theme images (`.webp`) pass the worker untouched. Where Caddy or Cloudflare stand in front of Kestrel, the requests run in parallel over HTTP/2, but the paint still waits for the network. Cloudflare does not cache a `no-cache` answer, so no deployment gets the shell from the edge. The repo does not record the deployments: the compose file publishes Kestrel directly, and the load-test box ran Cloudflare in front of Caddy. The `protocol` field of the boot report will show what the field has.

**Media.** Uploads, the GIF cache and the media cache are already correct: immutable headers and cache-first in the worker. Emoji images are cache-first in the worker, but their headers differ on purpose. Since 2026-10-31 the worker keeps one emoji cache, `yap-emoji-v2`, for every emoji image, the picker's grid included, never pruned (the emoji set bounds it), with a memory layer in the worker for repeated images (`rememberedFirst`). Two detours that evening are gone: a cache of its own for the picker (one storage read per image either way), and the picker bypassing the worker for the browser's HTTP cache (fast online, but a cache the browser may drop, and the picker must work without a network). Both gave a picked emoji a different path from the row's, first by a `?picker` query, then by the request mode, and the row drew an empty box until the CDN answered. One URL, one cache, one path. WebKit opens a cache by reading every record it holds, and the worker starts cold at each launch of the installed app; one cache that the picker had filled was thought to make a cold open wait 1 to 2 seconds for the first emoji. The split changed nothing; the Settings debug card then measured the wait on the phone: 876 emoji requests in the first three seconds, half answered by 1.66 s and the last at 2.9 s, about 3 ms each, one after another. Every `<img>` element is a request of its own there, and the rows were drawn four times at an open (the device's copy, two full redraws at the bootstrap, the server's rows). So the worker remembers the rows' emoji in memory for its life (`rememberedFirst`: one storage read per URL, every later request shares it), and the timeline redraws the rows at a bootstrap only when a name, a picture or the quick reactions changed. Measured after that deploy on the same iPhone: 524 emoji requests in the first three seconds (two draws of the rows instead of four), half answered by 425 ms and all by 636 ms, with the server's rows at 575 ms. The emoji show with the text. Two more cuts followed the same evening: a reset keeps the rows whose message did not change (the server's rows after the device's copy are nearly always the same fifty; `unchanged` in ui/timeline.js), and the action bar's three quick reactions are built when the bar first shows, on a hover, a tap or keyboard focus (`fillQuick` in ui/message.js), instead of for every row at draw time, which had been three images per row for bars nobody sees. The built-in packs ship at a stable URL and carry one day of `max-age`, so a redrawn image propagates on the next deploy. Custom emoji and the fallback images carry no header. The emoji catalogue (`/api/emoji?v=`) is immutable in the HTTP cache; the worker never touches `/api/`. Profile pictures are excluded by design (stable URL, `max-age=300`). See the memory `static-asset-caching`.

**The cold load.** The order in `js/main.js` is: the page and its scripts load, then `await /api/bootstrap` with nothing painted but the themed empty page, then the hub connect starts (not awaited) together with the emoji catalogue fetch, then an IndexedDB read of the drafts, then the router mounts the frame, then the chat page paints the stored snapshot from IndexedDB. The negotiate, upgrade and handshake run while the frame and the snapshot paint. The `openRoom` at mount fails at once without a connection. The `openRoom` that returns the newest 50 rows runs from the `connected` hook (`js/chat.js`, TL-35), in parallel with a second bootstrap fetch (`js/hub.js`). That second fetch runs after every connect, also after a reconnect: it replaces the whole store and mints the beacon nonce. The stored bootstrap is used only when the first fetch throws, which includes every non-2xx answer. The fetch has no timeout.

**The resume.** When the installed app returns after an hour in the background, the page is alive and shows the old rows. The socket is dead, but the client state is still `connected`. The visibility handler reconnects only when the state is `Disconnected`, so it does nothing (`reconnectNow` in `js/hub.js`; the `online` event calls the same function). Neither side overrides the SignalR timeouts. The client waits for the 30 s server timeout, then the first 1 s delay of its own retry loop (1, 2, 4, 8, 16, 30 s; the client does not use SignalR's automatic reconnect), then negotiate, upgrade, handshake and `openRoom`. The dot hides when the socket connects, before the rows arrive. The user sees the old screen for about 30 s, then a short amber dot, then the new rows. Missed messages are not replayed; the client refetches the tail of 50 rows and keeps the older loaded pages only where the tail overlaps them.

**The loading UI.** The connection dot: hidden when connected, amber and pulsing while connecting or reconnecting, a grey ring when offline, red when signed out or when a new build is up while connected. The "Loading messages..." line shows only for a conversation with no stored snapshot, not while offline, and only after 400 ms. The notice strip shows one message in the code, "Please refresh" for a new build. SH-20 also specifies "Sign in to continue." for a signed-out page without a connection; the client does not implement it. Nothing marks rows that came from the device and not yet from the server.

**Round trips before live rows**, counted from the code for an installed app with everything cached:

| | round trips |
| --- | --- |
| today | 7 to 8: page, script revalidation, bootstrap, negotiate, upgrade, handshake, openRoom |
| after this plan | 3: upgrade, handshake, openRoom. The paint needs 0. |

## The order of work

Measure first, then the caching, then the resume, then the cold chain. The first numbers after the work are the baseline. Later optimisations target the slowest phase in the admin table.

### 1. The boot report

Landed 2026-10-22, rule AD-41.

One report per page load. The existing waits of AD-26 travel inside the heartbeat as name and value pairs, and the server accepts five names (`send`, `open`, `older`, `start`, `reconnect`; see the memory `latency-telemetry-waits`). The boot report has six phases and four facts, so it does not fit that shape. It goes through a new hub method, `ReportLoad`, called once when the `rows` phase lands. Without a socket nothing can report anyway. Only the first page mount of a load reports, like `start`.

The phases, in ms from the navigation start (Navigation Timing and `performance.mark`):

| Phase | Meaning |
| --- | --- |
| `html` | The page has arrived (`responseEnd`). |
| `scripts` | The modules are loaded: a mark as the first statement of `js/main.js`, which runs after its whole static import graph. The existing `page-mount` mark does not fit, because it is set after the bootstrap, the drafts read and the frame mount. |
| `bootstrap` | The server's bootstrap answer is applied: the fetch on a first load, the connection-bound request otherwise. |
| `paint` | The first rows are on screen, from the device or from the server. |
| `socket` | The hub reports connected. |
| `rows` | The server's rows are on screen. |

The facts, once per load:

| Field | Source |
| --- | --- |
| protocol | `nextHopProtocol` of the navigation entry: `h2`, `h3` or `http/1.1`. |
| requests | The count of resource entries. |
| cached | The count of entries with `transferSize === 0`, answered by a cache. |
| bytes | The sum of `transferSize`. |

The device facts come from the server at connect. Mobile or desktop comes from the User-Agent header, as today (`UserAgent.IsMobile`, stored on the `Session`). The PWA flag comes from the hub URL (`pwa=1`), which today is written only to the user record (`PwaInstalledAt`); the `Session` gets a `Pwa` field from the same query. The browser name and the OS are new: a small regex table next to `IsMobile`, no library. Both go on the `Session`.

Storage: in memory since restart, as the existing latency stats. The last report per connection on the `Session`; the ring of the last 50 closed connections keeps theirs, so the table shows a load after the tab is gone. No per-person average: the table has one row per load, and an average had no reader.

Admin: a "Load time" table in the Diagnostics tab. One row per load: person, browser and OS, mobile or desktop, PWA or tab, protocol, the six phases, requests, cached, bytes. The slowest `rows` first.

Rules: numbers outside 0..600,000 ms are dropped, as for the waits. A load in a hidden tab still reports the phases, because Navigation Timing is not throttled, but the row is marked hidden.

### 2. The dev-loop check

A Playwright script in `tests/browser`, `npm run load`. It drives a throwaway server, like the other scripts there. The browser's network runs through a CDP throttle: 900 ms round trip, 1 Mbit/s each way, as a start. The numbers from the boot reports in production replace them later.

The script reports, for comparison before and after a change:

1. Load 1, cold: the six phases, requests, cached.
2. Load 2, warm: the same. Cached must be close to requests.
3. The resume: the page goes hidden, the server drops the connection, the page returns. The time from the return to the server's rows on screen.

It prints the numbers. It does not assert, because the throttle makes the numbers noisy. The reader compares two runs.

### 3. The shell caching

Landed 2026-10-22, rule OF-18.

**The worker goes cache-first for the shell.** A navigation to a signed-in route, a script, a stylesheet, a font, an icon, an image and the notification sound are answered from the per-build cache (`yap-shell-{build}`) when present, and from the network otherwise. The per-build cache, the precache at install, `skipWaiting`, `clients.claim` and the cleanup at activate stay as they are. The root, the login page, the verification page and an invite stay network-first with the stored shell as the fallback: the server answers a signed-out visitor differently there (the welcome page, AD-36; the visitor log, AD-20). The installed app launches at `/pwa-launch?lt=…`, the sign-in hand-off of its first launch, which cost a round trip before any paint on every launch; that navigation is answered from the cache too, and the page does the hand-off itself with one fetch when it is signed out. The worker's rule changed from "a page online always runs the build the server has" (its old header comment) to "a page runs the build its worker installed, and the new-version strip asks for a refresh when the server's build differs"; the spec has it as OF-18. The check that drives the strip stays: the bootstrap's build stamp against the page's (`js/main.js`). The Reload button waits for a worker that is still installing, up to 15 s, because a reload before the new worker takes over would serve the old shell again.

An open page of the old build that lazy-loads a page module after a deploy gets the current file from the network, as today. See the memory `mixed-build-document`. The strip asks for a refresh, as today.

**The shell list is generated.** `SHELL_URLS` in the worker was 60 URLs kept by hand, and the worker a plain static file that read its build from its `?v=` query. The server serves `service-worker.js` through an endpoint that writes in `{{build}}`, `{{shell}}` and `{{routes}}` (`ShellEndpoints`, `ShellAssets`), so the cache is named after the build the worker serves, and the browser installs the new worker on the byte change after a deploy. The list is computed once at startup from `wwwroot`: `js/**/*.js`, the stylesheets, `lib`, the regular font, the icons, the small images and the sound. Every script and stylesheet carries its `?v={build}` query, because `cache.match` compares the query. The worker's asset test has `webp` for the theme backgrounds, which are not precached (`images/themes` is 1.5 MB); the worker keeps them, and the italic font, from their first use. The query `?v={build}` on the registration stays.

**Every module gets a versioned URL, with an import map.** The page gets `{{importmap}}` and `{{modulepreload}}` in its head, both from the same scan of `wwwroot/js/**/*.js` as the worker's list:

```json
{ "imports": { "/js/store.js": "/js/store.js?v=2026-10-22-1815", "/js/hub.js": "/js/hub.js?v=2026-10-22-1815" } }
```

A relative import such as `./store.js` resolves to `/js/store.js` first, and then the map rewrites it. No import in any script changes. An import map rewrites `import` specifiers only. It does not touch a `<script src>` or a `modulepreload` href. So the entry script `js/main.js`, the `modulepreload` links and the two classic scripts (`lib/signalr.min.js`, `lib/tus.min.js`) get `?v={{build}}` in the page, as the stylesheets already have. The map comes before the first `modulepreload` link. Import maps work in every browser since Safari 16.4 (2023).

**The HTTP headers.**

| File | Header |
| --- | --- |
| The page | `no-cache`, as today. It carries the build stamp. |
| `.js`, `.css` with a `v` query | `public, max-age=31536000, immutable` |
| `.js`, `.css` without a `v` query | `no-cache`, as today, for a bare URL from an old page |
| `.woff2` | `public, max-age=31536000, immutable`. The file name must change when the font changes. Nothing enforces that today; a comment at the header rule and a note in `fonts/` record it. |
| icons, images, the sound | No header, as today. The worker answers them cache-first. |
| `service-worker.js` | `no-cache`, as today (it is a `.js` file). The browser checks it on every registration anyway. |

With these headers the Cloudflare deployments serve the versioned files from a nearby edge. The page still comes from the origin. The Caddy deployments need no change.

**The build stamp invalidates every shell file on each deploy.** That is about 200 to 270 KB compressed for the scripts and styles, depending on the compression level (the server uses the framework default, the fastest). The new worker fetches it in the background while the old page runs. A per-file hash would invalidate only the changed files. It adds machinery, so the stamp stays until deploys become frequent enough to matter.

### 4. The resume

Landed 2026-10-22, rule TL-39.

**The client drops a dead socket at once.** On `visibilitychange` to visible, when the page was hidden longer than the server's client timeout (30 s, the default on both sides), the client stops the SignalR connection object and connects again at once, without the 30 s client timeout and without the 1 s retry delay. The server has dropped the connection already. Two details of `js/hub.js` matter here. The exported `hub.stop()` is the sign-out stop: it sets the `stopped` flag and the red dot, and `connect()` then returns at once, so the resume must not call it. The `onclose` handler schedules its own 1 s retry, so the deliberate stop marks itself and the handler skips that retry. The `online` event needs no change: the `offline` handler already stops the connection, so `reconnectNow` connects at once. The chat page re-opens the conversation on `connected`, as today (TL-35). The `reconnect` wait keeps its rule: a loss noticed within 35 s of the return counts from the return, which the deliberate stop meets.

When the page was hidden for less than 30 s, nothing changes: the socket is alive, or the existing client timeout handles it.

**The "Catching up…" pill.** A small pill floats over the top of the message list. It takes no vertical space, so no row moves when it appears or goes away (the rule from the pinned-messages work). It holds a spinner and the text "Catching up…". With `prefers-reduced-motion`, the spinner is still.

The pill shows from the moment the rows on screen came from the device and the server has not answered yet:

- the visible event after a long background, until `openRoom` returns and the rows are on screen, and
- the cold open with a stored snapshot, from the cached paint until the server's rows are on screen.

It ends when the server's rows render, not when the socket connects. When the reconnect fails, the pill does not spin forever: it turns into a static "No connection. Showing older messages." and the dot shows the attempts, as today. The dot stays as it is: it reports the socket, the pill reports the content.

Wording: "Catching up…" describes the check, and stays true when no new message arrived. "Updating…" reads as an app update next to the "Please refresh" strip. "Loading new messages…" promises a result that most catch-ups do not have.

The "Loading messages..." line for a conversation with no snapshot stays.

### 5. The shorter cold chain

Landed 2026-10-22. The beacon nonce moved from the bootstrap's `?connection=` query to a hub method, `beaconNonce`, because a client that skips the negotiate step does not know its connection id.

1. **Paint from the stored bootstrap at once.** Today the stored bootstrap is used only when the fetch throws, and the fetch has no timeout. With it, the frame and the snapshot paint before any network answer. The fetched bootstrap replaces it when it arrives.
2. **Start the hub connect in parallel with the bootstrap fetch.** When the stored bootstrap says signed in, `hub.connect()` starts at once. Today it starts after the bootstrap answer: before the paint, but after the round trip.
3. **One bootstrap fetch per cold load.** Today there are two: `main.js` before anything, and `hub.js` after every connect. The second one replaces the whole store, mints the beacon nonce, and after a reconnect corrects unread counts and presence. It runs in parallel with `openRoom`, so it costs bandwidth and server time, not a round trip. With the stored paint, the `main.js` fetch goes, and the connection-bound fetch is the one network fetch of the load; it also replaces the stored copy. When no stored bootstrap exists (the first load on a device, or after a sign-out), the `main.js` fetch stays, as today. The fetch after a reconnect stays.
4. **Skip the negotiate round trip.** `skipNegotiation: true` with the WebSockets transport saves one round trip per connect. SignalR then has no fallback transport, so the client tries the direct WebSocket first and, when that fails, builds a connection with negotiation as today. Caddy and Cloudflare both pass WebSockets. The admin diagnostics already show the transport per session (the Sessions table, AD-25, and the connection rows of the latency table, AD-26), which tells whether any deployment needs the fallback.

## Measurements

`npm run load` on 2026-10-22, one machine, HTTP/1.1, through the script's link of 900 ms round trip and 1 Mbit/s. Milliseconds from the navigation start. "rows" is the server's rows of the first conversation on screen. "cached" counts the files that came with no body bytes on the wire, a 304 included.

| Load | html | scripts | bootstrap | paint | socket | rows | files | cached | on the wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold, before | 1170 | 13122 | 14065 | 18381 | 17218 | 18381 | 62 | 0 | 803 KB |
| warm, before | 1174 | 9270 | 10206 | 10243 | 12939 | 14043 | 61 | 55 | 98 KB |
| warm, after step 3 | 3 | 57 | 989 | 1028 | 3720 | 4823 | 61 | 56 | 8 KB |
| warm, after step 5 | 3 | 49 | 3018 | 88 | 1876 | 2980 | 58 | 56 | 4 KB |

The cold load is unchanged (17.7 s after; a first visit has nothing stored). After step 5 the paint comes from the stored copy at 88 ms, and the `bootstrap` phase is the server's answer, which now lands with the rows.

The resume in the script (35 s hidden and frozen, the socket's server side gone): 1.7 s before, 3.0 s after. The frozen page's overdue 30 s timer fires at the thaw in this browser, so the emulation never showed the 30 s wait that step 4 removes, and it does not exercise the restart path either. The 3.0 s after is three round trips (upgrade, handshake, openRoom), the floor of this link; the 1.7 s before is below that floor and is not explained, so the two are not a comparison. The gain of step 4 shows on a browser whose timer does not fire at the thaw, which this emulation cannot model (see Open points).

## After the work

Deploy. Read the Load time table after a few days. The slowest phase per device class is the next target. Likely candidates, to confirm with numbers and not before: the 50-row tail with media thumbnails, the size of the page (91 KB raw), the emoji catalog fetch at boot.

2026-10-31: the emoji catalogue fetch at boot is gone. Its two parts went where they belong. The image rules (the Twemoji base, the override names, the custom packs) travel with the bootstrap as `emojiImages`, so the stored copy paints with them and no row shows the device's own emoji font first. The picker's list (categories, keywords) is a static module, `js/data/emoji-list.js`, precached with the shell and imported by the picker on its first open; `ShellAssets` leaves `js/data/` out of the modulepreload links, so the start neither fetches nor compiles it. The stored tail then also carries the bytes of the emoji its rows draw (offline-design-notes.md, Reading), so the stored paint shows them with the text in one frame instead of an empty box per emoji until the worker answers.

## Open points

- The resume design treats a hidden page as alive. iOS often evicts the installed app instead, and a relaunch follows the cold path. Both paths end in the same pill, so the user sees the same thing.
- Whether a browser's timer clock runs during suspension decides whether the 30 s client timeout fires at once on return or runs its full 30 s. The fix above makes this moot for a long background, and the question stays only for a short one.
- The deployment facts (Caddy, Cloudflare, HTTP/2 or HTTP/3) are not in the repo. The `protocol` field of the boot report records what the field has.
- `Microsoft.Playwright` (NuGet) could replace the node scripts in `tests/browser` one day, so that node leaves the repository entirely. Not part of this work.
