# Yap feature reference

This is the maintained feature list for Yap: accounts, rooms and direct messages, messaging, media, notifications, settings, administration, and offline use. Each row describes current behavior and its verification limits. Keep feature IDs stable as the project evolves; update affected rows when behavior or coverage changes.

Chat runs in the browser. Login, Settings, Admin and GIF library management use online Blazor pages, with shared account, permission, messaging and media services. See [architecture](offline-client-architecture.md) for implementation ownership, [offline behavior](offline-behavior.md) for storage and recovery guarantees, and [testing](../tests/browser/README.md) for reproducible checks.

## Reading the tables

- **Feature:** supported behavior and relevant constraints.
- **Coverage and limits:** exercised scenarios and gaps; comparisons describe regression evidence, not a separate feature target.
- **Implemented:** the feature exists, but the listed coverage is not exhaustive.
- **Verified:** the specific scope described in the coverage column passed. **Partial verification** identifies outstanding coverage within that feature.

The recorded browser checks principally use Chromium 156 with Playwright 1.64. Firefox 157 has selected gallery/upgrade coverage. Phone-width emulation, mocked provider/permission APIs and instrumented audio/visibility do not establish physical-device or external-service behavior. No table row claims exhaustive coverage across every theme, setting, browser or device.

## Entry, identity, and navigation

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| AUTH-01 | `/` supports a configured welcome page. Authenticated users follow a safe return URL, installed-PWA last route, or lobby. | Welcome/entry routes; credentialed launch/return/deep-link routing; configured welcome variants not browser-exhausted | Implemented |
| AUTH-02 | Username entry creates a permitted new account and enters chat, with validation feedback and existing-account handling. | real permitted account creation and entry; validation/existing-account Server UI; all rejection variants not browser-exhausted | Implemented |
| AUTH-03 | Usernames are trimmed and lowercased, 2–23 characters, using letters, digits, `_`, and `.`. Reject consecutive periods and reserved/colliding names. | UsernameRules/Login/AuthEndpoints normalization/validation; expanded rejection matrix unverified | Implemented |
| AUTH-04 | Closed registration and approval-required registration have separate screens for waiting, rejection, retry, and approved entry. | RegistrationGate/Login/approval pages; closed/pending/rejected admin workflow not browser-tested | Implemented |
| AUTH-05 | Existing accounts support secret codes, login links/codes, and permitted familiar-device/IP flows, with explanatory recovery messages. | VerifyDevice/AuthEndpoints/AccessLinks; real token handoff; full secret/familiar-IP recovery matrix unverified | Implemented |
| AUTH-06 | Invite/login links handle join, continue, account-switch confirmation, invalid/expired links, and temporary throttling. | Invite/AccessLinks/AuthEndpoints implementation; full switch/expiry/throttle browser matrix unverified | Implemented |
| AUTH-07 | Cookie sessions survive ordinary navigation. Sign out clears authentication; revoked connected sessions leave chat. Local-data removal follows OFF-07. | same-origin upgrade retains cookies/accounts and renews expiry; real Settings token rotation preserves current cookie and locks another open client with retained draft; confirmed signout purges local account; cookie/account boundaries | Implemented |
| NAV-01 | Chat is available at `/chat`, `/lobby`, `/room/{id}`, and `/dm/{username}`, including direct links and browser back/forward navigation. | normal routes, browser navigation and offline DM reload | Verified |
| NAV-02 | Room navigation updates the title, active sidebar entry, channel description, and composer permissions. Header back action returns to lobby. | configured titles/history; real admin create/edit/delete and live permissions/history restrictions; client return routes passed | Implemented |
| NAV-03 | Selecting another person opens their DM. Selecting yourself does nothing. Offline DM partners remain in the sidebar. | cached/new DM routing; mobile self-tap leaves sidebar open | Implemented |
| NAV-04 | Sidebar groups admin, bot, self, and other users. Others prioritize unmuted unread DMs, then presence, offline-DM recency, and username. | targeted sidebar comparison; sidebar ordering implemented; broader multi-party ordering coverage pending | Implemented |
| NAV-05 | Sidebar and header show presence indicators, account labels, user counts, admin/bot markers, unread indicators, and mute bells. | presence/unread/mutes; emoji badges/profile-info icon and configured header | Implemented |
| NAV-06 | Mobile sidebar opens through its toggle or mailbox. Backdrop dismisses it; selecting a destination closes it. Mailbox opens the sidebar. | sidebar/mailbox/backdrop; Settings navigation and mobile self-tap; destination-close behavior checked | Implemented |
| NAV-07 | Profile popouts show avatar, display name, username, status, bio, location, membership date, and applicable badges. Invisible appears offline. | desktop hover/mobile info card, public profile DTO and offline state; real-device touch pending | Implemented |
| NAV-08 | Header menu offers status, Settings, notification Settings anchor, admin when allowed, and sign out. Users without recovery credentials receive sign-out guidance. | controls; missing-credential online/offline warning, cancellation and Settings Away/Invisible status handoff | Implemented |

