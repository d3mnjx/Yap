# backend-request: index

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
backend-request-01 | Send the open conversation with the connect, not after it | 2 | M | 1 round trip (~900 ms far user) off server rows on every connect, reconnect, resume | medium
backend-request-02 | Cache the quick reactions per person instead of scanning every message in memory | 1 | S | removes an O(all messages) scan from every bootstrap, React and EmojiUsed call (est. 2.5-5 ms at 50k msgs, 25-50 ms at 500k) | medium
backend-request-03 | Presence for the bootstrap scans all sessions once per person under the global lock | 1 | S | O(sessions x people) to O(sessions) per bootstrap; matters at load-test scale | high
backend-request-04 | Start listening sooner after a deploy (log clean-up and 3 child-process probes run in series before Kestrel) | 1 | S | earlier reconnect after each deploy; backoff can amplify each second saved; unknown | medium
backend-request-05 | Return the upload result with the final tus response, drop the /api/tus/info round trip | 1 | S | 1 round trip per upload batch (~900 ms far user) | medium
backend-request-06 | Use tus creation-with-upload (uploadDataDuringCreation) | 1 | S | 1 round trip per upload batch for files up to 5 MB | medium
backend-request-07 | Do not modulepreload Settings, Admin and channel-settings pages at every start | 1 | S | cold: ~41 KB compressed less (~0.33 s at 1 Mbit/s); warm: 133 KB less JS to compile | medium
backend-request-08 | Load lib/tus.min.js on first upload, not as a blocking script at every start | 1 | S | cold: 22-27 KB off the critical path (~0.2 s); warm: no 87 KB parse before main.js | medium
backend-request-09 | Compress shell files once per build at top level instead of Fastest per request | 2 | M | >= 48 KB (14 %) less on a cold load by gzip proxy, ~0.4 s at 1 Mbit/s | medium
backend-request-10 | Give the page an ETag (304 on revalidation) and build its bytes once | 1 | S | ~22-26 KB per network page fetch (~0.2 s at 1 Mbit/s) | medium
backend-request-11 | Leave nulls (later empty lists) out of message rows on the uncompressed socket | 1 | S | ~2-2.8 KB per 50-row tail (~20 ms), ~3 KB more with lists (category 2) | medium
backend-request-12 | Keep link cards longer than an hour (and across restarts) | 3 | S | cards on screen with the rows instead of after a re-scrape; no layout shift; unknown | medium
backend-request-13 | Bound the number of link-card scrapes that run at once | 1 | S | protects shared bandwidth/CPU during history scroll (up to 250 scrapes per page); unknown | medium
backend-request-14 | Avoid synchronous disk work in openRoom after a restart (image sizes, media-cache dir scans) | 1 | M | fewer blocked pool threads in the post-deploy reconnect wave; unknown | medium
backend-request-15 | In restricted rooms, serialize reaction/card/edit events once, not once per reader | 1 | S | N serializations to 1-2 per event; ms for hundreds of readers | medium
backend-request-16 | Per-person events via a per-person group, not Clients.User (scans all connections) | 1 | S | removes recipients x connections work from each unread tick; scale only | medium
backend-request-17 | Index messages by id; GetMessage scans the conversation on every lookup | 1 | S | O(n) to O(1) per lookup (est. 10-15 us at 5k rows, >100 us at 50k) | medium
backend-request-18 | Move the push dispatch off the send request | 1 | S | send POST answers before push work (few ms for DMs to away people); unknown | medium
backend-request-19 | Index read states by person (bootstrap and push scan everyone's) | 1 | M | est. 1-2 ms per bootstrap at 60k read states; nothing at 30 people | medium
backend-request-20 | Find a DM by its two people with a dictionary, not a copy+scan of all conversations | 1 | S | est. 50-100 us per DM send/openDm at 10k conversations | medium
backend-request-21 | Stop resending texts and themes in every bootstrap; stop per-request config binding | 2 | M | ~1.2 KB of ~4.9 KB compressed per connect (~10 ms); users list is the scale issue | medium
backend-request-22 | Admin Users tab: SQL aggregation, parallel reads, no HTTP_REQUEST rows in the DB | 2 | M | Users tab load time, grows with uptime and traffic; unknown | medium
backend-request-23 | Remember the branding overrides instead of a stat on every request | 1 | S | one syscall less per request; small | low
backend-request-24 | Longer SignalR client timeout so short-hidden desktop tabs keep their socket | 3 | S | skips a ~2.7 s reconnect after 30 s-2 min hidden (desktop); unknown share | low
backend-request-25 | Publish with ReadyToRun | 1 | S | less JIT at startup and first requests after a deploy; unknown | low
