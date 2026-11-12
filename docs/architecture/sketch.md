# Architecture sketch: Yap without Blazor

Written 2026-10-14, before any code. The wire contract is a separate page, [Wire contract](wire-contract.md). This page gives the two sides of the wire and the decisions behind them.

## Principles

The coding rules from the brief, and the rules this architecture adds. Every new part is checked against them.

**Code.**

1. Minimal and elegant. No unnecessary parts. "The best part is no part." For each part: do we need it, is it the right thing, is it elegant?
2. Readable and maintainable on every level: the whole, the architecture, the parts, the details. Will the next person understand what it does and why it is here?
3. Modern .NET features and patterns where they do not conflict with 1 and 2.
4. Comments explain why: the constraint, the bug or the trade-off that shaped the code, written at the line where a clean-up would break it.

**Architecture.**

1. The spec is the acceptance test. Behaviour is traced to rule IDs. Where the spec and the old code disagree, the spec is right and the difference is reported.
2. Memory is the truth, in one instance. ChatService holds the chat, the other singletons hold accounts, links, GIFs and settings. Every write goes to memory and returns. The database is an optional copy, fed by one ordered background writer, never awaited on a request path. A failed write is logged.
3. The hub carries the live session. HTTP carries documents and forms. Nothing is carried both ways.
4. The client is local first. A view renders from the store. An action changes the store at once, then tells the server. The server confirms or corrects. Refusals carry a reason the user can read.
5. One round trip per user action, and one request to paint the frame. Users are far away.
6. Text is data. The client renders links, shortcodes and emoji. No HTML travels on the wire.
7. Offline is modest: an outbox and a snapshot, no replica, no merge. Connectivity events are the retry.
8. Events fan out through one broadcaster. Rooms are groups, people are users. Clients resolve names from one directory.
9. Running without a database stays a product mode. Every path works with memory alone.

## One principle for the split

The hub carries the live chat session. Everything that happens *inside a connected conversation* is a hub method or a hub event: opening a conversation, reading messages, typing, presence, heartbeat, reactions, edits, deletes, mark-read, status. When the hub is not connected, these actions are exactly the ones the spec dims with "Needs a connection" (OF-12, MR-75). One rule, no per-feature decision.

HTTP carries documents and forms: sending a message, uploads, sign-in, settings, administration, the GIF library, the emoji catalogue, the bootstrap. Sending a message is HTTP because the offline outbox and the optional Background Sync handler in the service worker must send without a hub (design notes, "The sender").

## Side 1: the server, seen from ChatService

ChatService stays the singleton source of truth. Its collections, its lock, its persistence calls and its synchronous `Action` events stay. Four things change around it.

**1. Sessions are hub connections, grouped by device.** A `UserSession` is created in `ChatHub.OnConnectedAsync` and keyed by the SignalR connection id. The client sends a `deviceId` (a random id in local storage, a device convenience under GEN-23) as a query parameter at connect. Settings lists sessions per device (AU-19), the diagnostics table lists them per connection (AD-25). "Sign out all other devices" signs out every connection whose device differs from the caller's.

**2. Presence moves out of ChatService into `Services/Presence/PresenceService`.** It owns sessions, statuses, auto-away, typing and per-connection latency stats. This replaces `ChatCircuitHandler`, `CircuitTracker` and `CircuitIdentity`. The Blazor circuit had a "down but alive" state with a timer per circuit. SignalR has no such state, so a disconnect marks the session disconnected with a time stamp, and **one sweep every 10 seconds** applies the spec: disconnected for 30 s and no other visible session, away (PR-15); disconnected for 5 min, removed, which is the leave (PR-16, PR-17); idle 5 min on every session, auto-away (PR-10); no heartbeat for 90 s, treated as idle. A reconnect is a new connection for the same user and device, so the old session expires silently and no join or leave line appears (PR-17). The heartbeat is a hub method every 10 s visible, 60 s hidden, as today. ChatService keeps asking "who is connected" and "is any session visible" through PresenceService, for unread counting (NT-03) and push suppression (NT-26).

**3. Events fan out through one broadcaster.** `Endpoints/ChatHubBroadcaster` subscribes to the ChatService, PresenceService, GifService and UserService events once and sends hub events. Room events go to the SignalR group `channel:{id}`, which holds the connections that have that room open. Direct-message events go to both users with `Clients.User(...)`. Presence, rooms and profiles go to everyone. The system bot keeps its own subscriptions. Nothing else subscribes.