Login and invite pages remain online Blazor Server entry points. Chat routes are owned by the browser client.

## Timeline and message content

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| MSG-01 | Rooms and DMs display chronological messages, newest at the bottom. A short timeline stays bottom-aligned above the composer. | chronological cached/queued grouping and short-timeline bottom alignment; media row rendering | Implemented |
| MSG-02 | Consecutive messages share a header unless the author changes, at least one hour passes, or the new message is a reply. System messages have distinct presentation. | exact one-hour/author cached+queued grouping; replies and system-message treatment | Implemented |
| MSG-03 | Messages show avatars, display names, bot markers, timestamps, edited markers, and reaction counts. Missing avatars use fallback colors and initials. | versioned avatar URLs, bot/system details and configured date patterns; wider profile/theme device coverage pending | Partial verification |
| MSG-04 | Render multiline text, clickable detected URLs, Unicode emoji, and custom shortcodes. URL content must not undergo shortcode substitution. | emoji/link rendering; message-link class, explicit themed colors and underlined contrast for bot/ordinary links | Implemented |
| MSG-05 | Emoji support normal inline, reaction, and enlarged emoji-only sizing, combined Unicode sequences, and local artwork overrides. | 1.2em mixed / 3em emoji-only / 18px reaction sizing applied; browser checks passed | Implemented |
| MSG-06 | The recent message window is configurable (default 100). Scrolling upward loads older pages while preserving the visible position. | cache bounds retained; versioned history invalidation/navigation, in-flight update, inactive edit/delete and offline reload regressions pass | Implemented |
| MSG-07 | Show loading history, beginning-of-conversation/description, and restricted-history states. Enforce room history windows and since-signup visibility, with admin exceptions. | authorized restricted-history DTO; beginning/description/restriction states and automatic scroll paging; loading indicator checked | Implemented |
| MSG-08 | Creates, edits, deletions, reactions, and asynchronous preview/GIF updates appear without a page reload. Unrelated updates preserve active editors. | receiving mutations; preserves active editor and reconciles latest accepted content on cancellation while offline | Partial verification |
| MSG-09 | Own sends and conversation entry follow the bottom, including pending messages. Arrivals preserve a scrolled-up reading position; prepended history retains the visible anchor. Media and reaction updates follow when near the bottom. | own uploads/text and room navigation follow completed layout, including late media; overlapping snapshot restores draft/composer. retain scrolled-up reading and history anchors. scrolled-up arrival behavior checked | Partial verification |
| MSG-10 | Reply previews show author and target content, with an attachment label when needed. Clicking an available target loads it if necessary, scrolls to it and highlights it. | loaded/uncached reply lookup and highlight; history authorization; unavailable targets explicit | Implemented |
| MSG-11 | Link cards show available site/title/description/image data. Cached external video/audio replaces cards with suitable players and source links. | real server projection, cached title fallback, failed-card suppression and five-preview cap; native decode; link cards; external extraction/provider delivery remains unverified | Implemented |

