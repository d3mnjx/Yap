# Offline client maintenance guide

For an illustrated overview, open the [standalone architecture page](offline-architecture.html). It illustrates the runtime, message lifecycle and repository structure.

The [communication guide](offline-communication.html) traces startup, maps features to HTTP/SignalR/Blazor, and explains the two browser runtimes with diagrams and source excerpts.

The chat UI runs as native JavaScript modules, with no frontend build step. ASP.NET serves the shell on `/chat`, `/lobby`, `/room/{id}` and `/dm/{username}`. Login, Settings and Admin retain their Blazor implementation. Start with [app.js](../Yap/wwwroot/chat-client/app.js), then follow the responsibility you need below.

For the server-side types and request/stream flow, see [`Yap/Offline`](../Yap/Offline/README.md).

See the [network and interaction measurements](offline-network-measurements.md) for the frozen-original comparison at 900 ms RTT, cache costs and remaining UI delays.

## Ownership

Paths in this table are relative to `Yap/wwwroot/chat-client/`.

| Module | Owns | Boundary |
| --- | --- | --- |
| `app.js` | Current account, snapshot, route, connection/reconnect, snapshot queue, render generation; sidebar and pending presentation | Coordinates lifecycle explicitly. Account and connection work stay together because their ordering matters. |
| `composer.js` | Draft write queue, reply selection, restoration latch, submission, attachment input and picker setup | Reads current account/route through getters; captures their values before asynchronous user actions. |
| `messages.js` | Timeline rows, their content signatures and hydrated image object URLs | Preserves active editors and playing media; does not own snapshots or durable messages. |
| `sync.js`, `windows.js` | Per-record delta ordering and cancellable missing-window recovery | A gap reloads one bounded conversation window; unrelated conversations merge independently. |
| `storage.js` | Account-bound IndexedDB transactions, cross-tab locking and change notices | Sole writer for snapshots, drafts, outbox and observed reads. |
| `sender.js`, `uploads.js`, `api.js` | Outbox delivery, resumable uploads, authenticated HTTP | Delivery status is separate from durable user intent. |
| `actions.js` | Editing/action controls and optimistic mutations | Enqueues edits/deletes/desired reaction membership; server acceptance remains authoritative. |
| `history.js` | Older pages, fetch cancellation and content-version reconciliation | Merges pages with the authoritative recent window for display. |
| `live.js`, `reader.js`, `notifications.js` | Presence/typing, observed reads, title/audio | Transient presence is not durable history; audio claims are shared across tabs. |
| `content.js`, `gifs.js`, `pickers.js` | Catalogs, emoji/GIF selection and mounted picker views | Reuses original assets and picker behavior. |
| `media.js`, `rich-media.js`, `gallery.js`, `scroll.js` | Account media cache, rich rendering, gallery and scroll following | Media URL ownership and DOM retention matter for playback. |
| `pwa.js`, `worker-updates.js`, `worker.js` | Installation/push integration, update activation and offline shell | Root `../service-worker.js` also retains the push handler. |
| `contracts.js` | JSDoc shapes for account, snapshot and outbox records | Editor documentation only; no runtime import or validation framework. Server DTOs are in `OfflineSnapshotService.cs`. |

Factories are instantiated once by `app.js`. Getters expose changing page state without copying it into every component. Keep new state with its existing owner; another generic event bus or lifecycle layer is unnecessary.

## Sending and recovery

1. The composer captures account, conversation and reply selection, then waits for preceding draft writes.
2. `storage.enqueue` saves an immutable operation ID and payload in IndexedDB. Draft/reply cleanup is part of that transaction. Only after that succeeds does the UI show the pending row and start delivery.
3. `sender.js` takes a per-user Web Lock to elect one delivery coordinator across tabs. It runs up to three independent conversations, preserving order inside each, with at most one upload. Already queued text/actions batch up to 16 operations / 48 KiB; the first send is never delayed to form a batch. Attachments save resumable upload references before message acceptance. Cancellation aborts active requests; bounded requests prevent a stalled upload retaining the lock indefinitely.
4. The server validates identity, authorization and payload, then atomically persists the message or mutation with its operation receipt. A lost response is safe to retry with the same ID and intent.
5. Compact HTTP acknowledgements and SignalR deltas pass through the same `acceptSnapshot` queue. Storage reconciles accepted operation IDs even if the stream arrives before the POST response. An acknowledgement must never recreate a row already removed by a snapshot.