**4. Text is data, not HTML.** `EmojiService.Rendering` goes away. Messages, names and room names travel as plain text. The client renders links, `:shortcode:` images and emoji images itself. This fixes the stored-XSS that `ConvertEmojis` has today (it wraps unencoded text in `MarkupString`) and removes inline styles from the wire. The emoji catalogue (categories, keywords, custom packs, the fallback-image set) becomes one cacheable JSON document.

**5. One writer between memory and the database.** Today every service calls `ChatPersistenceService` and awaits a write-through to SQLite before it raises events or returns. In the new design a request path never touches Entity Framework. A service changes memory, then enqueues a write operation and returns. One hosted `PersistenceWriter` drains the queue in order, one transaction per drain, and is the only runtime code that knows the database besides the startup load. Decided 2026-10-14. What follows from it:

- The HTTP response and the hub event mean the same thing: "it is in memory, everyone has it". The client deletes its outbox row on the 200. A crash between the memory change and the write loses that message, which the design notes accept ("a message lost once a month is acceptable"). Today's code already swallows failed writes and returns success, so no guarantee is lost that existed.
- The queue is **ordered** and has **one consumer**. This is not optional. Independent fire-and-forget tasks would race: an edit's UPDATE could run before its INSERT, a DELETE before the row exists. One `System.Threading.Channels` channel, one reader, order kept. SQLite has one writer anyway.
- Every database optimisation lives in one place: batching the drain into one transaction, coalescing the unread-counter updates that every message produces for many people, WAL mode, retries. The services know nothing of it.
- Graceful shutdown drains the queue, with a timeout, so a normal restart or deploy loses nothing.
- Without persistence the writer is not registered and `Enqueue` is a no-op. Memory-only mode is the same code with one service missing.
- Admin logs, media logs and visitors are database-only features today (AD-03 says "Not available without persistence"). They keep writing through the same queue and reading from the database on the admin page. They are logs, not chat state.
- The diagnostics page shows the queue depth and the last write error, so a stalled disk is visible (AD-24).
- A queued write reads the row's values when it runs, not when it was queued. The database converges to memory, and the queue order keeps a delete after the insert it follows.

The writer in full, as a sketch. A `Channel` is a thread-safe queue with asynchronous waiting, a completion signal and optional bounds; nothing else is needed.

```cs
// Services/Persistence/PersistenceWriter.cs (sketch)
public sealed class PersistenceWriter(IDbContextFactory<ChatDbContext> db, ILogger<PersistenceWriter> log) : BackgroundService
{
    // One reader, so the runtime can use its cheapest implementation. Unbounded: a chat this size never
    // outruns SQLite; the depth is shown on the diagnostics page instead of enforced here.
    private readonly Channel<Func<ChatDbContext, CancellationToken, Task>> _queue =
        Channel.CreateUnbounded<Func<ChatDbContext, CancellationToken, Task>>(new() { SingleReader = true });

    public int Depth => _queue.Reader.Count;

    /// Called by the services after they changed memory. Never awaited by them.
    public void Enqueue(Func<ChatDbContext, CancellationToken, Task> write) => _queue.Writer.TryWrite(write);

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // Each pass drains everything that is queued right now into one transaction. Under load this
        // turns the many unread-counter updates of one message into one write.
        while (await _queue.Reader.WaitToReadAsync(stopping))
        {
            await using var ctx = await db.CreateDbContextAsync(stopping);
            await using var tx = await ctx.Database.BeginTransactionAsync(stopping);
            while (_queue.Reader.TryRead(out var write))
                await write(ctx, stopping);
            await ctx.SaveChangesAsync(stopping);
            await tx.CommitAsync(stopping);
        }
    }

    public override async Task StopAsync(CancellationToken ct)
    {
        _queue.Writer.Complete();      // no new items; the loop above ends after the last one
        await base.StopAsync(ct);      // the host gives it its shutdown timeout to drain
    }
}
```

The error handling is left out of the sketch: a failed pass logs the exception and the last error is shown on the diagnostics page. The services never see it.

Smaller changes:

- `SendMessageAsync` takes a `clientId`, changes memory, enqueues the write and returns the message. A `(userId, clientId) → messageId` dictionary gives the idempotent POST from the design notes. `ClientId` is a nullable column on `ChatMessage`, one migration, so the dictionary is rebuilt at startup from the messages of the last day.
- Paging cursors become `(timestamp, id)`. Today the cursor is a timestamp alone and equal timestamps can skip a message.
- Authentication becomes a 30-line `AuthenticationHandler` for the `yap_auth` cookie. It builds a `ClaimsPrincipal` with the user id, name and an `admin` role. `[Authorize]` on the hub, `RequireAuthorization()` on endpoint groups and an admin policy replace `AuthMiddleware`, `AdminGate` and the scoped `UserStateService`. SignalR's `Clients.User(userId)` then works with no manual user groups. The cookie bytes, name, `SameSite=Lax` and lifetime do not change, so installed apps and existing sessions survive. The sliding re-issue and known-IP recording move from "every HTML GET" to the one bootstrap request.
- `UseResponseCompression` (Brotli) for JSON, JS and CSS. Users far away download less.
- `index.html` is served by a tiny endpoint that stamps the build time into asset URLs and into the service-worker cache name. This gives immutable caching and the "new version" strip (OF-04) without `MapStaticAssets`.
- Blazor removed: `Components/`, `MapRazorComponents`, antiforgery, `CircuitOptions`, `ChatNavigationState`, `UserStateService`, `/Error` and `/not-found` pages, `BlazorDisableThrowNavigationException`. `DeviceDetectionMiddleware` becomes a one-line User-Agent check at hub connect.

Folder plan (namespaces follow folders):

```
Endpoints/   ChatHub.cs, ChatHubBroadcaster.cs, HubLatencyFilter.cs, Me*, Auth*, Admin*, Rooms*, Gifs*, Push*, Tus*, Emoji*, Shell (index.html stamping)
Services/Chat/           ChatService, LinkPreview*, MediaCache*, NetworkSecurityHelper, SystemBotService
Configuration/           ServerConfig (the configured values and text lists; as built, in place of a ChatTexts service)
Services/Persistence/    PersistenceWriter (the one ordered queue to the database), the startup load; cross-cutting, so not a spec area
Services/Presence/       PresenceService (sessions, status, auto-away sweep, typing, connection stats)
Services/Notifications/  NotificationSettingsService, Push*, NotificationAudit
Services/Media/          ImageService, VideoService, MediaUploadLogService
Services/Gifs/           as today
Services/Emoji/          EmojiCatalog (data and packs, no rendering), CustomEmojiService
Services/Accounts/       UserService, AccessLinkService, AccessLinkCodes, LinkTokenService, RegistrationGateService, LocaleResolver, GeoLocationService, ThemeRegistry, YapCookieAuthHandler, SignInService
Services/Admin/          DiagnosticsCollectorService, UserActionLogService
Models/<same areas>      entities and the wire DTOs
```

## Side 2: the client

Plain HTML, CSS and ES modules. No build step. The browser loads the module graph; `index.html` lists `modulepreload` hints so a far-away user pays one round trip for the scripts, not one per file. The service worker caches the shell (HTML, JS, CSS, fonts, icons) so a reload works offline (OF-06). `lib/signalr.min.js` is the one vendored library.

**How it looks.** The same as today. The 25 scoped `.razor.css` files flatten into plain CSS files under `wwwroot/css/`, one per area, each under a root class (`.frame`, `.timeline`, `.composer`, `.pickers`, `.page-settings`, `.page-admin`, `.page-login`) to avoid the class collisions that scoping hid (`.back-button`, `.form-group`, `.status-dot`, `.dot`). `themes.css` and `teahouse.css` stay as they are. Theme and text size are cached in local storage and applied by an inline script before first paint; the bootstrap corrects them.

**How it is organised.**

```
wwwroot/
  index.html              shell, templates, inline theme bootstrap
  css/                    app, frame, timeline, message, composer, pickers, settings, admin, login, themes, teahouse
  js/
    main.js               boot: bootstrap request and hub start in parallel, router, page mount
    router.js             the routes of SH-42, history, last-route (SH-43)
    store.js              one state object plus subscribe(); every view renders from it
    api.js                fetch wrapper: JSON, credentials, ProblemDetails → reason text
    hub.js                SignalR connection, reconnect policy (OF-13), connection state for the header
    render/text.js        links (MR-12), :shortcode:, emoji images, emoji-only size (MR-15..17)
    render/time.js        Intl with the account's zone, clock and date order (MR-05, MR-06)
    render/dom.js         el() helper and template cloning
    ui/frame.js           header, status chip and menu, connection dot, notice strip, sidebar, profile card
    ui/timeline.js        list, follow flag, pill, older pages, scroll anchoring (TL-*)
    ui/message.js         one row: header grouping, content, reactions, action bar, editor, menus
    ui/composer.js        input box, drafts, reply bar, typing, drop and paste, uploads (IB-*)
    ui/emoji-picker.js    both uses: composer and reaction (PK-01..12, PK-43)
    ui/gif-picker.js      tabs, search, folders, upload (PK-13..42)
    ui/gallery.js         viewer (TL-22..29)
    ui/overlays.js        sheets, menus, dialogs, confirm, Escape stack (GEN-17, GEN-18)
    pages/chat.js         room and DM page: open, receive, mark-read, title, sound
    pages/settings.js  pages/channel-settings.js  pages/admin.js  pages/login.js  pages/invite.js  pages/verify.js
    offline/outbox.js     IndexedDB store, one row per unsent message
    offline/sender.js     the event-driven loop under a Web Lock
    offline/snapshot.js   the tail of each opened conversation, for offline reloads
    push.js  pwa.js  upload.js (tus protocol, small)  notify.js (sound, title, badge)
  lib/signalr.min.js
  service-worker.js       shell cache, media cache, push, notification click, optional background sync
```