## Composer and message actions

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| INPUT-01 | Send nonempty text with the button. Clear and resize the input promptly. A persisted server message replaces immediate feedback. | durable acceptance and local queue | Verified |
| INPUT-02 | Desktop Enter sends; Shift+Enter inserts a newline. Touch-device Enter inserts a newline. IME composition must not accidentally send. | desktop, synthetic IME event, emulated touch | Verified |
| INPUT-03 | Textarea grows with text and retains caret/selection during emoji insertion, with send-button focus and touch keyboard handling. | measured autoresize; repeated caret insertion/no keyboard focus; IME/touch editing; physical software keyboards remain unverified | Implemented |
| INPUT-04 | Reply action highlights the target and opens the composer reply bar. Cancel clears it; text/GIF/attachment sends retain the reply association. | association retained; atomic enqueue/reply cleanup preserves destination and newer same-conversation reply selections | Implemented |
| INPUT-05 | Read-only rooms show an explanation instead of the writable composer. Permission changes must update the open room. | real admin permission change updates an open member room to read-only; server rejects writes; authorization | Implemented |
| INPUT-06 | Typing indicators exclude self and support one, two, or several people. Stop after idle, empty input, send, or conversation exit. | typing count/text, self exclusion, expiry and navigation/hiding cleanup; same behavior as NOTIF-13 | Verified |
| INPUT-07 | Text and GIF sends show immediate pending content. Durable queuing retains its faded appearance until acceptance or actionable failure. | quiet durable text; immediate durable GIF preview before slow provider resolution, picker closes; failed-send Retry retained | Implemented |
| ACT-01 | Desktop hover and mobile interaction reveal message actions, positioned within the viewport and dismissed by outside interaction or scrolling. | popup containment/touch expiry; More keeps menu-open action-bar state across lost hover and queued-row replacement, clears it on dismissal | Implemented |
| ACT-02 | Quick reactions and the full emoji picker toggle a user's reaction. Pills show totals, own-reaction styling, and participant names on hover. | desired-state reactions offline/reload/reconnect; full picker, shared recents, quick/pill changes and defaults | Implemented |
| ACT-03 | Quick reactions use personal reaction history with defaults; emoji recents are shared across the applicable pickers. | heart/laugh/thumb defaults, server reaction-history ranking, quick/pill/full picker shared recents | Implemented |
| ACT-04 | Users can edit their own non-media messages. The editor starts with current content and supports Save/Cancel, desktop Enter, Escape, touch newlines, and an edited label. | no-op/caret/autogrow/IME/touch focus/newline; durable edits and concurrent cancel regression | Implemented |
| ACT-05 | More offers Copy Text when text exists and Delete for owned messages, using a desktop menu or mobile sheet. | other-author submenu correctly has Copy only, own queued messages have Copy/Delete; action bar stays visible. copy/delete and desktop/phone controls | Implemented |
| ACT-06 | Delete confirmation includes a message preview. Support cancel, Escape, focused confirmation, and Shift+click bypass. | preview, cancel/confirm; Shift bypass implemented, expanded keyboard checks pending | Partial verification |

## Emoji, GIFs, and personal libraries

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| EMOJI-01 | Emoji picker has Recent, server/built-in packs, and Unicode categories. Category selection clears search and moves to that section. | category order/grid geometry; local category jump/highlight and empty recent state | Implemented |
| EMOJI-02 | Emoji search filters locally by keywords/shortcodes, with clear and no-results controls. Selecting a composing emoji inserts at the caret. | trimmed substring search, clear/no-results, repeated immediate caret insertion online/offline; frozen Blazor baseline compared | Implemented |
| EMOJI-03 | Recent emoji are deduplicated, move to the front, and retain up to 20. Refresh the mounted picker's recents between openings. | newest-first 20-item recents refresh on reopen and remain frozen during selection | Implemented |
| EMOJI-04 | Desktop emoji picker and combined mobile emoji/GIF drawer support local opening, tab switching, closing, and viewport changes. First-open performance limits are documented below. | mounted desktop/mobile panes; matched sheet/composer geometry, tab state retention, reopen reset and local dismissal; real keyboard pending | Implemented |
| EMOJI-05 | Active Unicode artwork is Twemoji, with local overrides and custom packs. Apple support exists as a code setting, not a user selector. | Pinned local Twemoji 17.0.3 CC-BY artwork, existing overrides/packs; bundled Unicode artwork cached with the shell; custom artwork cached on use | Implemented |
| GIF-01 | Picker includes Recent, Favorites, Server library, Trending, and Browse when available, with provider-unconfigured and empty states. | Browse/default/configuration/folder views; controlled provider cases and real local media passed; external delivery pending | Partial verification |
| GIF-02 | Search and browsing expose local/provider results, folders/categories, loading, additional results, provider attribution, and errors. | local/provider sections, cancellation, clear/paging and selection cursor fixtures passed; live provider pending | Partial verification |
| GIF-03 | Selecting a GIF sends it and closes the picker. Starring a picker card changes favorites without sending. | aspect-ratio preview/favorite controls and local upload acceptance; reference comparison of geometry passed | Implemented |
| GIF-04 | Timeline GIFs preserve dimensions, image/video fallback, loading/unavailable states, and uploader attribution. | Snapshot GIF URLs, dimensions, loading/error and uploader attribution; browser checks passed | Implemented |
| GIF-05 | Favorite/unfavorite from a timeline GIF. Desktop has a corner star; mobile uses its action bar. Reflect changes in the picker/library. | Desktop star and mobile action button; browser checks passed | Implemented |
| GIF-06 | GIF picker supports a new upload with progress/error feedback and server conversion. External search requires a connection. | Picker upload shares durable blob/tus processing path; provider search remains online | Implemented |
| LIB-01 | My GIFs supports All, Unsorted, folders, keyword filtering, and expanding a short initial list. | Settings implementation; picker folder mappings/tiles and real Settings/export integration | Partial verification |
| LIB-02 | Personal library supports adding files, ZIP import/export, tags, folder assignment, and removal, with permission checks and import progress/errors. | Server library; export and picker auto-favorite upload passed; full ZIP/import/quota management pending | Partial verification |
| LIB-03 | Show personal-upload usage/quota; favorited shared GIFs do not consume that upload quota. Explain unavailable conversion tools. | GIF library manager/service quota and conversion warnings; actual upload/library integration; quota/exhaustive conversion-failure matrix unverified | Implemented |

