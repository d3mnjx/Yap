# backend-services: index

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
backend-services-01 | Compress the hub's WebSocket frames (permessage-deflate) | 2 | M | 50-row openRoom ~19.6 KB -> ~4.5 KB; ~120 ms per open/reconnect/older page at 1 Mbit/s | medium
backend-services-02 | Trim the message row shape (per-row channelId, nulls, 3 image URLs, timestamps) | 2 | M | ~19.6 KB -> ~11 KB raw per 50 rows (~70 ms); small once 01 lands | medium
backend-services-03 | Cut the quoted original in ReplyToDto to ~300 characters | 1 | S | up to ~4 KB less per reply to a long message; typical small | high
backend-services-04 | PresenceService.Effective: StatusLocked per group, not a rescan per person | 1 | S | ~23-67 ms less global-lock time per bootstrap at 1,000 people/1,500 sessions; seconds during a reconnect storm | high
backend-services-05 | Per-person session index in PresenceService | 2 | M | removes O(sessions) scans per connect/push and O(people x sessions) lock holds on admin pages | medium
backend-services-06 | Quick reactions without scanning every message on bootstrap, reaction and emoji pick | 1 | S | ~5-15 ms per call at 50k messages (est.), plus channel-lock holds | high
backend-services-07 | Link cards: longer TTL and stale-while-revalidate | 3 | S | no card loss, no double redraw and no remote refetch per link row per open after 1 h | high
backend-services-08 | Persist scraped link cards across restarts | 2 | M | no card loss and scrape burst after every deploy | medium
backend-services-09 | Serve card pictures (og:image) from this origin, with size | 2 | M | ~3 RTT (~2.7 s far user) per new card host; no card box jump | medium
backend-services-10 | Run the action-log cleanup after the server listens | 1 | S | est. 0.5 to several s less start time per deploy (unknown) | medium
backend-services-11 | Two queries for messages and reactions at start, plus step timings | 2 | M | est. 0.2-1 s of per-query overhead at ~1,000 conversations; real number from the timings | low
backend-services-12 | DispatchPush in the background, not in the send POST | 1 | S | est. 3-30 ms per away recipient off the sender's answer (push crypto + scans) | medium
backend-services-13 | Bot join and sign-in notices in the background | 1 | S | bot send + push off OnConnectedAsync (delays openRoom) and off the sign-in answer | medium
backend-services-14 | Bot message handler: test the message's channel, not all bot DMs | 1 | S | tens of microseconds per message; free | high
backend-services-15 | Message lookup by id via dictionary; cursor from the end | 1 | S | removes O(history) scans under the room lock per reply row, reaction, edit, older page | high
backend-services-16 | Restricted rooms: one send for viewer-independent events, two variants for replies | 1 | S | N serializations -> 1 per reaction/card event; est. few ms at 500 viewers | medium
backend-services-17 | Users directory out of the bootstrap when the client's stamp is current | 2 | M | ~10 KB (100 accounts) to ~100 KB (1,000) less per reconnect, competing with openRoom | medium
backend-services-18 | Texts and themes built once and sent only when stale | 2 | S | ~1-1.5 KB compressed per bootstrap (~10 ms) | medium
backend-services-19 | Read states indexed by person (bootstrap unread, push total) | 2 | M | est. 0.2-1 ms per bootstrap/push recipient at 15k-50k read states | medium
backend-services-20 | Direct messages indexed by pair and person | 2 | M | removes channel-table copies per openDm, DM POST, bootstrap; small | medium
backend-services-21 | Larger older pages on request | 2 | S | 300 rows of scroll-back: 6 round trips -> 2-3 (~2.7-3.6 s at 900 ms RTT) | medium
backend-services-22 | Warm picture sizes and media-cache lookups after start | 1 | S | first opens after a deploy skip sync disk reads on the hub thread; est. tens to hundreds of ms | medium
backend-services-23 | Load or memory-map the IP2Location file at start | 1 | S | est. 0.1-1 s off the first Settings/admin request after restart | low
backend-services-24 | Admin Users page from memory, not two full log-table reads | 2 | M | est. 0.5-3 s per page open at 1,000 users; shorter presence-lock holds | medium
backend-services-25 | Admin Diagnostics: bucket the 7-day series | 3 | S | ~300-500 KB compressed per 30 s poll -> ~70 KB raw; lighter chart redraw | high
backend-services-26 | Sweep the clientId memory once a minute, not per send | 1 | S | est. 0.1-0.5 ms per send on busy servers | high
backend-services-27 | One SQL upsert per coalesced read state | 1 | S | background CPU on small hosts with large rooms; user effect unknown | low
backend-services-28 | Check the Load bounds in each deployment's Data/appsettings.json | 3 | S | unknown; unbounded history grows start time and every scan | low
backend-services-29 | Emoji pack keywords out of the bootstrap's emoji rules | 2 | M | ~3 KB compressed (~25 ms) on a first load | medium
backend-services-30 | JSON push store writes in the background | 1 | S | a few ms on push toggles; doctrine fix | high
