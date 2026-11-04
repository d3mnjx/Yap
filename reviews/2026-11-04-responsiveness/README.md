# Responsiveness review, 2026-11-04

A file-by-file review of Yap for one question: where does a user wait, and what would make that wait shorter? Six readers covered the backend request path, the backend services, the backend media code, the client core, the client render path and the static shell. They wrote 178 raw findings. After the merge of duplicates, 140 findings remain, in three categories. The ten most promising small changes were built on branches and measured A/B against main on a 50,000-message seed over three simulated links.

## Where things are

| what | where |
| --- | --- |
| The 140 findings, one file each | `findings/`, index in `INDEX.md` |
| The 178 raw findings per reader | `raw/<area>/`, with each reader's own index |
| The ten experiments: measurement write-up, harness report, every sample, probes | `experiments/E01..E10-*/` |
| The experiment branches (one commit each from 7f149be4, not merged, not pushed) | `perf/01-compression-optimal` ... `perf/10-direct-websocket-retry` |
| The measurement harness (branch, not merged) | `perf/harness`, `tests/browser/perf.mjs` |

Categories, as the brief defined them:

1. A clear win with little code and no change in what the user experiences (83 findings; 10 measured).
2. A clear win with more code and no change in what the user experiences (37 findings; estimates only).
3. A change the user would notice (20 findings; listed with pros and cons).

## The conditions

The harness (`tests/browser/perf.mjs`) starts one server per build on a copy of the seed, puts a TCP proxy in front of each, and alternates the runs A, B, B, A so that machine drift hits both sides. The proxy, not a DevTools throttle, carries the service worker and the WebSocket too.

| profile | round trip | bandwidth | stands for |
| --- | --: | --: | --- |
| far | 900 ms | 1 Mbit/s | a phone on a poor mobile link, the worst case the project designs for |
| near | 60 ms | 20 Mbit/s | a home connection in the same region |
| lan | 0 | unlimited | the server's and the browser's own cost |

The seed: 30 people, 10 rooms, 50,029 messages (20,000 in the lobby), three direct-message threads of 2,000, 2,814 reactions, 50 pictures, 20 GIFs, 180 days of timestamps. Five repetitions per side per journey; the tables show medians. The noise of the instrument (A against A): below 0.4% on `far` for values above 1 s, below 1.5% on `near`, 5 to 17% on `lan` and for any value under 100 ms. A delta counts as a gain above 1% on `far`, 3% on `near`, 15% on `lan`.

Baseline on main, for orientation (medians, ms):

| journey | far | near | lan |
| --- | --: | --: | --: |
| first visit, rows on screen | 18,054 | 1,352 | 160 |
| warm open, rows on screen | 3,001 | 285 | 76 |
| resume after a background, rows | 2,979 | 258 | 65 |
| send, own row / confirmed | 1.3 / 918 | 1.2 / 67 | 1.3 / 4.1 |
| room change to the lobby (20,000 rows) | 1,164 | 135 | 43 |
| older page landed | 1,149 | 220 | 219 |
| emoji picker, first open, images complete | 8,648 | 951 | 642 |
| GIF picker, first open, grid | 927 | 71 | 12 |

## Top picks

Nine of the ten experiments are clear wins above the noise, and all ten keep what the user sees unchanged. These are my picks, in the order I would merge them. The order weighs the measured gain, how often a user meets it, and how little code it costs.

1. **E10, the direct socket again after a double failure.** 919 ms off every resume on `far` for a page that lived through a deploy, which is every long-lived tab and every installed phone app. Eleven lines in `hub.js`, and the mechanism proof is exact (one negotiate per resume on main, none on the branch).
2. **E07, the reaction picker built once per page.** The slowest open on main costs a phone about a second; on the branch 50 ms. It repeats on every reaction. Eighteen lines, and the keyboard's second-picker case keeps today's behaviour.
3. **E09, listen sooner after a start.** 1.15 s off the first request after every deploy, for everyone, with a quarter million action-log rows; the gain is the clean-up's time, so it grows with the log. Ten lines, and the clean-up still runs.
4. **E03, preload only the boot graph.** The biggest first-visit gain on `far` (1.07 s) for a six-line filter in `ShellAssets.cs`. Behind HTTP/2 count on about half of it.
5. **E06, register the worker after the first rows.** 0.64 s off the far first visit for four lines. The cost: the worker installs about 3 s later, so a person who leaves within 5 s of the rows has no worker yet.
6. **E01, the Optimal compression level.** Three lines, 9% fewer bytes on every first visit and every shell refetch, 0.3 s on `far`. The CPU cost is 0.5 ms per page response; if it shows in production, C2-07 (compress once per build) is the follow-up.
7. **E02, tus on the first upload.** 0.44 s off the far first visit. With E06 in place, an attach in the first seconds of a first visit on `far` waits 1.2 s for the script; the pending row shows at once, so nothing freezes. Merge it with that trade-off named in the commit.
8. **E04, an ETag for the page and the worker script.** Small and correct: 304s on every revalidation, 0.28 s on a far navigation to the root, 6 KB per warm reload, plus a smaller Brotli page as a side effect.
9. **E05, WebP sprites and a lean sound.** A lossless asset change with no code to maintain; its first-visit gain vanishes once E06 lands, and 63 KB per worker install stays.
10. **E08, one draw of the confirmed own row.** Correct and simpler than before, but no user feels it. Merge it for the simpler path or leave it; expect no number to move.

The first five are the ones I would not leave on the shelf. Together they take about 1.7 s off a far first visit, 0.9 s off every resume after a deploy, a second off every deploy's first request, and most of the reaction picker's cost on phones.

## The ten experiments, ordered by measured gain

Ordered by the largest measured gain on the journey the change targets. "far" is the 900 ms, 1 Mbit/s link; a first visit is a device with nothing cached.