## Uploads, gallery, and playback

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| MEDIA-01 | File selection queues image uploads and creates messages, with multiple-file selection, progress, and completion feedback. | File input queues blobs, uses tus resume and atomic message acceptance; browser checks passed | Implemented |
| MEDIA-02 | Drag/drop and clipboard image paste enter the upload flow, with drop highlighting, validation, and input focus handling. | file-only nested drag depth/reset and composer highlight; shared paste/drop queue; OS clipboard/device behavior pending | Implemented |
| MEDIA-03 | Enforce configured size/type limits. Explain rejection, upload failure, processing timeout, and partial batch success. Existing transport uses resumable tus. | validation retained; stalled HEAD/POST/PATCH cancellation, timeout/resume, shutdown and offline failed-blob cleanup pass; broader quota/conversion stress pending | Partial verification |
| MEDIA-04 | Uploaded images use single-image or multi-image layouts. Opening a thumbnail shows its selected gallery item. | five-image upload comparison, matched 2+3 thumbnail rows and selected entry | Implemented |
| MEDIA-05 | Gallery supports close button, backdrop, Escape, previous/next buttons, arrow keys, swipe, and position counter. | measured smooth left/right arrow movement in Chromium/Firefox at desktop/phone widths, fit/fill and delayed cache; keyboard/close/offline; browser/system-specific motion remains outside this check | Implemented |
| MEDIA-06 | Gallery supports fit/fill, double-tap, panning, and touch drag-down dismissal. Physical-phone gesture coverage remains limited. | matching wide/tall/square cover, touch double-tap and synthetic drag-follow/cancel/close; actual phone feel pending | Implemented |
| MEDIA-07 | Gallery requests large images with medium fallback. During outages it should open locally and show an available cached variant. | large source upgrade/medium fallback and actual offline selected-image reload/decode | Implemented |
| MEDIA-08 | Uploaded videos show posters and a play overlay, then inline playback controls with compressed/original sources. | actual MP4-with-audio tus upload, local poster/play overlay, source fallbacks and native playback | Implemented |
| MEDIA-09 | External cached video/audio supports playback, titles, source links, and portrait aspect ratios. Media updates appear after server processing. | actual cache → snapshot → UI portrait/landscape/square sizing, title/poster and uninterrupted playback on reaction add/remove; MP4/WAV decode; external extraction/device codecs pending | Implemented |
| MEDIA-10 | Server services generate previews, convert media, and store media/GIFs. Unavailable media is identified explicitly; uncached bytes are unavailable offline. | Existing conversion/preview/GIF services reused; local media stays bounded and missing content explicit | Partial verification |

## Presence, unread state, and notifications

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| NOTIF-01 | Manual Online, Away, and Invisible choices affect presence. Idle sessions can auto-away; user activity restores the chosen state. | manual choices, all-session five-minute idle and restoration; matched controls | Verified |
| NOTIF-02 | Presence combines sessions. Hidden, stale, or disconnected devices must not indefinitely suppress another device's notifications. | multi-tab visibility, 30-second disconnect grace, four-hour retention/reconnect; push provider delivery not implied | Verified |
| NOTIF-03 | Explicit conversation opening marks it read. Incoming messages auto-mark read only for an eligible foreground, non-Away session. | explicit open, Away, visibility fixture and resume; session rules | Verified |
| NOTIF-04 | Read checkpoints advance only through messages actually observed. Replaying an offline read cannot clear newer unseen arrivals. | durable observed counters, offline replay, read/arrival race, write failure, migration and restart | Verified |
| NOTIF-05 | Sidebar dots/counts, mailbox totals, and supported app badges reflect unread state. Header total excludes the displayed DM. | sidebar/mailbox; page/worker Badge API and foreground/subscription refresh/reset; actual OS display pending | Partial verification |
| NOTIF-06 | Mute suppresses numeric badges, totals, sound, push, and unread-based DM promotion. Retain unread dots and underlying counts where incremented. | actual Settings mute: dots, bells, totals and title/audio; shared push policy; external delivery pending | Partial verification |
| NOTIF-07 | Rooms count arrivals for live-session users and users allowing that room's notifications. Fully expired offline muted-room users are excluded; disconnected sessions are retained for four hours. | live/retained session versus fully expired offline muted/subscribed recipients | Verified |
| NOTIF-08 | Hidden-tab arrivals increment a per-tab title count; returning foreground clears it. Lobby and other room pages use silent title updates; DM pages notify for DMs with `/notif.mp3` at volume 0.5. Use the incoming conversation's mute setting. | reference comparison of title/audio, mutes, cross-tab claims, reconnect/restart and account isolation; physical audio/OS suspension unverified | Verified |
| NOTIF-09 | Push selection respects mute rules. Online plus a visible session suppresses push; Away/Invisible can receive it. | /shared presence/visibility gates; external push delivery pending | Partial verification |
| NOTIF-10 | Push carries a short preview and destination. Click focuses/navigates an existing window or opens one. Keep it notification-only. | worker click handler and same-origin cached/uncached chat routing; synthetic focus instrumented, real OS focus/delivery pending | Implemented |
| NOTIF-11 | Installed-PWA permission prompt respects browser permission and dismissal history. Granted permission can repair subscription registration. | installed-only explicit prompt, default/denied/granted and three-dismissal rules, repair/key rotation; permission/subscription fixtures | Implemented |
| NOTIF-12 | Subscription renewal and delivery receipts are supported where the platform permits. Background execution and notification delivery depend on browser/OS support. | foreground subscription repair/key rotation; existing worker renewal/receipts retained by source inspection; real provider renewal/delivery pending | Partial verification |
| NOTIF-13 | Typing text/dots exclude self, apply to an authorized writable conversation, expire after input stops, and clear on navigation/hiding/offline. Cached typing is never replayed. | baseline comparison, expiry, private/read-only rejection and multi-tab cleanup | Verified |

