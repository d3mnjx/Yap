# Offline chat behavior

Yap's chat runs in the browser on `/chat`, `/lobby`, `/room/{id}` and `/dm/{username}`. The server remains authoritative for accounts, permissions and accepted messages. Login, Settings, Admin and GIF library management remain online Blazor pages.

A successful authenticated online visit prepares offline use. Opening an instance for the first time while disconnected cannot retrieve an account or its history. Offline reload requires a service worker, which needs trusted HTTPS or loopback HTTP. If registration is blocked, online chat and local drafts can still work; the client explains that offline reload is unavailable.

## What works offline

| Action | Behavior |
| --- | --- |
| Open a cached conversation | Display saved messages, participant information and preferences. Arrivals for other accessible conversations are cached while connected, even when they are not selected. |
| Compose or reply | Save text and reply selection per conversation. Navigation and reload retain them. Completing a send cannot clear a newer reply selection or another conversation's draft. |
| Send text, images, videos or GIF selections | Save outgoing intent and available attachment blobs locally, then send when connected. External GIF lookup and upload processing still require the server. |
| Edit, delete or react | Queue an authorized attempt against the cached message. Reactions store desired membership, not a toggle to replay blindly. Permissions are checked again on acceptance. |
| Read history/media | Read what has actually been cached. Earlier uncached messages, missing media variants and provider content need a connection. |
| Observe messages | Persist the highest arrival checkpoint seen; synchronize it on reconnect without clearing newer unseen arrivals. |
| View presence or typing | Disconnected views do not claim live presence or replay cached typing. |
| Open Settings/Admin, create an uncached DM or sign in | These operations need the server. Previously synchronized DM routes remain available offline. |

## Sending and retry

Text is limited to 4,000 UTF-16 code units. Uploads retain the configured size/type restrictions. Before displaying an outgoing message, the client saves it to IndexedDB with a unique operation ID. Enqueue and conditional draft/reply cleanup are atomic.

Pending messages use the normal grouping and faded appearance. There are no routine queued, sending, sent or draft-saved labels. Failed operations retain feedback and Retry; failed work whose conversation has disappeared stays reachable through the Outgoing section.

Network and temporary failures retain the queue for retry. Permission, validation and other terminal failures keep the failed operation for review. A retry reuses its original operation ID and payload. A per-account Web Lock elects one sender coordinator across tabs. It delivers up to three conversations independently, preserving order within each and limiting uploads to one. A stalled upload therefore does not block text in another conversation. Already queued text/actions can share one batch request. Before the first attempt, an unsent text item can be edited or removed under that lock; after an attempt its retry identity stays stable.

Normal sends reuse the document's memory-only credentials and need one HTTP POST, with no session preflight or follow-up sync GET. Explicit CSRF expiry triggers one shared refresh/retry; a changed account stops retry.

The server validates the cookie, account-bound antiforgery token, conversation access and current permissions. It persists the message or mutation together with an operation receipt in one SQLite transaction. A lost acknowledgement can therefore be retried without accepting the operation twice. Replaying an old receipt does not restore a deleted message or overwrite a later edit. Competing edits use the last server-accepted edit; there is no merge dialog or automatic text merging.