| rank | experiment | journey | main | branch | gain | who feels it | diff |
| --: | --- | --- | --: | --: | --: | --- | --: |
| 1 | E09 listen sooner after a start | first request after a restart (250k log rows) | 3,400 | 2,249 | -1,151 ms | everyone, at every deploy | +10 -4 lines |
| 2 | E03 preload only the boot graph | far first visit, rows | 18,102 | 17,033 | -1,069 ms | new device on a slow link | +6 -1 |
| 3 | E10 direct socket again after a double failure | far resume after an outage | 4,005 | 3,086 | -919 ms, on every resume | every page that lives through a deploy | +11 -3 |
| 4 | E06 worker after the first rows | far first visit, rows | 18,081 | 17,443 | -638 ms | new device on a slow link | +4 -1 |
| 5 | E02 tus on the first upload | far first visit, rows | 18,252 | 17,814 | -438 ms | new device on a slow link | +18 -2 |
| 6 | E07 reaction picker once per page | later picker opens, throttled phone | 423 | 49 | -374 ms per open | anyone who reacts twice, phones most | +16 -2 |
| 7 | E01 Optimal compression level | far first visit, rows | 17,996 | 17,673 | -322 ms, -93 KB | far users, and every shell refetch after a deploy | +3 |
| 8 | E04 ETag for the page and the worker | far navigation to `/`, rows (probe) | 4,183 | 3,907 | -276 ms, -40 KB; a warm reload gains 6 KB only | far users who open the root | +15 -5 |
| 9 | E05 WebP sprites, lean sound | far first visit, rows | 18,111 | 17,923 | -188 ms, -63 KB | far users on a first visit; zero once E06 lands | assets, +5 -4 |
| 10 | E08 one draw of the confirmed own row | send, confirmed | 68 | 68 | none felt (7 ms of main thread on a phone, after the confirmation) | nobody | +8 -4 |

### E03 Preload only the boot graph (C1-03), branch `perf/03-modulepreload-boot-graph`

`ShellAssets.cs` leaves six page and picker modules (admin, settings, settings-debug, channel-settings, gif-library, tooltip) out of the `modulepreload` list: 42 links become 36. The import map and the worker's list keep all 43, so the modules still load when a page needs them.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | first visit, scripts | 13,492 | 12,269 | -1,223 ms (-9.1%) |
| far | first visit, rows | 18,102 | 17,033 | -1,069 ms (-5.9%) |
| far | first visit, page requests | 60 | 54 | -6 |
| near | first visit, rows | 1,539 | 1,389 | -149 ms (-9.7%) |
| lan | first visit, rows | 182 | 182 | 0 |
| all | warm open | | | flat |

Proof: the signed-in shell carries 42 preload links on main and 36 on the branch. The six modules still cross the link once, in the worker's install, after the page. The harness speaks HTTP/1.1 with six connections; behind Caddy on HTTP/2 the round-trip part of the gain shrinks and the byte part (47 KB) stays, so about 0.5 s on `far` is the careful estimate for production. Who feels it: a new device on a slow link, once, and once after each deploy.

### E09 Listen sooner after a start (C1-10), branch `perf/09-startup-listen-sooner`

`Program.cs` constructs the three services that probe for ffmpeg and yt-dlp in parallel, and moves the action-log clean-up from the start path to `ApplicationStarted`, through the writer queue so that it cannot race a trim.

| metric (10 starts per side, 250,702 action-log rows) | main | branch | delta |
| --- | --: | --: | --: |
| spawn to first 200 on `/login` | 3,400 | 2,249 | -1,151 ms (-34%) |
| spawn to first 200 on `/api/bootstrap` | 3,484 | 2,372 | -1,113 ms (-32%) |
| spawn to "Now listening" | 3,280 | 2,122 | -1,158 ms (-35%) |

Every branch start beat every main start. The whole gain is the clean-up's time; the parallel probes give 33 ms, inside the spread. The clean-up still runs: on the branch the row count drops to the same 3,065 within 15 s of the start. The gain grows with the size of the action log; with 8,000 rows it was 139 ms. Who feels it: everyone, at every deploy and restart, on every network.

### E06 Register the worker after the first rows (C1-07), branch `perf/06-worker-after-rows`

`main.js` registers the service worker at once when one already controls the page, and otherwise after the first sync answered (or after 10 s). On a first visit the worker's install, which fetches about 60 files, no longer shares the link with the boot.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | first visit, socket | 16,705 | 16,277 | -428 ms (-2.6%) |
| far | first visit, rows | 18,081 | 17,443 | -638 ms (-3.5%) |
| near | first visit, rows | 1,399 | 1,329 | -70 ms (-5.0%) |
| lan | first visit, rows | 152 | 135 | inside the noise |
| all | warm open | | | flat |

Proof: on main the install starts 3.5 s before the rows and its nine network fetches (117 KB) overlap the hub's socket request; on the branch the worker script is requested 12 to 20 ms after the rows. The install finishes 3.3 s later than on main, so a person who closes the tab within about 5 s of the rows leaves without a worker. Who feels it: a new device on a slow link.

### E02 Load tus on the first upload (C1-02), branch `perf/02-lazy-tus`

`index.html` drops the blocking `tus.min.js` script tag (87 KB raw, 32 KB compressed); `upload.js` loads it on the first upload through a shared promise. The worker's precache list still holds the file.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | first visit, scripts | 13,723 | 12,952 | -772 ms (-5.6%) |
| far | first visit, rows | 18,252 | 17,814 | -438 ms (-2.4%) |
| near | first visit, rows | 1,383 | 1,340 | -43 ms (at the noise edge) |
| far | first upload of a fresh page, attach to first tus request | 10 | 16 | +6 ms |
| far | the same with no cache at all | 8 | 1,180 | +1,172 ms |

Proof: the shell on the branch has two script tags instead of three. The bytes still cross the link once before the rows, fetched by the worker's install instead of the page; the gain is the script's place in the boot order. The cost shows only when nothing holds the file: with E06 the install comes after the rows, so an attach in the first seconds of a first visit on `far` can pay the 1.2 s. Who feels it: a new device on a slow link.

### E01 Compress at the Optimal level (C1-01), branch `perf/01-compression-optimal`