For mute precedence and UI terminology, use the [Notification reference]. Confirm behavior against current code. Its historical browser-storage claims are not acceptance guarantees.

## Settings

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| SET-01 | Profile editing covers image upload/removal, display name, bio, and location with detected-location assistance. Updates appear in chat. | actual display-name/bio/location Settings update, refreshed client/mobile profile; image/detection controls retained, those combinations pending | Partial verification |
| SET-02 | Theme selection and text-size presets apply and persist. Returning to the client refreshes preferences; cached chat uses its last known preferences. | real Nord/20px Settings selection, client return and offline reload; representative themes; all presets/device combinations pending | Implemented |
| SET-03 | Login links support reveal/copy/create/replace/revoke and expiry choices, alongside optional familiar-login controls. | per-user bot-link origins and configured PublicOrigin override; circuit-based display/copy; real login-link revoke and recovery availability; reveal/create/replace/expiry/familiar-login controls; exhaustive combinations unverified | Implemented |
| SET-04 | Secret codes support reveal/copy/enable/regenerate/disable. | Settings/UserService secret-code controls; no credential-design change; full browser enable/replace/disable matrix unverified | Implemented |
| SET-05 | Active-session display counts connected tabs/circuits (including hidden tabs), excluding retained disconnected recovery records. Sign-out-other-devices preserves the current device and revokes others, including disconnected sessions. | repeated chat/Settings navigation and sibling closure; real revocation/status integration; retained recovery state and presence grace preserved | Implemented |
| SET-06 | Installation guidance and device push enable/disable remain available. Device lists show delivery information and allow individual removal/test sends. | Settings installation/push/device controls; page/worker subscription and handoff fixtures; physical installation/external delivery unverified | Implemented |
| SET-07 | Server mute supports one hour/day/week or indefinite duration. DM/room modes are Allow all, Individual, or Mute all. | duration/mode controls; real Settings mute integration and shared policy; all duration combinations unverified | Implemented |
| SET-08 | Individual channel overrides and new-DM defaults are configurable. DM default is Allow all; room default is Mute all. Overrides survive mode switching. | override/default controls and persistence; channel-mute behavior; notification rules; all mode-switch combinations unverified | Implemented |
| SET-09 | Time/date controls include timezone adjustment/detection, clock style, date order, separators, and live examples. Match timeline formatting. | resolved timezone/culture separator DTO; custom offset/date/clock fixture; full Settings combinations pending | Partial verification |
| SET-10 | My GIFs manages the personal library. Changes appear in the chat picker and message favorites. | actual Settings/export/picker upload auto-favorite and subsequent favorite visibility; full library management matrix under LIB-02 | Implemented |
| SET-11 | Debug cache view lists files/storage estimates and clears cached media without deleting drafts or outgoing work. | cache report/clear integration, IndexedDB draft/outbox preservation; friendly names updated | Verified |