**How it works, in one sentence.** Views render from the store; a user action changes the store at once and then tells the server; the server's answer or event confirms or corrects the store (GEN-01, GEN-02).

Examples of local first:

- Send: append to the outbox, add a pending row, clear the draft. The sender posts. The `message` event with our `clientId` replaces the pending row in place. Send-to-appear is measured from tap to that replacement.
- Reaction: flip the pill, invoke `react`. On failure, flip back and show the reason for two seconds.
- Status pick: recolour the chip, invoke `setStatus`. The `me` event confirms on every device.
- Edit and delete: apply to the row, invoke, revert on failure.
- Open conversation: paint the snapshot from IndexedDB at once, invoke `open`, replace with the answer.

Carried over from `chat.js` almost unchanged: scroll-to-bottom with the media wait, near-bottom check, restore position on prepend, scroll-to-message, gallery gestures, drop zone, autosize, Enter handling, send-button focus guard, emoji toggle sprite, caret insertion, typing tracker, mobile action-bar dismiss, paste upload, video overlay, theme and font application, GIF autoplay recovery, picker positioning, push helpers, PWA helpers. Removed: every `.NET` callback, synthetic `change` events, `PickerPane`, ghost reconciliation by DOM observation (the `clientId` replaces it).

**What the client needs from the server.** One bootstrap document (`GET /api/bootstrap`) that paints the whole frame in one round trip, fetched every time the hub connects so a reconnect and a cold start are one code path (user, config, text lists, rooms, people directory, unread counts, mutes, recent emoji, quick reactions, favourite GIF ids). A hub that returns the conversation tail from `open` so a switch costs one round trip and has no race between the history read and the group join. Events small enough to apply directly to the store. Plain text everywhere. Reasons in refusals.

## Decisions

Taken on 2026-10-14 with the user.

1. **PresenceService is extracted from ChatService.** ChatService keeps channels, messages, reactions and read state. Consequences:
   - One dependency direction. ChatService asks PresenceService "who is connected", "is this person online and visible" (NT-03, NT-26). PresenceService never references ChatService.
   - The chosen status becomes account data. PR-01 and PR-02 say the status belongs to the account and survives a server restart. Today it lives in memory and is re-sent by the Blazor client. It moves onto `User` and UserService persists it. PresenceService computes the effective state (online, away, offline, automatic away) from the chosen status and the sessions.
   - The events split. Join, leave, status, typing and kicked move to PresenceService. The broadcaster and the system bot subscribe to both services.
   - The bot's permanent session (PR-09) is registered in PresenceService at startup, as today.
   - Smart login's "a connected device on this address" (AU-09), the admin status pills (AD-04) and the two diagnostics tables (AD-25, AD-26) read PresenceService.
   - The hub talks to PresenceService for connect, disconnect, heartbeat, typing and status, and to ChatService for open, older, react, edit, delete and mark-read.
   - The message path clears the sender's typing entry through PresenceService (IB-59).
2. **tus-js-client is vendored**, one file in `wwwroot/lib/`, like the SignalR client (corrected 2026-10-14). The outbox sender must upload after an offline reload, so the script is part of the app shell. A same-origin file is cached by the service worker with the rest of the shell, with no special case. A CDN script would need CORS mode to be cacheable without the browser's opaque-response quota padding, a separate precache step, and an availability dependency at the moment the connection returns.
3. **Chart.js stays on the CDN.** It loads on the admin page only, and Admin needs a connection anyway (OF-07). The install-guide library (decision 4) is the same case. If a strict `script-src 'self'` content security policy is wanted later, these two are vendored too; nothing else changes. Both script tags carry an integrity hash, and the URL of the install guide names a commit, not a tag (2026-11-11): the two scripts run in the page with the person's sign-in, so the browser must refuse bytes that are not the ones we read.
4. **Install guide.** Our own dialog for SH-40, because the spec fixes its texts and buttons. Behind "Install app": the native browser prompt where it exists, otherwise the add-to-homescreen library's guide, loaded from the CDN on tap, as today. The library tracks browser and OS changes (in-app browsers, iOS share sheet changes); that is the part worth not owning.
5. **Emoji images stay on the jsDelivr image CDN with the local fallback set.** For offline, the service worker caches emoji images cache-first in their own cache group, which ST-25 already names ("Emoji — downloaded artwork"). The images are requested with `crossorigin="anonymous"`, so the cached responses are not opaque; an opaque response is padded in the browser's quota accounting, and a few hundred cached emoji would count as gigabytes. An emoji seen once shows offline. An emoji never seen falls back to the alt text, which is the device's own glyph. No sprite sheet and no self-hosted set, unless latency measurements say otherwise.
6. **Transition path.** A clean rewrite. Blazor comes out first, and the new app is built from the spec. No coexistence under a prefix, no additive API on the Blazor app. The tree may not run between steps. Nothing is pushed until a coherent whole works.