`Program.cs` sets the Brotli and gzip providers to `CompressionLevel.Optimal` (Brotli quality 4, gzip 6) instead of the framework's `Fastest`.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | first visit, html | 1,190 | 1,094 | -96 ms (-8.0%) |
| far | first visit, rows | 17,996 | 17,673 | -322 ms (-1.8%) |
| far | first visit, bytes on the wire | 1,006 KB | 914 KB | -92.6 KB (-9.2%) |
| near | first visit, rows | 1,345 | 1,277 | -68 ms (-5.0%) |
| lan | first visit, html (the CPU cost) | 3.3 | 4.7 | +1.4 ms |
| all | warm open | | | flat |

Proof: `app.css` 10,328 to 8,922 bytes, `signalr.min.js` 18,230 to 14,370, the login page 34,576 to 22,391. The compression runs on every response; nothing caches the compressed bytes, so the CPU cost (about 0.5 ms per page response) scales with traffic. C2-07 (compress once per build) removes that cost and compresses better still. Who feels it: a far user on a first visit, and every device when the worker fetches the shell again after a deploy.

### E04 An ETag for the page and the worker script (C1-04), branch `perf/04-etag-page-worker`

`ShellEndpoints.cs` gives the shell routes and `/service-worker.js` a weak ETag from a SHA-256 of the body, so a revalidation with `If-None-Match` answers 304 with no body.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | warm open (a reload of `/lobby`), rows | 3,008 | 3,007 | flat |
| far | warm open, bytes on the wire | 35.7 KB | 29.4 KB | -6.3 KB |
| far | navigation to `/` with the worker installed, rows (probe, n=3) | 4,183 | 3,907 | -276 ms (-6.6%) |
| far | the same, bytes | 70.6 KB | 30.3 KB | -40 KB |
| far | first visit, html | 1,194 | 1,122 | -72 ms |

Proof: the server log shows 200 on main for every `/` and `/service-worker.js`, and 304 on the branch after the first. The worker serves `/lobby` from its cache, so the harness warm open gains only the update check's bytes. The time gain lands where the worker goes to the network first: `/`, `/login`, `/verify/*`, `/invite/*`. A side effect: the page is written in one piece (`Results.Bytes`) and its Brotli body shrinks by 8.9 KB, which gives the first-visit `html` gain. Who feels it: a far user who opens the root (a typed address, a bookmark, an app installed before sign-in).

### E05 WebP sprites and a lean notification sound (C1-05, C1-06), branch `perf/05-sprites-webp-mp3`

The two emoji-toggle sprites go from PNG to lossless WebP (85.0 KB to 31.5 KB, pixels identical); `notif.mp3` loses its cover art (43.9 KB to 32.4 KB, audio identical).

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | first visit, rows | 18,111 | 17,923 | -188 ms (-1.0%) |
| far | first visit, socket to rows (per run) | 1,377 | 1,168 | -210 ms, no overlap |
| far | first visit, bytes on the wire | 1,006 KB | 943 KB | -63 KB |
| near | first visit | | | inside the noise |
| far, near | emoji picker | | | flat |

Proof: the sprites cross the link once at 14.5 s, before the rows; the sound crosses only in the worker's install. The gain is the rows' answer waiting behind fewer install bytes. With E06 the install moves after the rows, and this gain on the first visit goes to zero; the byte saving at every install stays. Who feels it: a far user on a first visit, before E06.

### E07 Build the reaction picker once per page (C1-08), branch `perf/07-reaction-picker-once`

`js/ui/emoji-picker.js` builds the reaction picker (about 1,000 cells) on the first open and moves it into the wrapper of each later open. The composer's own picker already lived once per page. Measured with a new harness journey (`picker-reaction`, five opens on five rows of one page; `phone-picker-reaction` the same with a 4x CPU throttle).

| device | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| desktop | open 1, click to grid | 28.4 | 32.0 | inside the noise |
| desktop | later opens, click to grid | 49.6 | 7.5 | -42 ms (-85%) |
| desktop | long tasks over five opens | 187 ms (2) | 63 ms (1) | -66% |
| phone, 4x throttle | open 1, click to grid | 138 | 136 | inside the noise |
| phone, 4x throttle | later opens, click to grid | 423 | 48.5 | -374 ms (-89%) |
| phone, 4x throttle | open 2 (the slowest on main) | 894 to 1,091 | 48 to 56 | about -1 s |
| phone, 4x throttle | long tasks over five opens | 3,046 ms (12) | 812 ms (7) | -73% |

Proof: every main page built 5,040 cell buttons over five opens; every branch page built 1,008. The ranges of the later opens never touch (main's fastest 46 ms against the branch's slowest 9 ms on desktop; 304 against 66 on the phone). The network plays no part: `near` and `lan` agree, and blocking the CDN makes main slower still. Who feels it: anyone who reacts more than once per page, phones most.

### E08 Confirm the own row without a second draw (C1-09), branch `perf/08-send-confirm-path`

`store.js` `addMessage` returns without work when the confirmed message is already known and equal; `sender.js` adds the message, publishes once, and removes the outbox row afterwards. Before, every send ended with one `replaceMessage`, which drew the own row a second time.

| condition | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| near, desktop (100 sends per side) | Enter to confirmed | 68.4 | 67.9 | inside the noise |
| lan, desktop (100 sends per side) | Enter to confirmed | 5.3 | 4.9 | inside the noise (z = 1.75) |
| phone, 4x CPU throttle (30 sends per side) | Enter to confirmed | 52.4 | 54.4 | inside the noise |
| phone, 4x CPU throttle | main thread busy per send | 187 | 197 | inside the noise |

Proof: on main the confirmed row's node is replaced by a second copy in 30 of 30 sends and the store fires a `replace` per send; on the branch 0 of 30 and none. One such replace costs 6.8 ms of main thread on the throttled phone. That work ran about 20 ms after the confirmation, so it never delayed what the person waits for, and it is small next to the 150 to 350 ms of other main-thread work per send. Verdict: correct, cheap, and not felt. The test messages carried no emoji, so the saved emoji image requests on WebKit are not measured.

