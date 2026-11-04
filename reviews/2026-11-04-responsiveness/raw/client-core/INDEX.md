# client-core: findings index

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
client-core-01 | Try the direct WebSocket again after a connect where both attempts failed | 1 | S | 1 RTT (~900 ms far) on every later connect of a page that once failed (every deploy restart) | high
client-core-02 | Let the server send the open conversation's tail at connect, without the openRoom round trip | 2 | M | 1 RTT (~900 ms far) off the rows phase of every connect | medium
client-core-03 | Let openRoom answer "unchanged" when the client's tail is current | 2 | M | tail bytes per quiet open/resume (est. 15-40 KB JSON, 120-320 ms at 1 Mbit/s) | medium
client-core-04 | Send the connect bootstrap over the hub instead of a separate HTTP request | 2 | L | one request less per connect; avoids TCP+TLS of a cold HTTP connection after sleep (~2 RTT for sidebar freshness) | low
client-core-05 | Leave the unchanged users directory, texts and themes out of the reconnect bootstrap | 2 | M | est. 30-40 KB compressed per reconnect at 1,000 accounts (250-320 ms at 1 Mbit/s) + parse | medium
client-core-06 | Treat an unanswered heartbeat as a dead socket, and bound a hanging connect | 1 | S | dead socket replaced after ~10-15 s instead of up to 30 s; hung connects bounded | medium
client-core-07 | Run the boot's three IndexedDB reads and the chat module's evaluation side by side | 1 | S | 1-2 IDB transaction latencies before the stored paint (unknown, ms to tens of ms) | medium
client-core-08 | Start the hub connect before the stored bootstrap is read | 1 | S | socket and rows earlier by the IDB open + read time (unknown) | low
client-core-09 | Show the confirmed own row before the outbox row is deleted from IndexedDB | 1 | S | one IDB commit off each send confirmation and between queued posts | high
client-core-10 | Do not redraw the own row when its second confirmation carries the same message | 1 | S | one row rebuild (and its emoji img requests on WebKit) per own send | high
client-core-11 | Send messages over the warm hub socket instead of an HTTP POST | 2 | M | 0 when HTTP is warm; up to ~2 RTT (1.8 s far) after an idle-closed connection; frequency unknown | low
client-core-12 | Send the file's bytes with the tus creation request | 1 | S | 1 RTT (~900 ms far) per upload message; needs server support check | medium
client-core-13 | Return the processed file's info in the final tus answer and drop the info poll | 2 | M | 1 RTT (~900 ms far) per upload message, more when a poll misses | medium
client-core-14 | Stop tus from writing an upload fingerprint to localStorage for every file | 1 | S | one sync localStorage write per file; stops unbounded growth read before first paint | high
client-core-15 | Load the tus library on the first upload instead of as a blocking script at every start | 1 | S | 87 KB script off every start's main thread; 22 KB gzip off the cold load | medium
client-core-16 | Preload only the modules of the boot graph, not the Settings, Admin and Channel pages | 1 | S | 149 KB raw / ~47 KB gzip off the cold load (~375 ms at 1 Mbit/s, with -17) | medium
client-core-17 | On a first visit, register the service worker after the first rows instead of at script start | 1 | S | ~100 KB of precache off the first visit's critical path (~0.8 s at 1 Mbit/s) | medium
client-core-18 | Give the page and the worker script an ETag so their revalidation is a 304 | 1 | S | ~22 KB gzip (~175 ms far) per server-first navigation; smaller worker update checks | high
client-core-19 | Answer the root from the stored shell on a signed-in device | 3 | M | paint at / without ~3 RTT + 22 KB (~2.9 s far) for browser-tab users | medium
client-core-20 | Write the stored bootstrap and tail less often, and only when they changed | 1 | S | fewer whole-document structured clones on the main thread (every few s on busy servers, 2 per connect) | medium
client-core-21 | Ask IndexedDB for relaxed durability on writes and resolve reads at the request's success | 1 | S | unknown; drops disk-flush waits where the default is strict, one event per read | low
client-core-22 | Notify only the parts of a bootstrap that changed | 1 | S | unknown; avoids 4x renderRooms and other redraws right after the rows land | low
client-core-23 | After a sign-in, open the socket while the bootstrap is fetched | 1 | S | 1 RTT (~900 ms far) from sign-in to rows | medium
client-core-24 | Run the IPv4 beacon once per page load, not after every connect | 2 | S | one hub RTT + one cross-host TLS set-up off each reconnect (off the critical path) | medium
client-core-25 | Stop refetching the device list on every presence change while Settings is open | 3 | S | one GET per presence pause while Settings is open on busy servers | high
client-core-26 | Fetch the push device list in parallel with the service worker lookup on Settings | 1 | S | one local wait (up to 3 s when SW ready hangs on iOS) off the Notifications card | high
client-core-27 | Admin Users tab - open a row's detail without rebuilding the whole table | 1 | S | O(accounts) DOM rebuild per row tap removed (unknown ms) | high
client-core-28 | Admin page - drop the duplicate settings and status fetches, and pause the 2 s load poll while hidden | 1 | S | 2 requests per Settings tab open; no polling from a hidden tab | high
client-core-29 | Import the pickers, the viewer, the pins panel, the recorder and the install dialog on first use | 2 | M | 60 KB raw / ~22.5 KB gzip off start (parse ms on phones, unknown) | low
client-core-30 | Move the Settings, Channel and Admin templates out of the page every load parses | 2 | M | ~1/3 of page markup not parsed per start; ~7 KB gzip off server-first navigations | low
client-core-31 | Keep the timeline and composer across room switches, and drop the redundant leave | 2 | M | unknown; component rebuild + 3 frame redraws + one hub message per switch | low
client-core-32 | Consider SignalR stateful reconnect for short connection drops | 2 | L | ~1 RTT + tail + bootstrap bytes per short drop; frequency unknown | low

See also CRITICAL-PATH.md (context, not a finding): the boot, resume and send paths as the code runs them, and the module graph.