Before the first network attempt, a queued text message can be edited or removed under the sender lock. After an attempt, retry identity and payload must remain stable. Reactions store desired membership, not a toggle that a replay would reverse. Deleted messages must stay deleted when replaying an old receipt.

`ChatService.Text.cs` hashes persisted receipt payloads. Field names, JSON property order and the raw-text special case are compatibility rules: cosmetically changing serialization can make an old accepted operation fail retry after an upgrade.

## Startup and network priority

Online shell HTML renders account theme/font preferences. Blocking `../js/appearance.js` applies a small localStorage appearance mirror before CSS on cached navigation, including Tea House scenes. Settings updates that mirror immediately; rendering an older IndexedDB snapshot cannot overwrite it before bootstrap. The neutral static shell remains the only cacheable HTML.

An authenticated `/` without a return URL serves the chat shell directly. One `/bootstrap` request validates the account and returns memory-only CSRF credentials, a live ticket and active data. A matching account/epoch/revision omits unchanged active message bodies. Sending starts immediately after applying this response; catalog loading, saved reads, missing windows and PWA setup do not gate it. The hub uses normal SignalR negotiation/fallback. `WatchActivity` registers presence and initial viewing state in one invocation; `WatchChanges` supplies message deltas.

`api.js` reuses credentials, refreshing once on an explicit CSRF rejection. The server checks the expected account independently of the cookie; refresh never retries as another user. The periodic 30-second cookie check stays off the send path. Foreground writes/history suspend background window/media work. Navigation cancels an obsolete window and promotes the selected conversation. Media warming is limited to recent visited content; see the behavior guide for budgets.

## Four different ordering rules

| Guard | Lifetime | What it prevents |
| --- | --- | --- |
| Account `epoch` | Persisted local account lease; replaced after purge/account replacement | An old asynchronous action writing into another account's storage. Capture the owner before awaiting and validate it inside the transaction. |
| Snapshot `serverEpoch` + `sequence` | Server process and its increasing capture sequence, applied per conversation and record | Older responses or sibling tabs replacing newer authority. Retired server epochs are remembered; a new epoch resets ordering guards while retaining unrestricted recent messages until window revalidation. These stale windows cannot acknowledge reads. This is not a durable delta cursor. |
| `connectionGeneration` | Current page connection attempt | Callbacks from a stopped connection changing the new session. Increment before stopping, because stopping can itself invoke callbacks. |
| `renderGeneration` | Current page render | An earlier IndexedDB read or draft restoration overwriting a newer navigation/render. |

The composer restoration latch remains set until the latest restoration finishes. Updating the selected conversation alone does not finish navigation. Reply drafts also have their own `draftId`: sending one reply must not clear a newer selection, including a second selection of the same target. Keep these checks when changing await boundaries.

Authentication failure locks local access while retaining unsent work for same-account recovery. Explicit Forget/signout or account replacement purges it. Cached offline access has no elapsed-time limit. An unlocked saved account can reopen its local data after weeks away. Disconnected devices cannot immediately observe server revocation.

## History, reads and rendering

Bootstrap supplies account/session metadata, conversation summaries and the selected recent window. `OfflineChangeSignal` assigns channel content/history counters and a process-wide sequence. `OfflineFanout` projects each message event once, applies viewer-specific visibility/reply/favorite rules, and routes patches to bounded connection queues. `WatchChanges` coalesces queued records per conversation, retaining independent sequence stamps and deduplicated authors; it never builds or hashes snapshots. Queue overflow and mismatched reconnect revisions invalidate authorized windows. No persistent change log is introduced. `sync.js` merges each record using its sequence and deletion/window watermarks. Complete revisions advance the window; a gap queues `/windows/{id}`. IndexedDB schema 4 stores conversations separately so an arrival does not rewrite all other message bodies.