### E10 Try the direct WebSocket again after a double failure (C1-11), branch `perf/10-direct-websocket-retry`

`js/hub.js` `connect()` tries a direct WebSocket, then a negotiated connection when the direct one fails. On main a double failure (the server is down for a deploy) left the negotiate flag on for the life of the page, so every later connect sent `POST /hub/negotiate` before the socket. On the branch a double failure resets the flag. Measured with a standalone probe: a page in a quiet room lives through a server restart, reconnects, then resumes twice from a 35 s pause.

| profile | metric | main | branch | delta |
| --- | --- | --: | --: | --: |
| far | resume after an outage, thaw to rows (n=10) | 4,005 | 3,086 | -919 ms (-23%) |
| far | control resume, no outage (n=4) | 3,085 | 3,080 | flat |
| far | reconnect attempt to connected, after the outage | 2,797 | 1,892 | -905 ms |
| near | resume after an outage, thaw to rows (n=10) | 358 | 303 | -55 ms (-15%) |
| near | control resume, no outage (n=4) | 273 | 271 | flat |

Proof: after the outage every resume on main sent one `POST /hub/negotiate` (20 of 20) and the branch none (0 of 20); the controls sent none on both sides. The ranges never touch (main 3,999 to 4,025 against the branch 3,077 to 3,098 on `far`). While the server is down the branch makes two refused attempts per retry tick where main makes one, which cost nothing measurable. Who feels it: every user whose page lives through a deploy, on each later resume and reconnect; the installed phone app most, because it resumes many times a day.

### Reading the ten together

- E01, E02, E03, E05 and E06 all act on the far first visit, and their gains overlap. E06 moves the install after the rows, which removes the install bytes that E05 and part of E02 and E03 save from the boot. The sum is not 2.7 s. Merge them and measure the combination once with the harness before you quote a number.
- E02 and E06 together open the one visible cost: an attach in the first seconds of a first visit on a slow link waits for the tus script (1.2 s on `far`). The outbox row shows at once, so the person sees a pending row, not a frozen tap.
- The harness speaks HTTP/1.1 without TLS to Kestrel. Behind Caddy on HTTP/2 a request count matters less and bytes matter the same. Cloudflare may recompress, which can change E01's bytes at the browser.
- The server timings come from a Debug build. Production with ReadyToRun (C1-27) would move E09's absolute numbers, not the clean-up's share.

## Category 1: the 73 small changes not measured

All 83 are in `INDEX.md` with effort, confidence and the readers' estimates. The ten above were chosen for the size of the expected gain under the harness. These ten are the next to measure, by expected gain for the far user or the big server:

| id | change | expected gain (reader's estimate) |
| --- | --- | --- |
| C1-58 | Open the socket while the bootstrap is fetched after a sign-in | one round trip on the way from the sign-in tap to the first rows |
| C1-73, C1-74 | Put the upload result in the last tus response; send the first chunk with the create request | one round trip each per media message for the sender |
| C1-30 | Start the trending request with the library requests when the GIF picker opens | one round trip before the trending grid |
| C1-52 | Run the boot's three IndexedDB reads and the chat module's evaluation side by side | one to two IndexedDB latencies before the stored rows paint |
| C1-12 | Cache the quick reactions per person instead of scanning every message on every bootstrap | a scan of all messages per connect, grows with the history |
| C1-44, C1-46 | Leave kept rows in place at a reset; strip the whitespace nodes from the row template | main-thread work at every open and reconnect, phones most |
| C1-40, C1-39 | Refill the quick reaction buttons and redraw only the changed person's rows | a full redraw of every loaded row on a quick-reaction or profile change |
| C1-36 | Sort the people list with one shared collator | 72.6 ms to 0.9 ms for 2,000 names (measured by the reader) |
| C1-31 | Do not reload the GIF picker while it is closed | four requests and a full redraw on every reconnect after the first open |
| C1-42 | Relabel row times only when the day changes | a walk and format of every loaded row every minute |

The readers rate C1-14, C1-18, C1-22, C1-23, C1-28 and C1-71 high in confidence as well; they are scale items (many sessions, many favourites) or byte trims that a small server does not feel.

## Category 2: more code, no change for the user

For each finding: the reader's estimate, and the pros and cons as I weigh them against the project's principles (simplicity, maintainability, understandability). "Take" is my recommendation. Overlaps between findings are noted, because several target the same wait and only one of them should be built.

### The connect path

**C2-01 Send the open conversation with the connect, not after it.** M, medium. Estimate: one round trip (900 ms far) less before the server's rows on every connect, reconnect and resume. Pros: it removes the last avoidable round trip from the resume floor ("upgrade, handshake, openRoom"); it reuses Switch, Open and the generation check. Cons: two paths deliver the same answer (`opened` and the openRoom reply), and the connected hook must choose; the connection must be rebuilt when the target changes before a connect; the order of the handshake answer and OnConnectedAsync needs a test. Take: the biggest single resume gain on the list; build it alone first, measure with the harness's resume journey, and only then consider C2-05 on top.

**C2-04 Let openRoom answer "unchanged" when the client's tail is current.** M, medium. Estimate: 15 to 40 KB and 120 to 320 ms per quiet open on `far`, plus the parse and the 50-row compare on a phone. Pros: it works in memory and in both persistence modes; it reuses the stamp idea of `emojiStamp`. Cons: every path that changes a row (send, edit, delete, reaction, card, pin) must bump the counter, or a stale row stays, which is the kind of invariant that breaks silently; the version must include the person's history limits; a restart must never match an old version. Take: measure after C2-01 and C2-02; the counter's correctness burden is real and the gain shrinks when frames are compressed.

**C2-05 Send the connect bootstrap over the hub instead of a separate HTTP request.** L, low. Estimate: one HTTP request per connect; after a long background up to 1.8 s on `far` if the socket does not share the HTTP/2 connection. Pros: the sidebar is current sooner after a sleep. Cons: the endpoint's side jobs (cookie year, known networks, origin) cannot ride a WebSocket and must move; a large bootstrap sits in the socket queue ahead of nothing unless C2-01 lands first; the gain rests on an unknown about connection reuse. Take: skip until someone measures whether the bootstrap request opens a new connection in production (a browser trace behind Caddy answers it in an hour).

**C2-06 Leave the unchanged users directory, texts and themes out of the reconnect bootstrap.** M, medium. Estimate: 30 to 40 KB compressed per reconnect at 1,000 accounts, 250 to 320 ms on `far`. Pros: it copies the `emojiStamp` pattern exactly; the phone skips a users rebuild and six listeners when nothing changed. Cons: every directory change path must bump the stamp; small servers gain little for two more stamps and their null branches. Take: for the 1,000-account instance only; a 30-person server does not feel it.

**C2-19 Move the image-emoji search keywords out of the bootstrap.** M, medium. Estimate: 3 KB compressed off a first load, 25 ms on `far`. Pros: it follows the `emoji-list.js` pattern (picker data with the picker). Cons: a new endpoint and a second data path for 25 ms; offline search needs the worker to cache the keywords. Take: skip.

**C2-30 SignalR stateful reconnect for short drops.** L, low. Estimate: one round trip plus the tail and bootstrap bytes per drop shorter than the server window; frequency unknown. Pros: missed messages replay, so a blip needs no openRoom and no bootstrap. Cons: it adds machinery against the offline doctrine; OnConnected and OnDisconnected semantics change under the presence grace periods; each connection holds a server buffer; it may not fit the custom retry loop. Take: skip unless the telemetry shows short drops are common. C3-13 (a longer timeout) is the three-line alternative.

**C2-31 Send messages over the warm hub socket instead of an HTTP POST.** M, low. Estimate: zero on a warm HTTP/2 connection; 1.8 s on `far` per send after an idle close, frequency unknown. Pros: the heartbeat keeps the socket warm. Cons: two paths into one service must agree on validation, rate limits and the refusal mapping; it reverses the written rule "sending is HTTP, for the offline outbox". Take: skip; measure first whether a send after minutes of reading opens a new connection (the same unknown as C2-05).

### Hub payloads

**C2-02 Compress the hub's WebSocket frames (permessage-deflate).** M, medium. Estimate: a 50-row tail 19.6 KB to 4.5 KB, 120 ms per open on `far`; every older page and live event shrinks the same way. Pros: one small middleware at the edge of the pipeline, no change to the protocol or the client; it makes most of C2-03's trims unnecessary. Cons: it wraps a framework switch named `Dangerous`, so the comment must carry the reason; compression mixes other people's text with any secret in one stream (the CRIME class), so the payload list needs a check; each connection keeps a deflate window (tens of MB at 1,500 connections); Caddy and Cloudflare support needs a check. Take: the best byte-per-line change on the list for the far user; verify the proxies pass the extension, then measure room change and older with the harness.

**C2-03 Trim the message row shape.** M, medium. Estimate: 50 rows 19.6 KB to 11.1 KB raw, 70 ms per open on `far`; about 0.3 KB once C2-02 compresses. Pros: step 1 (omit nulls) is a per-type attribute the client already tolerates, and it is C1-72. Cons: the row shape gets rules split between client and server (URLs built on the client, channelId only in live events); timestamps must keep one fixed fraction length because the client compares them as strings; every stored row differs once after the deploy. Take: do step 1 as C1-72; skip the rest if C2-02 lands.

**C2-20 Let the client ask for larger older pages.** S, medium. Estimate: scrolling back 300 messages takes 2 to 3 round trips instead of 6 on `far`. Pros: the parameter is optional, old clients keep 50; the server's older read is in memory. Cons: a larger page is a longer render on a phone; the client needs a rule for when to ask for more. Take: small and worth a measurement with the `older` journey; pair it with C2-23 or choose one.

**C2-23 Fetch the next older page as soon as the previous one lands.** M, medium. Estimate: one round trip (900 ms far) per page for a fast reader; one unused page for a reader who stops. Pros: the still-view rule stays; a reader who never scrolls pays nothing. Cons: the prefetched page lives outside the store, one more piece of state in timeline.js; the token guards must cover it. Take: measure against C2-20 and keep the one that reads better; C2-20 is less code.

**C2-24 Load the rows up to a jumped-to message in one call.** M, medium. Estimate: a jump five pages back 4.75 s to 0.9 s on `far`. Pros: option 2 (drop the 50 ms sleep between pages) is tiny; the pin knows the target timestamp. Cons: option 1 changes the hub API and needs a server cap; a big prepend is one long task on a phone. Take: do option 2 now; option 1 only if pins see use.

### Boot assets

**C2-07 Compress the shell files once per build at the highest level.** M, medium. Estimate: 48 KB with gzip 9 against gzip 1 (0.4 s on `far`); Brotli at top quality is smaller still; CPU per response goes to zero. Pros: it removes the per-response cost that E01 adds and compresses better than E01. Cons: a new middleware and a cache that repeat part of static files and response compression; Range and HEAD requests must fall through; Accept-Encoding handling becomes the app's own code. Take: E01 gives most of the bytes in two lines; build this only if the CPU of compression shows in production after E01.

**C2-08 Take the Settings, channel, admin and GIF-library rules out of the render-blocking CSS.** M, medium. Estimate: 18.5 KB of 78.8 KB leaves the blocking set, 150 ms on `far`. Pros: the sign-in pages keep their blocking styles; the split moves rules without edits. Cons: an inline onload switch, which a Content-Security-Policy would break; a Settings open in the first seconds of a first visit can show unstyled; unprefixed classes need a grep first. Take: a fair gain for a readable split; do it with C2-09 or not at all.

**C2-09 Move the Settings, channel, admin and GIF-library templates out of the page.** M, medium. Estimate: the page 26.3 KB to 16.6 KB compressed, 80 ms on `far`; 40% fewer inert nodes parsed at every boot. Pros: `clone()` stays synchronous; only four page mounts change. Cons: templates live in two files; a page that clones before the load throws; a cold first Settings open waits one fetch. Take: with C2-08 as one "pages off the boot path" change; measure the pair.

**C2-10 Serve the nine stylesheets as one file, joined at startup.** M, medium. Estimate: nine requests become one; 900 ms on HTTP/1.1 first visits, small on HTTP/2. Pros: it follows ShellAssets' startup work; no build tool. Cons: DevTools shows one file; Development must rebuild per request; the gain is an HTTP/1.1 gain, and production is HTTP/2. Take: skip; production does not pay the request count.

**C2-11 Import the pickers, the viewer, the pins panel, the recorder and the install dialog on first use.** M, low. Estimate: 22.5 KB compressed off the start, 180 ms on a first visit; parse saving unknown. Pros: it follows a pattern the code has (the emoji data module loads on first open). Cons: every handler becomes async with a catch and a visible error; the first tap of each feature waits for a parse; offline it depends on the worker cache. Take: skip; E03 took the preloads out already, and the handlers' readability is worth more than 180 ms once per device.

**C2-12 Keep the previous build's shell cache so an open page's late imports stay cache hits.** M, medium. Estimate: after a deploy, an old page's late imports stay local instead of 0.9 s plus transfer. Pros: it keeps the PK-11 assumption true across a deploy; the change stays inside the worker; it closes the mixed-build hole. Cons: storage holds one more shell build (0.5 to 1 MB); one more cleanup rule. Take: do it; it is a correctness guard as much as a speed item.

### Server work at scale

**C2-13 Keep a per-person session count in PresenceService.** M, medium. Estimate: at 1,500 sessions the admin Users and Diagnostics tabs each hold the presence lock 50 to 200 ms; small servers gain little. Pros: 30 to 40 lines, two mutation sites, both covered by existing tests. Cons: a second structure must stay in step with `_sessions`, or a person looks offline or stuck online. Take: for the 1,000-account instance, with a guard comment at both mutation sites.

**C2-14 Index read states by person.** M, medium. Estimate: 1 to 2 ms per bootstrap and per push recipient at 60,000 entries; nothing at 30 people. Pros: as the only store it adds no second structure. Cons: as a second index it must stay in step at five sites; as the only store it touches every use. Take: skip until a bootstrap trace at scale shows the scan.

**C2-17 Admin Users tab: SQL finds the last action and the recent addresses, reads in parallel, stop logging every API request.** M, medium. Estimate: unknown, grows with uptime; two full action-log reads run in series today. Pros: two indexed queries side by side instead of two table scans. Cons: a window query in raw SQL is harder to read and to keep in step with the model; dropping HTTP_REQUEST rows changes the Logs tab, which is the user's decision. Take: do the parallel read and the indexed last-action query; leave the logging decision to the user.

**C2-18 Load messages and reactions with two queries, and log each startup step.** M, low. Estimate: 0.2 to 1 s of the start for 50,000 messages; the step log gives the real numbers. Pros: EF stays in Loads.cs; the log answers a question nobody can estimate today. Cons: the in-memory join must keep reaction order; bounded and unbounded loads may take two paths; persistence on only. Take: do the step log now (ten lines); decide the query change from its numbers. E09 already took the clean-up out of the same window.

### Link cards

**C2-15 Persist scraped link cards across restarts.** M, medium. Estimate: after each deploy, link rows keep their cards instead of a re-scrape per link (seconds each) and two redraws per row. Pros: option A (a JSON sidecar per URL hash) works with persistence off and keeps memory as the truth; it removes a burst of outbound scrapes in the reconnect storm. Cons: disk grows by one file per URL ever scraped and needs a cleanup rule; the load must run in the background or it adds start time. Take: option A, after C3-01; measure the start-time cost with the E09 script.

**C2-16 Cache the card picture on this server.** M, medium. Estimate: a card picture from a new host costs about three round trips (2.7 s far) before its first byte. Pros: the row gets its box size, so it does not grow when the picture lands; it reuses the SSRF-guarded fetch client and the media-cache rules; readers stop loading a remote image (a privacy gain). Cons: disk and CPU for re-encodes need a cap; some hosts block hotlinks, so the remote URL stays as a second path; caching third-party pictures is a product question. Take: pair with C2-15; the privacy gain argues for it as much as the speed.

### Render

**C2-21 Update only the reaction pills of a row when its reactions change.** M, high. Estimate: a reaction tap rebuilds the row twice today, others' reactions once; after, only the pills change, and no emoji image is requested again. Pros: it follows the redraw cuts of 2026-10-31 and `redrawStars`; the same split fits link cards. Cons: the replace handler gets a second branch; `updateReactions` must create the pills container when the template removed it. Note: the row stops flashing on a reaction, which a person can see; it sits here because the content and order do not change. Take: do it; the iPhone pays an image request per emoji on every rebuild.

**C2-22 Load and play a row's GIF video only near the view.** M, medium. Estimate: unknown; every GIF video in loaded rows downloads in full at draw, one second each on `far`. Pros: video GIFs then match image GIFs, which already lazy-load; phones decode fewer videos. Cons: a module-level observer needs lifecycle care; the autoplay-blocked resume path must play only videos with a `src`. Take: do it; a history with ten GIFs costs the far reader ten seconds of link today.

**C2-25 Handle the row buttons with one delegated listener on the list.** M, low. Estimate: 200 to 500 listeners per 50-row draw become one; a few ms per draw on a phone, unknown. Pros: the wiring becomes visible in one place through `data-action`. Cons: the `stopPropagation` order in pills and stars must survive; pending rows and the pins panel share the functions with their own nodes. Take: skip unless a phone trace shows listener registration in a draw.

**C2-26 Update the room rows' badges in place instead of rebuilding the room list on every unread change.** M, medium. Estimate: every unread change rebuilds all room rows and their inline emoji names; frequent on busy servers. Pros: WebKit stops one image request per emoji in a room name on each unread change; it follows "redraw only what changed". Cons: two render paths for one list must agree on what each event changes. Take: do it on a busy server; the two-path cost is small when `buildRooms` and `markRooms` are ten lines each.

**C2-27 Build the hover bar's buttons when the bar first shows.** M, medium. Estimate: the bar is 12 to 15 of a row's 17 to 26 elements per draw; a few ms. Pros: it extends `fillQuick`, which the iPhone work proved. Cons: keyboard users lose the focus path into the bar unless rows get `tabindex`, a design decision; a row's markup then lives in two templates. Take: skip; the keyboard question costs more than the few ms.

**C2-28 Cap the rows kept in the DOM.** L, low. Estimate: unknown; a reader 20 pages back holds 1,000 rows that every resize or theme change re-lays out. Pros: re-layout cost stops growing with the session. Cons: option 1 needs a `newer` path that does not exist and breaks find-in-page; scroll anchoring has a CLS history; effort L on a guess. Take: skip; measure a long session on a phone first.

**C2-29 Keep the timeline and composer across room switches.** M, low. Estimate: unknown; each switch rebuilds both components and sends a redundant `leave`. Pros: the server's Switch already leaves the old group, so the dropped `leave` is free. Cons: the composer must reset draft, reply, attachments and recorder per target, which a fresh mount gives for free; the router gets a third hook. Take: drop the redundant `leave` (one line); keep the rebuild, which is the simpler design. The harness measures a room change at 135 ms on `near`, so the rebuild is not the wait.

**C2-37 Measure the scroll cost of the masked pattern layer in the pattern themes.** S, low. A measurement only. Take: one phone trace of a fling in a Terminal room; the fix, if any, is a design decision.

### Media, GIFs and uploads

**C2-32 Add a 400 px picture size for gallery cells.** M, medium. Estimate: a four-picture message 400 KB to 100 to 130 KB, 2 s for the far reader. Pros: the send path does not wait (background task); the fallback covers old uploads. Cons: a third file per picture in the media cache and on disk; DPR-3 phones get 2x. Take: measure the share of multi-picture messages first; C3-04 (lossy thumbnails) cuts the same bytes for every picture with two lines, if the user accepts the quality change.

**C2-33 Remux H.264 .mov uploads at once.** M, medium. Estimate: an H.264 .mov plays within the upload instead of after a minutes-long encode. Pros: 25 lines; it reuses the probe the GIF check already runs. Cons: non-AAC audio does not stream-copy and needs a fallback; the finding caps the copy at 8 MB but sizes the gain at 100 MB, so the scope needs a decision. Take: do it with a size cap the user picks; the 404 window for bigger files stays a separate question.

**C2-34 A newly sent provider GIF is downloaded twice by every reader.** M, medium. Estimate: one full GIF download per reader per new provider GIF. Pros: option 1 (await the download up to 2 s before the broadcast) touches no database. Cons: option 1 delays the confirmation by up to 2 s; option 2 keeps a Klipy URL in the message for good. Take: option 1 with a short wait; measure the typical download time first.

**C2-35 Send provider GIFs to the picker as a lean card.** M, medium. Estimate: 50 KB raw per 30-item page against 8 KB. Pros: the server already reads only the source id. Cons: 40 lines in four files plus a dual read until old outbox rows drain. Take: measure a real answer first; if a page is 50 KB raw and 8 KB compressed, skip.

**C2-36 Keep the GIF grid when its data did not change.** M, medium. Estimate: unknown; a reopen and a star elsewhere each rebuild 30 video cards twice. Pros: cards stop flashing and tile samples stop changing; 30 to 40 lines in one file. Cons: an identity check that misses a change leaves a stale view. Take: do it after C1-31 (no reload while closed), which removes most rebuilds with less code.

## Category 3: changes the user would notice

Each needs the user's word on the visible change. Pros and cons are short; the finding files hold the detail.

| id | change | the user would notice | pros | cons | take |
| --- | --- | --- | --- | --- | --- |
| C3-01 | Keep link cards longer than one hour and serve a stale card while it is fetched again | an old card shows its last content instead of vanishing for a moment | 15 lines, memory only, both persistence modes; rows stop redrawing twice | a changed page shows old text until the refetch; the cache needs a size cap | do; the current behaviour is a flicker nobody asked for |
| C3-02 | Answer the root from the stored shell on a signed-in device | a tab at `/` paints at once; after a deploy it shows the refresh strip instead of the new build | the root behaves like every other route (3 round trips, 2.9 s far) | changes the written rule that `/` is network-first; the worker reads IndexedDB on navigation | user decides; E04 cut the same cost on the server side with no rule change |
| C3-03 | stale-while-revalidate on the profile picture header | avatars show at once; a changed picture can show one view late | one header line; the stable URL and short max-age stay | WebKit support unknown, so the iPhone may gain nothing | do; the `?v=` on a changed picture makes the staleness rare |
| C3-04 | Lossy WebP thumbnails for PNG uploads | screenshots become lossy; fine text can show artefacts at high zoom | one or two lines; 600 to 800 KB rows become 60 to 150 KB (4 to 6 s on far) | avatars change too; the user must compare real screenshots | user decides, with a side-by-side of three real screenshots |
| C3-05 | Downscale photos on the device before the upload | the stored original is 2,048 px; Download gives that, not the camera file | 24 to 28 s less upload per photo on far; smaller server decode; place data leaves the file | TL-24 (Download gives the original) changes; a few hundred ms of canvas work on an old phone | user decides; a "send original" toggle keeps both |
| C3-06 | A lower limit for turning silent videos into animated WebP | a silent clip between the new limit and 30 s stays a video with a play button | one line; long screen recordings stop paying a 450-frame encode in the request | silent clips meant as GIFs become videos | user picks the limit; measure real clips first |
| C3-07 | Keep the first page of Klipy trending in memory for a few minutes | the trending grid can be minutes old | 10 lines; the send check keeps working | a rating change must clear it; Klipy's terms may limit caching | do, after a look at the terms |
| C3-08 | Do not let a slow Klipy hold back library hits for 15 s | when Klipy is slow, the search shows library hits after 4 s without the Klipy section | 4 lines; the existing catch handles the timeout | a Klipy that answers in 5 s never shows | do; pick the limit from the logged durations |
| C3-09 | Measure Klipy's MP4 against the animated WebP the rows load; consider MP4 for rows | provider GIF rows play as muted looping video; iOS Low Power Mode may need a tap | step 1 is a one-day size log with no visible change | step 2 reverses a deliberate `<img>` choice; many videos cost decoders | do step 1; step 2 is the user's call on the numbers |
| C3-10 | Re-encode large .gif uploads with ffmpeg's libwebp | a large uploaded GIF shows as animated WebP at 480 px, 15 fps | 15 lines; native libwebp already ships | the encode sits on the upload path unless C1-82 lands first; pixel-art GIFs may suffer | user decides; the memory note says to confirm first |
| C3-11 | Admin Diagnostics: bucket the 7-day series on the server | the charts draw 500 averaged points per line instead of 20,160 | 2.5 to 3 MB raw per 30 s poll becomes 70 KB; the bucket code exists | averaging hides a single spike unless the bucket carries a max | do, with a max per bucket |
| C3-12 | Check that each deployment's Data/appsettings.json carries the Load bounds | messages past the bounds are no longer readable | no code; start time, memory and every scan shrink ten-fold on a 50,000-message room | a product decision per instance; someone edits each Data file | user decides per instance; add the start-up warning (one line) |
| C3-13 | A longer SignalR client timeout, so a tab hidden a few minutes keeps its socket | a tab hidden 30 s to 2 min shows current rows at once; a vanished device stays "connected" up to 2 min | three settings, no machinery; skips 2.7 s of reconnect where the socket survives | on iOS a dead socket waits for a failed call first; presence shows lost devices longer | measure which devices keep the socket before deciding |
| C3-14 | Keep only the most recent join and leave lines in the lobby | old join and leave lines disappear while the lobby stays open | two lines; the list stops growing with churn | MR-73 must allow a cap; a reader scrolled up can see a jump | user decides; cap only lines above the view |
| C3-15 | Show the row's medium picture in the viewer at once, then swap to the large one | the viewer opens at once and sharpens when the large file lands | follows the latency doctrine; reuses the gallery's observer | the picture changes resolution once in front of the person | do |
| C3-16 | Stop refetching the device list on every presence change while Settings is open | Active Sessions updates on the person's own change or page return | a few lines; the far user's profile saves stop sharing the link with a poll | a second device that connects shows at the next visibility change | do |
| C3-17 | Do not download the 388 KB italic font for the grey system lines | system lines show upright or as a synthetic oblique | one rule or one `@font-face`; 3.1 s of link on a far first visit with a system line | the look changes; a synthetic oblique is not Inter Italic | user decides; the harness showed this font swinging a first visit by 380 KB |
| C3-18 | Collapse the send and GIF buttons without animating width and margin | the draft field takes its new width at once; the buttons still scale | a few deleted words move the motion to the compositor | a slide becomes a jump; unmeasured | measure on a slow phone first |
| C3-19 | Measure the blur over the animated GIF tiles; show a still if costly | with the still variant, folder tiles stop animating under the blur | the measurement is a DevTools toggle | the animated tile is the user's design choice | measure first; the drop-blur variant keeps the animation |
| C3-20 | Encode the Tea House strip tiles at WebP quality 85 | the sky and garden strips get slightly lower quality | two numbers in a build script; 40 to 55 KB less per scene | flat gradients can show artefacts; Tea House users only | user looks at the preview and decides |

## The harness

`tests/browser/perf.mjs` on branch `perf/harness` (commit 345de009: cb074cfa is the harness, 345de009 adds the two reaction-picker journeys of E07). The worktree `/home/agent/yap-perf/harness` holds a built copy; the seed is at `/home/agent/yap-perf/seed`. To compare two builds:

```
cd /home/agent/yap-perf/<experiment>/Yap && dotnet build
cp -r tests/browser/node_modules <harness worktree>/tests/browser/node_modules
cd <harness worktree>/tests/browser
node perf.mjs --seed                                   # once; 83 s; writes ~/yap-perf/seed
node perf.mjs --a=<worktree>:main --b=<worktree>:<label> [--n=5] [--profiles=far,near,lan] [--journeys=...] [--full]
```

Each proxy listens 100 above its server port, so two runs on one machine need distinct `--port-a`/`--port-b`. Output: `report.md`, `runs.json`, `browser-log.txt`, a screenshot per failed run. The default plan takes about 20 minutes for one A/B at n=5; `--full` 28 minutes.

What the harness cannot see, and what it found on the way:

- The link has no jitter or loss, and the server speaks HTTP/1.1 without TLS. Server timings come from a Debug build. The phone is desktop Chromium with a 4x CPU throttle, not WebKit.
- `Page.setWebLifecycleState frozen` does not stop timers in this Chromium. `tests/browser/load.mjs` rests on it for its resume, so its resume numbers of 2026-10-22 measure a page that never lost its socket. The harness pauses the page in the debugger instead. load.mjs is unchanged and needs the same fix.
- A closing proxy connection kept its queued bytes on the link, so the next page on that link started 2.1 s late. Fixed in `proxy.mjs`.
- Presence changed what loaded: a person who went offline between runs got their own join line in the lobby, in italics, and the italic font (380 KB) loaded before the rows. The harness keeps one idle Settings page per server. The effect itself is C3-17.

## Merge notes

- Each experiment branch is one commit on 7f149be4. Main has moved on (ffd8e485 touched `text.js`, `pickers.css`, `features.mjs`); cherry-pick each commit and run the suites it names.
- Stale text to fix on merge: `index.html` lines 113 to 116 and `docs/performance-notes.md` line 99 describe the full preload list (E03); `docs/performance-notes.md` line 105 describes the worker's registration at script start (E06); `docs/architecture/client.md` line 338 says the page keeps negotiation for its life (E10).
- After the merge of the first-visit set (E01, E02, E03, E05, E06), run the harness once on `far` and `near` for the combined number, and run E02's upload probe with the worker's install after the rows.
- The results folders under `/home/agent/yap-perf/` are sandbox-local; the copies in `experiments/` are the record.