## Appearance, PWA, and failure states

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| UI-01 | Chat provides responsive layouts for the timeline, sidebar, avatars, icons, menus, and composer, with configurable text sizes. | inspected profiles and Discord Dark/Nord/Tea House at large text; matched text fixtures; full visual parity remains unverified | Partial verification |
| UI-02 | Registered themes include Tea House's time-based scenes and room/DM context styling. Browser theme-color follows the active theme/scene. | representative themes; computed canvas theme-color synchronization on theme/scene/resume; theme assets retained; physical browser chrome unverified | Implemented |
| UI-03 | Branding, welcome content, room/user labels, and randomized interface text are configurable. | catalog-configured stable room headers/placeholders, offline reload; welcome/user/typing labels retained in config services | Implemented |
| UI-04 | Mobile composer, pickers, backdrops, and menus adapt to the viewport while retaining focus and caret state. Physical software-keyboard and rotation coverage remains limited. | matched responsive composer/pickers/actions, mounted local state/focus/caret/IME; physical software keyboards and rotation remain unverified | Implemented |
| UI-05 | Controls provide labels, native button/link behavior, focus placement, and supported keyboard actions. Broader accessibility coverage needs an audit. | keyboard/focus controls; link focus/underline and sampled contrast across all themes/scenes; broad accessibility audit still open | Partial verification |
| UI-06 | Prose and bot-action links have explicit theme colors, visible underlines and keyboard focus. Target at least 4.5:1 text/background contrast in normal and hover states; visited links keep the same author color. Artwork must not erase link text. | source/frozen-style comparison, actual link rendering, screenshot-sampled contrast in 11 themes/13 Tea House scenes; physical-device variants remain | Implemented |
| PWA-01 | App manifest, icons, branding, lobby shortcut, and install flow remain available. The install suggestion also appears through the bot. | credentialed branded manifest and native bot install gesture; install banner is commented out; guide hosted locally; actual OS install pending | Implemented |
| PWA-02 | First installation supports account handoff and subsequent launch routing. Token redemption requires connectivity; prepared cached launches reach the local shell. | real separate-cookie handoff, existing-cookie precedence, offline launch/token removal; token/manifest responses never cached | Implemented |
| PWA-03 | A service worker caches the application shell and selected media. Asset and local-data updates preserve drafts and outgoing work. | network-first root/handoff navigation with static offline fallback; shell v34/schema 4; immediate cached chat navigation; cache/data upgrade checks passed | Implemented |
| PWA-04 | Same-origin upgrades retain accounts/cookies, server data and routes. First online use prepares offline data. Online refresh can reach a rollback without clearing browser drafts/outbox; schema downgrade limits are in the deployment guide. | same-origin HTTPS upgrade/rollback rehearsal in Chromium/Firefox; session renewal, database/media/profile persistence, install link, offline queue, rollback/re-upgrade; actual Caddy/Cloudflare and OS installs pending | Implemented |
| ERR-01 | Connection/sync state is nonblocking: navigation, cached reading, drafts, and galleries remain usable during outages. | main client has no Blazor reconnect modal | Verified |
| ERR-02 | Empty, loading, upload-error, and unavailable-content states distinguish uncached content, connection failure, and authentication failure. | history/loading/restriction and mixed upload warning; uncached notification destination; expired auth | Implemented |
| ERR-03 | Unexpected-error recovery offers Try Again and Reload Page while preserving drafts and pending work. Failed sends offer Retry when applicable. | unexpected-error Try Again/view rebuild and Reload Page preserve draft/outbox; conditional failed-send Retry; quota/failed-upgrade stress unverified | Implemented |
| ERR-04 | In the chat client, rejected service-worker registration must not block authenticated reading or local drafts. Show that offline reload is unavailable; only advertise it after worker readiness. | normal-route client and worker rejection | Verified |

## Administration and bots

Administration uses online Blazor pages backed by the same services as chat.

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| ADMIN-01 | Admin-only room creation/editing supports names, descriptions, order, write permission, history limits, and since-signup visibility. | fresh isolated real admin creation/edit, description, write/history restriction and client return; history contracts; exhaustive ordering combinations pending | Implemented |
| ADMIN-02 | Room deletion requires confirmation and respects default-room restrictions. Open clients respond to deleted rooms and permission changes. | actual deletion confirmation/default-room protection, open member inaccessible state, live permission change and 403 write rejection | Implemented |
| ADMIN-03 | Admin pages manage users, details, sessions, theme statistics, registration/approval, and invites with notes. Account/session changes apply to connected chat clients. | real Admin entry/back/non-admin redirect and Settings session/token revocation; retained broader user/registration/invite workflows not exhaustively browser-tested | Implemented |
| ADMIN-04 | Admins configure bots, link/media previews, GIF provider policy, and the server GIF library. Relevant changes appear in chat. | Admin/config/provider/library services; configured catalog/provider fixtures and media rendering; actual external providers unverified | Implemented |
| ADMIN-05 | Admin tools expose logs, media records, visitors, diagnostics, and message generation. Session reporting includes browser chat; detailed Blazor circuit diagnostics apply only to Blazor sessions. | Admin diagnostics/log/media/generation pages; browser chat sessions use shared ChatService with IP/viewing/mobile data. Circuit latency remains specific to retained Blazor pages; full diagnostics UI audit pending | Partial verification |
| BOT-01 | Server-generated bot messages provide identity/badges, welcome DMs, installation/login guidance, and placeholder DM replies. | bot/avatar details; native bot install link gesture; existing server-generated guidance retained; wider bot scenarios pending | Partial verification |
| BOT-02 | Bot, admin, and other connected-client mutations reach chat through the shared update/recovery path. | (shared mutations); bot browser check pending | Partial verification |

