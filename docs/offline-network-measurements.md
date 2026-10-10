# Offline client network and interaction measurements

The rewritten client opens usable chat substantially sooner on the simulated 900 ms link. Both versions show outgoing text immediately and confirm it in approximately one round trip. The rewrite still transfers more bytes. Removing the extra session request solved a latency problem; it did not by itself make the whole client smaller or every interaction immediate.

## Versions and reproducibility

Recorded October 9–10, 2026, using Chromium 156.0.8078.4 and Node 22.22.1. The frozen original is revision `0cb67422cee301a57f8b8a8fff618e22ce442273`; the measured browser client is the pre-release shell v33 package identified by its DLL hash below. Separate full Release publishes, synthetic databases and uploads were used. Both ran in ASP.NET Development with SQLite, welcome page and bot disabled.

DLL SHA-256:

- Original: `0f11403184f10b03926ba0078e183acd8e734e01fa7c3d4a8b90bcd75ebc75a2`
- Rewrite: `07856b4c42d6378c8adecf7e960d10d2cd5f6d84e33d0525ee05b89f84785e91`

The later v34 change removes only the offline age gate; the network benchmark remained on the frozen v33 package. The PWA checks below exercise v34 separately.

Reproduction instructions and scripts are in the [browser test guide](../tests/browser/README.md#slow-network-comparison). Sanitized evidence: [primary samples](measurements/offline-network/network.json), [cache progression](measurements/offline-network/cache.json), [local interaction timings](measurements/offline-network/locality.json). Credentials and runtime logs are excluded.

## Method and limits

A shared full-duplex proxy shapes HTTP **and** WebSocket streams, including TLS handshake records. HTTPS/HTTP2 was verified. Each direction adds half the selected RTT; bandwidth is shared across the measured browser's connections. Original Blazor negotiated WebSocket compression; the custom chat hub did not in these samples. Byte totals count delivered encrypted TCP-stream bytes, including headers, framing and control traffic. Decoded CDP WebSocket payload counters are supplementary diagnostics, not wire-size measurements.

Profiles: `local` adds no latency or bandwidth cap; `latency900` adds 900 ms RTT; `slow900` adds 900 ms RTT with 1 Mbit/s downstream and 256 kbit/s upstream. Calibration checked byte integrity and timing: small responses took about 904–909 ms; a 128 KiB transfer on slow900 took 1,967 ms against 1,949 ms expected.

Each profile has six synthetic users, five DMs of 30 messages, and three images per DM. Both versions therefore start below their respective recent-message limits. A second browser uses an unshaped local connection to separate sender confirmation from recipient delivery. Authenticated cookies are preloaded; login UI is excluded. External CDNs are blocked for a repeatable first-party comparison. Servers are warmed before sampling, but cold browser contexts have fresh caches.

Startup readiness means an enabled composer and the same seeded message visible. This does not require every background download or the live connection to be ready. Startup bytes cover navigation through readiness plus 15 seconds. Message bytes include a three-second tail and may include periodic presence/session work. Inactive badge samples include a two-second tail. Local-send timing observes DOM mutation, not a physical display refresh.

Two cold/warm pairs and five outgoing/incoming messages per profile/version provide descriptive medians, not production percentiles. There is one inactive sample per case. TCP handshake/ACK costs, loss/congestion, jitter, phone CPU/radio and actual OS suspension are not simulated. Preliminary runs with a faulty chunk scheduler are excluded: independently scheduled timers could reorder stream bytes. The retained runs use FIFO delivery and patterned-response integrity checks.

## Startup

Milliseconds to readiness; downloaded KiB through readiness + 15 seconds (1 KiB = 1,024 bytes). “First warm” is the first reload after installation, not a permanently settled cache.

| Profile / version | Cold ready ms | First warm ready ms | Cold down KiB | First warm down KiB |
| --- | ---: | ---: | ---: | ---: |
| local / reference | 458.5 | 169.0 | 1123.0 | 971.4 |
| local / rewrite | 749.9 | 231.6 | 3879.7 | 1630.8 |
| latency900 / rewrite | 4207.6 | 1354.7 | 4109.9 | 1201.9 |
| latency900 / reference | 14653.0 | 13716.3 | 1124.7 | 1058.8 |
| slow900 / reference | 18064.9 | 17631.6 | 1126.3 | 974.3 |
| slow900 / rewrite | 8925.0 | 1378.5 | 2253.5 | 1165.8 |

On slow900, readiness improves from 18.1 to 8.9 seconds cold, and from 17.6 to 1.38 seconds on the first reload. The larger rewrite cold transfer is still incomplete at the end of this observation window; do not interpret that column as total installation size.

A separate slow900 cache progression (one sample, 40 active messages after the primary send/receive workload) distinguishes later reloads:

| Version | Cold ready / down KiB | First reload ready / down KiB | Third visit ready / down KiB |
| --- | ---: | ---: | ---: |
| Original | 18.83 s / 1,130.8 | 17.71 s / 978.5 | 12.35 s / 138.1 |
| Rewrite | 9.45 s / 2,286.2 | 1.34 s / 1,165.8 | 1.35 s / 267.9 |

The rewrite cold run had downloaded 4,094.4 KiB by the subsequent worker-ready/controller check at 48.62 seconds. That timestamp is an upper bound on worker preparation, checked after the observation window, not a precise offline-readiness time or proof every optional asset was cached. On both rewrite reloads, only 8,343 downstream bytes had arrived at UI readiness; most traffic followed in the background. Both versions transfer less on the third visit, so first-reload costs must not be generalized to every later launch.

## Sending and receiving

Medians in milliseconds, with upstream/downstream bytes counted at the measured browser. Confirmation excludes the original's pending ghost and the rewrite's pending row. The fast peer can receive before the shaped sender sees confirmation because only one side of that journey crosses the simulated link.

| Profile / version | Local visible ms | Own confirmed ms | Fast peer receives ms | Up bytes | Down bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| local / reference | 1 | 38 | 28 | 385 | 1412 |
| local / rewrite | 5 | 46 | 54 | 808 | 3155 |
| latency900 / rewrite | 5 | 928 | 492 | 786 | 3207 |
| latency900 / reference | 1 | 915 | 461 | 382 | 1587 |
| slow900 / reference | 1 | 930 | 465 | 383 | 1542 |
| slow900 / rewrite | 5 | 952 | 502 | 850 | 3208 |

Normal rewritten sends use one POST without a per-send session preflight or follow-up sync GET. At 900 ms RTT, confirmation remains around one round trip, with 13–22 ms higher median than the original in these samples. Sending via HTTP does not create a new TCP/TLS connection for each message. Both clients meet immediate local text feedback here.

For incoming messages from the fast peer:

| Profile / version | Visible ms | Up bytes | Down bytes |
| --- | ---: | ---: | ---: |
| local / reference | 11 | 435 | 1692 |
| local / rewrite | 54 | 238 | 3335 |
| latency900 / rewrite | 491 | 300 | 3383 |
| latency900 / reference | 459 | 456 | 1757 |
| slow900 / reference | 470 | 476 | 1799 |
| slow900 / rewrite | 504 | 260 | 3356 |

Inactive badge delivery took 477 ms original / 517 ms rewrite on latency900, and 476 / 512 ms on slow900. Corresponding downstream traffic was 955 / 1,573 bytes and 1,150 / 1,603 bytes. This is not identical work: the rewrite also persists the inactive message body for subsequent local navigation; the original updates the badge without caching that body.

## Immediate feedback and emoji caching

An independent browser diagnostic held API writes open. Reaction feedback (31 ms), opening an editor (30 ms), saving an accepted-message edit (26 ms), sending (31 ms) and inserting an emoji (14 ms) completed without server responses. These timings include two animation frames and are single samples, unlike the DOM timings above. They establish those paths, not every action or device.

Two measured exceptions remain:

- Editing a never-attempted queued message behind another in-flight operation did not update within the 2,008 ms observation period. `storage.changePending` waits for the sender's account lock, held across network work. Queued deletion shares this path by source inspection.
- First emoji opening took 656 ms, including 297 ms in the synchronous click handler. Reopening took 77 ms with only 1.4 ms in the handler. Local data still takes CPU time to turn into a large grid.

Emoji categories/search/custom/recent metadata is persisted in IndexedDB. Artwork uses versioned service-worker CacheStorage and document-local blob URLs. Insertion is local; recents synchronize later with 500 ms coalescing. The artwork bundle is 10,416,540 bytes unpacked, 949,890 bytes Brotli, or 1,874,145 bytes gzip. A direct catalog response was 103,372 bytes without Content-Encoding.

Although the bundle is excluded from core worker precaching, `content.js` fetches it eagerly. Concurrent cached/online `loadContent` calls can both see an empty artwork map and fetch/parse independently because there is no shared in-flight promise. An initial uncontrolled fetch can miss the worker cache and be downloaded again on the first controlled reload. The cache progression above is consistent with additional first-reload preparation; it does not attribute every byte to emoji. Font precaching and dependency warming also overlap.

GIF favorite feedback and explicit presence status still await server acceptance by source inspection; they were not timed. The frozen original's reaction-count path uses Blazor callbacks, so these tests do not establish that every original reaction was optimistic.

## Findings and recommended order

| Severity | Finding | Recommendation |
| --- | --- | --- |
| High UX | Queued edit/delete can wait behind a network-held sender lock. | Separate local intent changes from delivery coordination using an atomic claim/update transaction. Re-read the payload when marking its first attempt. Keep payload immutable after that point, and use a follow-up mutation for attempted sends. Simply removing the lock creates a stale-payload race. Test cross-tab edit/claim races and dropped acknowledgements. |
| Medium | First emoji opening blocks the UI while constructing the full grid. | Render visible/category rows first, or prepare bounded chunks while idle. Keep cached reopening cheap. Verify input responsiveness with the artwork already cached so network and CPU costs remain separate. |
| Medium | Initial and first-reload background bytes are large, with avoidable artwork/catalog/cache work. | Share in-flight artwork loading, deliberately populate/reuse its versioned cache, and use a small catalog revision for revalidation. Avoid downloading the entire bundle merely to prepare unused features; load required artwork with foreground priority. Deduplicate font warming. Preserve offline availability for content already used. |
| Medium | Message downstream traffic is roughly twice the original despite incremental updates. | Inspect acknowledgement/stream duplication and repeated metadata, then reduce redundant fields/delivery. Compare actual encrypted bytes again. Compression differences are a confounder; do not equate decoded JSON size with wire cost or remove ordering/receipt guarantees. |
| Low UX | GIF favorite and explicit status feedback await the server. | Apply the desired local state immediately, then reconcile failures with clear retry/rollback behavior and retained account ownership checks. |

Relevant code: [pending changes](../Yap/wwwroot/chat-client/storage.js), [sender coordination](../Yap/wwwroot/chat-client/sender.js), [emoji data and grid](../Yap/wwwroot/chat-client/content.js), [GIF favorites](../Yap/wwwroot/chat-client/gifs.js), and [presence](../Yap/wwwroot/chat-client/live.js).

These measurements describe frozen v33 (the same artwork behavior remained in v34). Shell v35 replaces the artwork bundle with individual SVGs and local metadata, and repairs the catalog/render race. These timings are not measurements of v35; picker grid construction and physical-phone performance still need measurement. Server fan-out has also since been redesigned; see [the separate fan-out measurements](measurements/fanout/README.md).

## Four-week PWA return and antiforgery

Shell v34 removes the seven-day offline age gate from cached chat and media. Saved unlocked accounts remain usable after weeks offline. Explicit sign-out/Forget, account replacement and known revocation retain their existing purge/lock behavior. Browser storage eviction can still remove cached content.

The standalone-mode check with 28-day-old local authentication metadata passes for online draft/account retention, offline messages/media and known-revocation locks. A deliberately rejected antiforgery token triggers one session refresh and one retry, accepting exactly one message. The fixture token was 198 characters; length is not an expiry period. There is no configured fixed two/four-week antiforgery expiry; the login cookie has a 365-day sliding lifetime. Bootstrap refreshes document credentials. Authentication revocation or server key changes can still require recovery/sign-in.

Actual v33→v34 worker activation, retained draft/outbox, exactly-once recovery and offline reload pass in Chromium and Firefox. These checks age browser metadata; they do not advance the server clock or reproduce a physical phone suspended for four weeks.