`history.js` owns older pages and stores a server epoch/history version. Ordinary arrivals preserve unlimited loaded history and retain messages leaving the recent window. Contiguous live edits, reactions and deletes patch loaded pages in place, including inactive conversations and reply targets. Compact acknowledgements update known rows while waiting for the complete stream revision; provisional validation is never persisted. Each tab applies ordered packets to its own view after the shared storage commit; account-bound sibling notices carry the original delta so newer shared metadata cannot skip a history mutation. Timeline updates anchor the first surviving visible row when the reader has scrolled back. Patched history is persisted before rendering, and older sibling writes cannot replace newer cached revisions. Missed revisions, permission changes and restart invalidate older pages; they refresh on selection. Restricted histories conservatively use the content version. Reconcile every newer snapshot, including inactive conversations; otherwise navigating back can expose stale edits/deletions until another packet arrives. A version change during a history request invalidates its response.

Observed reads persist the highest arrival checkpoint actually seen. The server advances `readThrough` only through that checkpoint, so reconnecting with an old offline read cannot clear newer unseen arrivals. Read eligibility still follows visibility, selected conversation and presence rules. Unloaded summaries cannot acknowledge unseen messages. Checkpoints coalesce for 300 ms and batch up to 100 per request.

`messages.js` compares row signatures before changing DOM. Reaction-only updates replace reaction/actions controls while retaining media elements. Active editors stay mounted until the action lifecycle releases them. Hydrated message-image object URLs belong to the timeline. Emoji use direct local image paths, with no artwork Blob URLs. `content.js` starts with generated built-in metadata, applies cached account metadata before its network refresh, and repairs rendered emoji text in place when catalogs arrive. Catalog revisions refresh reaction controls without detaching message media.

Sends serialize only competing operations on the same message; DM creation locks only the participant pair. SQLite transactions and receipt uniqueness remain authoritative. Recipient unread increments use two set-based statements under the existing read/checkpoint gate. Presence uses one shared 100 ms ticker; unchanged views produce no packet. Hub reports/status/typing use per-connection burst limits.

Durable sends commit the message, receipt and recipient unread checkpoints in one transaction under the read/checkpoint gate. A failed unread write rolls back acceptance for safe retry. Notification subscribers run independently so one failure cannot suppress later listeners or push. Legacy bot/server sends retain best-effort persistence and continue publishing when it fails. See the [durability and recovery limits](offline-behavior.md#durability-and-recovery-limits).

## Styles and retained Blazor pages

`component-styles.css` is the browser client's explicit, static base stylesheet; `chat.css` contains its client-specific rules. Edit these files directly. No runtime reflection or Razor CSS extraction participates in serving chat. The initial extraction preserves the established cascade and picker class boundaries. Retained Blazor components (layout, header, sidebar, avatar and Settings/Admin helpers) keep their own scoped CSS; a future shared design change may need both surfaces updated deliberately.

The unrouted Blazor room/DM pages, chat base, message input/rows, pickers, gallery and message media components have been removed. `../js/chat.js` contains interop only for retained Blazor pages, including push, appearance and circuit heartbeat; composition and sending belong exclusively to the browser client modules.

## Shell changes and validation

Bump `CHAT_SHELL` in `worker.js` whenever shipped shell assets change; add new runtime modules to its asset list. Current shell is **v41**, IndexedDB schema **4**. Activation removes old shell caches while retaining IndexedDB, account media and the separate `yap-chat-emoji-17.0.3` artwork cache. Only a Twemoji pin change replaces the artwork cache; custom packs/overrides and catalog metadata retain shell-scoped caching. The initial move preserves pinned SVGs already cached by v35. `worker-updates.js` is loaded independently by HTML so an incumbent worker serving an older app can still activate its replacement. APIs, authentication responses and personalized HTML must never enter the static shell cache.

Deploy complete publish output, including compressed assets, while preserving private Data/configuration/uploads. Follow the [deployment and rollback guide](../GHCR-DEPLOYMENT-GUIDE.md#upgrading-yap-to-the-offline-client). The database/account lock/channel use `yap-chat-v1`; caches use `yap-chat-shell-*`, `yap-chat-media-*` and `yap-chat-emoji-*`. DOM events use `chat-*`; worker constants use `CHAT_*`. Keep deployed namespaces stable. The first release starts fresh browser storage; pre-release prototype queues have no migration path. Server accounts/messages remain independent.

Use [the browser testing guide](../tests/browser/README.md) for tooling, isolated fixtures and formatter commands. The [feature reference](feature-parity-inventory.md) is the maintained behavior and coverage record. Physical-device installation, external providers/push, Safari and broader storage/accessibility checks remain explicit validation boundaries.