## Offline behavior

Offline use requires a successful authenticated online visit and available browser storage. See the [offline behavior guide](offline-behavior.md) for prerequisites and durability limits.

| ID | Feature | Coverage and limits | Status |
| --- | --- | --- | --- |
| OFF-01 | After online setup, reload a cached room/DM while offline. Render its stored messages and metadata from the local application shell. | Cached room/DM offline reload | Verified |
| OFF-02 | Messages received for accessible inactive conversations are cached while connected. Later offline navigation includes their sidebar and sender metadata, including newly created DMs. | Inactive conversation and new-DM delivery followed by offline navigation | Verified |
| OFF-03 | Per-conversation drafts are saved locally and survive navigation, reload, disconnection, and client updates. | schema and worker update preservation | Verified |
| OFF-04 | Open/close/swipe cached images without the server. Explain missing larger variants or unfinished downloads. Message metadata alone does not imply cached media. | cached selected gallery offline reload/decode, keyboard/navigation and synthetic touch boundaries; actual phone gestures pending | Implemented |
| OFF-05 | After reconnect/resume, reconcile missed creates, edits, deletes, reactions, and metadata without duplicate or resurrected content. | bounded windows; inactive older edit/delete and in-flight invalidation reconcile before displaying cached history, including offline reload | Implemented |
| OFF-06 | Recent windows, older visited pages, and media use bounded local caches. Uncached history/media requires connectivity; budgets and eviction rules are defined in the offline behavior guide. | (last-X); budget stress unverified | Implemented |
| OFF-07 | Local data is isolated by origin and active account. Signout/Forget/account replacement purges account data; known authentication failure locks it for same-account recovery. Cached access has no elapsed-time limit, but browser eviction can remove it. | account-bound CSRF, lock/purge/queue retention; proxy URL mismatch and missing browser metadata tolerated without bypassing write antiforgery or hub authentication; 28-day online/offline PWA return and automatic token refresh checked; real OS storage retention unverified | Implemented |
| OFF-08 | Opening a push notification uses cached content or online fetch. An uncached destination explains that connectivity is needed. No push replication is required. | worker notification click/cached launch and explicit uncached-destination handling; actual OS focus/delivery remains unverified | Implemented |
| OFF-09 | Settings and Admin require online navigation. Returning to chat reconciles changed settings when connected. | real Settings preferences/cache/offline return; real channel/Admin/sidebar navigation, permissions, deletion and session/status integration | Implemented |
| OFF-10 | Upgrade cached assets and local schemas without losing drafts. Recover through authoritative snapshots after reconnect or server restart. | schema/draft/outbox evidence retained; durable-text update and package activation/recovery pass in Chromium/Firefox; quota/failed-install stress pending | Partial verification |
| OFF-11 | Queued text sends survive reload and retry with stable operation IDs. Track queued, sending, accepted, and failed internally; avoid duplicates after lost acknowledgements. Keep queued/sending/accepted messages and draft saving free of status labels, including offline. Use normal avatar/header grouping and faded pending styling; retain failed-send feedback and Retry. | concurrency, lost ack, restart, failed-send retry | Verified |
| OFF-12 | Queue replies, attachments, edits, deletes and reactions offline. Favor simple occasional-outage recovery: competing edits use the last server-accepted edit, without conflict-resolution UI or automatic merging. Preserve authorization, retry deduplication and deleted-message handling; retain failed work for retry. | actions and media queues; provider/device/stress coverage remains | Partial verification |

## Behavior details and limitations

| Area | Current behavior |
| --- | --- |
| Offline interaction | Cached chat and outgoing text/media/actions remain usable without a blocking reconnect overlay. Pending content is faded; failures retain feedback and Retry. |
| Notification mute policy | The incoming conversation's mute setting controls its count/sound. Room pages are silent; hidden DM pages can sound for unmuted DM arrivals. |
| Replies outside the recent window | Authorized target lookup can fetch and highlight an uncached reply target. Missing, deleted, or restricted targets remain unavailable. |
| Emoji and picker locality | Unicode artwork is bundled; custom artwork is cached on use, with shortcode fallback when missing. Categories and search are local; external GIF search requires connectivity. First emoji opening can stall while constructing the grid. |
| Queued changes | Editing/deleting never-attempted queued messages can wait behind an in-flight operation holding the sender lock. Retry identity stays immutable after the first attempt. |
| Network costs | Bootstrap prioritizes the active window; missing inactive windows fill in the background. Initial/first-reload artwork traffic remains large; see [measured performance and limitations](offline-network-measurements.md). |