## Spec versus code: differences met so far

The spec is right. Listed so the user sees them. The first table is the list from the Blazor build of 2026-10-14. The rewrite of 2026-10-15 replaced that code, so these rows are history. The second table is the live one.

| Rule | Spec | Code today |
| --- | --- | --- |
| AU-19 | One session row per device; tabs share a row | One row per circuit (tab) |
| TL-10..12 | The view follows only while at the bottom; otherwise it holds | Every received message scrolls to the bottom |
| TL-06 | The next page loads when within two screens of the top | Same, plus an artificial 500 ms delay on the server |
| TL-07 | "Load earlier messages" link in a conversation too short to scroll | Not present; infinite scroll only |
| IB-36 | An upload during a reply is sent as a reply | Media messages never carry the reply target |
| OF-06, TL-02 | Last known messages show after an offline reload | No snapshot cache; Blazor needed a live circuit |
| OF-08 | Sending works offline and after the app was closed | No outbox; a send without a circuit is lost |
| SH-20, OF-04 | A new version shows a notice strip with Reload | Blazor reconnect banner |
| MR-10, MR-12 | Text shows as typed; only links and emoji are transformed | True, but the text is injected as unencoded HTML (stored XSS) |
| NT-05 | Counts stay after a server restart | The first unread row of a user and channel is not inserted until a mark-read persists it |
| PR-17 | A leave is 5 min after the last connection drops | Tied to Blazor circuit retention, about 3 min |

Differences that remain in the rewrite, by decision (2026-10-15, after the walk of every spec page). Two rows left the table with the review fixes of 2026-10-15: OF-08 for a direct message never opened (the outbox addresses it by its partner) and PR-16/PR-24 (the automatic read checks the chosen and the effective status too). MR-59 vs GEN-03 left it on 2026-11-07: GEN-03 won, and MR-59 now says that Edit opens the phone keyboard. AD-02 left it on 2026-11-09. The owner kept the behaviour of the rewrite, and AD-02 now says that each tab loads again each time it opens.

| Rule | The spec | The rewrite |
| --- | --- | --- |
| SH-20, GEN-11 | "Sign in to continue." strip when signed out without a connection | Not shown: a sign-out reaches the device only with a connection, and then the login page opens |
| AD-12 | The link preview switch applies at once to open chats | New answers follow the switch; open chats keep their cards until a reload |
| OF-06 | Media not seen before shows "Needs a connection" | The browser's broken-image state shows instead |
| TL-12 | Changes above the view never move the row the reader reads | Older pages are compensated and land only while the view is still (TL-06); edits and loads above rely on the browser's scroll anchoring (Safari from 27 only) |
| ST-06, SH-35 | Settings has a Location field with "Detect". The profile card shows the location | Both are off since 2026-11-12, because the user map that the field was made for did not happen. Their markup is commented out in index.html. The server keeps each saved location |

## Phases

Each step is explained first and built after the user agrees.

1. Server spine: remove Blazor (`Components/`, circuit services, Razor mapping, antiforgery), cookie authentication handler, PresenceService, ChatHub, broadcaster, bootstrap, message POST with `clientId`, emoji catalogue, response compression, shell endpoint. Move services into area folders as they are touched.
2. Client shell: frame, timeline, message row, composer, pickers, gallery, text and time rendering, hub and store. The chat works again at the end of this step.
3. Offline: outbox, sender, snapshot cache, service-worker shell cache, new-version strip.
4. Pages: login, verify, invite, settings, channel settings, admin with its API.
5. Clean-up: csproj, Program, request logging, service worker, docs.
6. Playwright for .NET: screenshots for the spec and checks for the rule IDs that matter most.