Proxy deployments accept forwarded scheme/client IP without an address allowlist by default; forwarded Host is ignored and optional `PublicOrigin` overrides per-user login-link origins. Chat writes and live connections tolerate differences between browser and internal URLs; browser-marked cross-site requests are rejected, while missing browser metadata is accepted. Authentication and write antiforgery remain required. See the [deployment guide](../GHCR-DEPLOYMENT-GUIDE.md#https-reverse-proxies-and-caches) for optional proxy restrictions and the compatibility trade-off.

Attachments are queued as local blobs and uploaded through the existing resumable tus endpoint. Saved upload IDs let retries resume. The final upload response carries completion references when available, avoiding a completion GET. Account-owned receipt lookup remains the fallback after a lost response/reload. Requests are bounded and abortable so an interrupted upload cannot hold the account's sender lock indefinitely. Cancel removes the local job/blob and signals the active sender, including for failed uploads while offline. Upload endpoints must be on the same origin.

Durable sends require enabled SQLite persistence. When durable persistence is disabled, the server refuses these sends rather than promising crash-safe acceptance.

## Reconnection, history and read state

Compact HTTP acknowledgements and SignalR deltas converge through the same atomic commit path. Changed messages, deletions and conversation metadata replace account-wide snapshot traffic; author profiles travel once per update. The server projects each message event once and routes authorized patches through bounded connection queues. Content counters replace hashes. Overflow discards queued records and sends invalidations; reconnect compares known content versions and refetches mismatched windows. Full windows are projected only on demand, without a durable event log. Each server process has an epoch and increasing sequence; per-record ordering prevents delayed acknowledgements from overwriting newer edits/deletions. Server restart establishes a new epoch and fresh authority while local unsent work remains separate.

`OfflineChat:RecentMessageLimit` defaults to 100 and is clamped to 1–500. Bootstrap includes all accessible summaries and only the selected recent window. Matching cached active revisions omit repeated bodies. Missing windows download in a cancellable background queue (active first, then unread), while new messages stream immediately even for inactive conversations. All accessible conversations retain metadata, with recent windows reduced fairly above a 20,000-message target and at least one message per conversation. This is a client window limit, not a server message-memory redesign. Older visited pages have a separate bounded cache. Ordinary arrivals retain loaded unlimited history without fetching it again. Mutations, permission changes and restart invalidate older pages for a bounded refresh; restricted histories remain conservative. Their server epoch/history version is checked even while the conversation is inactive, so later navigation cannot knowingly display stale edits/deletions. Reply target lookup applies the same history authorization.

Read state uses monotonically increasing received/read-through counters. Explicitly opening a loaded conversation marks its observed content read; automatic reads depend on visibility and presence eligibility. An offline read acknowledges only what was seen, leaving later unobserved arrivals unread. Message deletion does not move arrival checkpoints backward.

## Account isolation and local storage

Browser state belongs to one origin and active account. The database/account lock/cross-tab channel use `yap-chat-v1`; the IndexedDB schema version is 4. Its upgrade preserves drafts, outbox and read checkpoints, splitting cached conversation bodies into their own store. Static shell and account media caches use `yap-chat-shell-*` and `yap-chat-media-*`.

- Authentication failure locks local access while retaining drafts/outbox for reauthentication as the same account.
- Explicit Forget, signout or account replacement purges the client's account-owned snapshots, drafts, outgoing work and media. Sibling tabs receive the change.
- Cached offline access has no elapsed-time limit, including installed PWA launches after weeks away. An unlocked saved account can read its cached messages and media. A disconnected device cannot immediately observe server-side revocation; an already-open in-memory view cannot be remotely erased.
- Clearing media caches in Settings does not clear drafts/outbox. Browser site-data deletion or eviction can remove both; local storage is not a backup.

The account media warmer prioritizes the selected conversation and the last three visited conversations, looking at their last 30 messages. It fetches eligible same-origin thumbnails/posters, avoids speculative full videos, respects Save-Data, pauses for foreground work and cancels on navigation. Files are limited to 4 MiB, the account cache to 32 MiB, and speculative transfers to 8 MiB per document/account. Explicitly viewed eligible images can also enter the cache. Metadata does not guarantee media bytes were downloaded. Do not assume every video or original-resolution image is available offline.

Shell v34 serves prepared chat routes from cache immediately. `/` and `/pwa-launch` remain network-first for authentication/handoff and rollback; worker updates activate independently. Large optional artwork and scene images are excluded from core precaching and cache when requested. The content loader currently requests the full emoji artwork bundle during startup; see the [measurement findings](offline-network-measurements.md#immediate-feedback-and-emoji-caching) for its remaining download and first-open costs. Static shell updates preserve the database and account media. APIs, authentication responses, personalized HTML and token-bearing manifests are not stored in the anonymous shell cache. The first release uses a fresh browser namespace; pre-release prototype browser state has no migration path. Existing server accounts/messages are independent of that reset.

An online return obtains current antiforgery credentials during bootstrap. ASP.NET antiforgery tokens have no fixed elapsed-time expiry here; if validation rejects a stale token, the client refreshes once and retries the same operation. The login cookie has a sliding 365-day maximum age, independent of cached offline access. The standalone return check covers 28-day-old local state, saved drafts/media and automatic token recovery; actual phone storage eviction and OS suspension remain device checks.

## Presence, notifications and installation

Online/Away/Invisible choices use the existing server policy, including manual status preservation, idle handling and disconnect grace. A shared 100 ms ticker builds the people list once and typing once per viewed channel; only changed views and active typing renewals are transmitted. Reports, status changes and typing calls are limited per connection (12-call burst, four calls/second per method). Typing is transient, authorized to the writable selected conversation, excludes the sender and expires after inactivity. Navigation, hiding, send, disconnect and authentication loss stop it.

Hidden-tab titles count fresh eligible arrivals and reset in the foreground. Room pages are silent; hidden DM pages may play the notification sound for unmuted DM arrivals. The arriving conversation's mute policy controls notification eligibility. Own sends, edits, reactions, typing and read acknowledgements do not create new arrival notifications.

Cold loads and reconnect catch-up establish a quiet audio baseline. Tabs on the same origin/account coordinate sound attempts so a checkpoint is not played twice. Playback is best effort: autoplay rejection, a closed tab or OS suspension does not trigger a later replay, and cross-device sound deduplication is not promised.

The PWA retains the credentialed, no-store manifest and existing account handoff. A first launch in a separate cookie context redeems its login link online; a valid existing cookie takes precedence over an expired link. Handoff tokens are removed from client URLs. Cached installed launches can reopen known chat routes; uncached notification destinations need connectivity. Push is notification delivery, not replication of offline message history.

Push permission remains an explicit installed-app flow. Granted subscriptions are repaired or rotated through the existing APIs. Browser tabs do not gain a persistent install/permission banner. Real OS installation, notification delivery, badges and suspended-device behavior remain platform checks.

## Durability and recovery limits

- Message/mutation acceptance and its receipt are atomic. Recipient unread increments and push/notification side effects follow acceptance and are not an exactly-once delivery guarantee. A later write failure can permanently miss an unread increment; retrying the receipt does not repair it. It no longer suppresses the accepted message event.
- Storage quota failures and browser eviction can lose local-only work. Server backups do not contain unsent browser drafts or queues.
- Offline permissions are provisional. Removed access, deleted conversations or changed write permissions can cause queued operations to fail when the server sees them.
- Original Blazor drafts held only in an old page/circuit are not migrated. Send or copy them before upgrading; see [deployment and rollback](../GHCR-DEPLOYMENT-GUIDE.md#upgrading-yap-to-the-offline-client).
- Real devices, external providers, broader storage stress and exhaustive feature variants remain outside the recorded automated coverage. See [features and parity](feature-parity-inventory.md#remaining-verification).

For implementation ownership and ordering invariants, read the [architecture guide](offline-client-architecture.md). For reproducible checks, use the [test guide](../tests/browser/README.md).