## Regression coverage

These are the maintained checks for the corresponding feature families. Their fixtures and prerequisites are described in the [test guide](../tests/browser/README.md); existence of a test is not evidence for untested variants.

| Feature family | Checks |
| --- | --- |
| AUTH, NAV, Settings/Admin | [account integration](../tests/browser/account-integration.cjs), [interface integration](../tests/browser/interface-integration.cjs), [admin integration](../tests/browser/admin-integration.cjs) |
| INPUT, EMOJI, GIF | [composer parity](../tests/browser/composer-parity.cjs), [emoji parity](../tests/browser/emoji-parity.cjs), [GIF parity](../tests/browser/gif-parity.cjs) |
| Incremental communication | [protocol ordering](../tests/browser/sync-protocol.cjs), [nonblocking dependencies](../tests/browser/communication.cjs), [server delta contracts](../tests/OfflineContract/SyncChecks.cs). Includes bounded fan-out overflow, private-recipient isolation, concurrent coalescing and reconnect-revision contracts; the [50-client load harness](../tests/FanoutLoad/README.md) measures server fan-out. Functional checks plus [simulated network measurements](offline-network-measurements.md) against the frozen Blazor baseline; real-deployment telemetry remains unmeasured. |
| MSG, ACT, OFF | [durable sending](../tests/browser/text-sending.cjs), [reply races](../tests/browser/review-composer.cjs), [recovery races](../tests/browser/review-recovery.cjs), [message actions](../tests/browser/message-actions.cjs), [history](../tests/browser/history-interface.cjs) |
| MEDIA, UI | [gallery parity](../tests/browser/gallery-parity.cjs), [rich content](../tests/browser/rich-content.cjs), [media playback](../tests/browser/media-playback.cjs), [queued scrolling](../tests/browser/queued-scroll.cjs), [reported regressions](../tests/browser/reported-regressions.cjs), [link contrast](../tests/browser/link-contrast.cjs) |
| Presence, unread, notifications | [presence/unread](../tests/browser/presence-unread.cjs), [tab notifications](../tests/browser/tab-notifications.cjs), [snapshot notification fixtures](../tests/browser/tab-notification-snapshots.cjs) |
| PWA, upgrade and recovery | [PWA integration](../tests/browser/pwa-integration.cjs), [four-week return](../tests/browser/pwa-return.cjs), [local HTTP](../tests/browser/local-http.cjs), [worker upgrade](../tests/browser/review-worker-upgrade.cjs), [upgrade and rollback](../tests/browser/upgrade-rollout.cjs), [process restart](../tests/browser/text-restart.cjs) |
| Server authorization and persistence | [OfflineContract](../tests/OfflineContract/Program.cs), including read/checkpoint races, receipt replay, migrations, media authorization and host restart |

## Verification limits

- Physical-phone keyboards, rotation, gestures, native codecs/audio, installation, browser/PWA storage handoff and suspended execution; broader Safari, Firefox and Brave coverage.
- Real push delivery, OS notification focus/badges and subscription renewal. Browser fixtures verify logic, not OS presentation.
- Configured GIF/media providers and their failure combinations, large/interrupted uploads, full library ZIP/import/folder/quota workflows.
- Storage quota/eviction, expiry and failed-upgrade stress; full registration/invite/secret-code/settings/admin matrices; broader accessibility, themes and visual variants.
- Detailed client latency telemetry comparable to retained Blazor circuit diagnostics is not implemented. Client sessions participate in shared session reporting.
- Accepted messages are durable before recipient unread/notification side effects. A later write failure can miss an unread increment; receipt replay does not repair it. See [recovery limits](offline-behavior.md#durability-and-recovery-limits).

## Implementation references

- [Client architecture and module ownership](offline-client-architecture.md), [server types and request flow](../Yap/Offline/README.md).
- [Authentication](../Yap/Endpoints/AuthEndpoints.cs), [Settings](../Yap/Components/Pages/Settings.razor), [Admin](../Yap/Components/Pages/Admin.razor).
- [Notification rules](notification-settings-reference.md), [deployment and rollback](../GHCR-DEPLOYMENT-GUIDE.md#upgrading-yap-to-the-offline-client).

[Notification reference]: notification-settings-reference.md
