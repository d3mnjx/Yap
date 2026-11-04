# Wire contract

The contract between the vanilla JavaScript client and the ASP.NET Core server. One hub, one set of HTTP routes. This page is the reference; [the sketch](sketch.md) gives the reasons.

## Conventions

- JSON, camelCase. Times are ISO 8601 UTC strings. Ids are GUIDs as strings.
- Authentication is the `yap_auth` cookie on every request and on the hub connection. Unauthenticated: 401 (API), connection refused (hub). Non-admin on an admin route: 404.
- A refused action carries a reason the user can read. HTTP: a ProblemDetails body, `detail` is the text. Hub: the method returns `{ "error": "text" }`; `null` means success. A thrown hub exception means a bug or an unknown target; the client shows "Something went wrong" or goes to the lobby (SH-43).
- The hub is at `/hub`. The client sends `device` (its device id) as a query parameter when it connects, and `pwa=1` when it runs as the installed app (AD-05).
- Groups: `channel:{channelId}` holds the connections that have a room open. Direct messages go to the two users through `Clients.User(userId)`.
- Display names and avatars are never embedded in messages or events. The client resolves a username in its `users` directory, which the `profile` event keeps current.

## Bootstrap

`GET /api/bootstrap` returns everything the client needs to paint the frame, in one round trip. It also slides the cookie, records the known address for smart login, and observes the public origin for links.

The route is anonymous and answers both states. Without a valid cookie it returns 200 with this shape and nothing else, so the login, verify and invite pages get their texts in the same first call:

```
{ config: { projectName }, texts: { loginHeadings[], loginButtons[], loginPlaceholders[] } }
```

The client branches on the presence of `user`. The emoji image rules are not in the anonymous answer: the sign-in pages set their texts as plain text, and the rules list every custom pack.

The client fetches it **every time the hub connects**: after a sleep, after a deploy, and at start, where a device with a stored copy paints that copy first and makes no separate request before the connect. There is no second "state" route. The document replaces the shared parts of the store whole (rooms, users, presence, unread, mutes, favourites); hub events that arrive after it apply on top. Because the request is made after the hub is connected, no change can fall between the snapshot and the first event. Until the document arrives, the client shows the cached copy from the previous visit, as it does for a conversation tail (TL-02). In the same handler the client re-opens the current conversation (`openRoom` or `openDm`) and wakes the outbox sender (OF-13, TL-35).

What the client keeps across a reconnect: the view position, the draft, the pending rows, and the random texts already picked (GEN-12). What it replaces: everything in the document below.

```
{
  user:   { id, username, displayName, avatarUrl, isAdmin, theme, fontSize, timeZone, locale,
            dateFormat, status, smartLoginOptOut, hasPassphrase, hasLink, createdAt },
  config: { projectName, uploadUrl, maxUploadMB, voiceMaxSeconds, beaconUrl, linkPreviews, mediaCaching,   // voiceMaxSeconds: the recorder's cap, 300 (IB-69)
            gifProvider: { name, configured, attributionImageUrl }, vapidPublicKey, buildStamp, smartLoginAllowed,
            themes: [ { id, name, previewBg, previewAccent, hasGradient } ] },
  texts:  { roomHeaders[], placeholders[], typingOne[], typingTwo[], typingMany[], peopleHeaders[],
            joinLines[], leaveLines[], pillTexts[], loginHeadings[], loginButtons[], loginPlaceholders[] },
  rooms:  [ { id, name, description, sortOrder, adminOnly, historyLimit, sinceJoined, isLobby,     // isLobby: the room /lobby opens (SH-43); the order is the admin's (AD-33)
              pinPermission, pinners } ],                                                         // "adminOnly" | "everyone" | "selected", and the selected usernames (AD-37)
  users:  [ { username, displayName, avatarUrl, bio, location, createdAt, isAdmin, isBot } ],
  presence: { username: "online" | "away" },          // invisible people are absent
  dms:    [ { channelId, partner, lastMessageAt } ],
  unread: { channelId: count },
  mutes:  { server: { muted, until }, dmMode, roomMode, newDmsMuted, channels: { channelId: muted } },
  emoji:  { recent[], quickReactions[] },
  favoriteGifIds: [],
  emojiImages: { twemojiBase, overridesBase, overrides[],            // where emoji pictures come from (GEN-20): the device stores it with the rest,
                 packs: [ { key, name, emojis: [ { shortcode, url, keywords } ] } ],   // so the first paint never shows the device's own emoji font. The picker's
                 stamp }                                             // own list (categories, keywords) is a static module, js/data/emoji-list.js
}
```

`emojiImages` is the largest part and changes only with a deploy. The client sends the stamp of the rules it holds as `?emojiStamp=`, and the server answers `emojiImages: null` while they match; the client keeps its copy. A request without a stamp (the first start of a device, the tests) gets the rules.

## Hub methods (client to server)

The client calls the methods with these camelCase names; SignalR matches the server's PascalCase methods without regard to case.

| Method | Arguments | Returns | Notes |
| --- | --- | --- | --- |
| `openRoom` | channelId | `Conversation` | Leaves the previous group, joins `channel:{id}`, marks read (TL-03), records Viewing. |
| `openDm` | username | `Conversation` | Creates the DM channel when needed. The result carries `channelId`. |
| `leave` | | | On the way out of a conversation, to Settings, Admin or another page. Clears Viewing. |
| `older` | channelId, beforeTimestamp, beforeId | `{ messages[], hasMore }` | Next 50 before the oldest loaded message (TL-06). The server finds the cursor by id and falls back to the timestamp when that message was deleted. History limits apply (TL-05). |
| `around` | channelId, messageId | `{ messages[], hasMore, hasNewer, error }` | The jump to a pinned message or a reply quote (SH-49, MR-34, TL-41): 25 messages before the target, the target, and 24 after it, inside the reader's history limit (TL-05). `hasNewer` false: the window reaches the newest message, and the client treats it as a tail. A refusal comes in `error` with an empty list: "Too old to load" for a pin whose message is not in memory (SH-48), "Message not found." for an unknown id or one behind the history limit. No group join: the client reads the conversation already. |
| `markRead` | channelId | | The client decides by NT-06 and NT-07. Clears the whole conversation (NT-08). Dropped for a conversation the person cannot access. |
| `typing` | channelId, on | | `on` at the first non-blank input and then at most every 2 s; `off` by IB-59. Dropped unless `channelId` is the connection's open conversation (Viewing): a typist shows only to the people who share the conversation (PR-19). |
| `heartbeat` | visible, idleSeconds, lastRttMs, samples[] | serverTimeMs | Every 10 s visible, 60 s hidden. A sample is `{ name, ms }`; the name is send, open, older, start, reconnect or jump. A hidden tab sends no lastRttMs. Feeds presence and the latency table (AD-25, AD-26). |
| `beaconNonce` | | nonce or null | The single-use nonce for the IPv4 beacon of this connection, asked for when the bootstrap names a beacon URL. The hub mints it because a client that skips the negotiate step does not know its connection id. |
| `reportLoad` | { html, scripts, bootstrap, paint, socket, rows, protocol, requests, cached, bytes, hidden } | | Once per page load, from the first conversation of the load when the server's rows are on screen. The six phases are ms from the navigation start; a phase the load did not reach is null. The counts are same-origin files, the page included. Feeds the load-time table (AD-41). |
| `setStatus` | "online" \| "away" \| "invisible" | | Account-wide (PR-01). |
| `react` | messageId, emoji | error | Toggle (MR-40). Also updates recent emoji (MR-44). |
| `edit` | messageId, text | error | Own text rows only (MR-57). |
| `delete` | messageId | error | Own rows only (MR-64). |
| `pin` | channelId, messageId | error | Up to three per conversation, the newest first (MR-77, MR-78). Both people of a DM; in a room the admin, or whoever the room's pin setting allows (AD-37). Also stores a system line in the conversation, sent as a `message` with `kind: "pin"`: it counts for nobody and sends no push (MR-80). |
| `unpin` | channelId, messageId | error | The same rights. The channel id is named because the message may be older than the ones in memory. |
| `emojiUsed` | emoji | | A pick in the composer picker (IB-44, PK-07). |

`Conversation`:

```
{ channelId, messages: Message[50], hasMore, restricted, typists: [username], pins: Pin[] }
```

## Hub events (server to client)

| Event | Payload | To | When |
| --- | --- | --- | --- |
| `message` | `Message` | room group, or both DM users | A new message. `clientId` is on every copy; only the sender has a pending row that matches it. A reply in a restricted room goes per reader: the quote of an original before a reader's cutoff says unavailable, with no text and no name (TL-05). |
| `messageEdited` | `Message` | same | In a room with a history cutoff (TL-05) the event goes to the readers who may read the message, each with the quote built for them; a direct message and an unrestricted room get one send. |
| `messageDeleted` | channelId, messageId | same | |
| `pins` | channelId, pins[] | same | After a pin, an unpin, or an edit or a delete of a pinned message (SH-48). In a restricted room each reader gets the pins inside their own cutoff (TL-05). |
| `reactions` | messageId, reactions[] | same | After a toggle. Readers inside the cutoff only, in a restricted room (TL-05). |
| `previews` | messageId, previews[] | same | A link card or a cached media player is ready (MR-22, MR-23). Readers inside the cutoff only, in a restricted room (TL-05). |
| `typing` | channelId, username, on | the connected, visible tabs with the conversation open (Viewing), minus the typist's own | The client drops a typist 3.5 s after the last `on`. A hidden tab or another conversation gets nothing: it could not show the strip. |
| `presences` | a list of { username, status: "online" \| "away" \| "offline", kind: "join" \| "leave" \| "change" } | all | The changes of one 250 ms tick, in order; one broadcast per tick however many people changed. Invisible is sent as offline (PR-05). Offline after the 5 min grace (PR-16). The client derives join and leave lines from the kinds (MR-73). |
| `profile` | `User` | all | A new account, or a display name, avatar, bio or location changed (ST-07, SH-33). |
| `accountDeleted` | username | all | The admin deleted the account (AD-40). The client drops the person from `users` and `presence`, and the direct message with them from `dms` and `unread`. |
| `rooms` | rooms[] | all | Created, updated, reordered or deleted (SH-25). The client leaves a deleted open room (TL-21) and derives read-only from `adminOnly` and `user.isAdmin` (IB-62). |
| `unread` | channelId, count | user | After a send or a read on any device (NT-01). Batched: the broadcaster keeps the latest count per person and conversation and sends it at most every 250 ms, so a busy room moves the badge in steps and a tab gets at most four counts a second per conversation. |
| `dm` | `{ channelId, partner, lastMessageAt }` | both users | A direct message got its first message. Opening an empty DM sends nothing (SH-29). |
| `me` | partial `user` + partial `mutes` + `emoji` | user | Theme, text size, date format, status, mutes or recent emoji changed on any device (ST-10, NT-22). |
| `gifFavorites` | favoriteGifIds[] | user | A star changed anywhere (PK-36). |
| `signedOut` | | user's other devices; every connection of a deleted account | Token rotated by "Sign out all other devices" (AU-20), or the admin deleted the account: each of its connections gets the event before the delete (AD-40). The connection is closed after the event. |
| `pending` | pending[] | admins | A registration request arrived or was decided (AD-11). |
| `gifImport` | `{ importId, actorUserId, serverTarget, done, total, skippedOrFailed, completed, error }` | the importer | Progress of a GIF zip import (ST-22). |

## Shapes

```
Message {
  id, channelId, clientId?, username, text, timestamp, edited,
  kind: "pin" | null,   // null: a message. "pin": a stored system line "{name} pinned a message" (MR-80); username is the pinner, replyTo names the pinned message, text is empty
  replyTo: { id, username, text, hasMedia, voice } | { id, unavailable: true } | null,   // voice: the original is a voice message, quoted as "Voice message" (MR-32)
  images:  [ { medium, large, width, height } ],   // width, height: the medium picture's pixels, read from the file; null when it is gone. The row's box before the load
  videos:  [ { poster, src, width, height } ],     // the poster's pixels; null without a poster
  gifs:    [ { entryId, src, isImage, width, height, uploader } ],
  voice:   { src, durationMs, peaks } | null,       // MR-76. peaks: a string, one base-36 digit per bar, as the recorder measured them
  reactions: [ { emoji, users: [username] } ],      // in first-use order (MR-38)
  previews:  [ { url, siteName, title, description, imageUrl,
                 media?: { type, src, poster, width, height, durationSeconds } } ]
}

Pin {   // a copy of what the panel shows, stored with the channel; it outlives the startup load window (SH-48)
  messageId, username, text, timestamp, media, pinnedBy, pinnedAt
  // media: [ { kind, src, poster, width, height, title, site, durationMs, peaks, large, original, isImage, url } ], in
  // the row's order. kind: image (src: the medium picture; large, original: the viewer's stage and Download, TL-24),
  // gif (src: an image file when isImage, else a video file to loop; no src when the file is gone), video (src, poster:
  // an upload, or a cached link video with title, site and url), link (poster, title, site, url of the first link
  // card), voice (src, durationMs, peaks: what the row's player draws). A copy made before 2026-11-04 has no original,
  // isImage or url, and an image-file GIF there has kind image; a server start gives its pictures the large URL. Resolved when the pin is made; an edit,
  // or a link card that arrives later, updates it; a server start resolves the pins of messages in memory again.
  // Channel rows written before 2026-10-23 hold one object or null here: the server reads it as a list of one or none.
}
```

## HTTP routes

Kept routes keep their exact behaviour; their contracts are in the current code. New routes are marked (new).

### Shell and static

| Route | Purpose |
| --- | --- |
| `GET /`, `/lobby`, `/room/{id}`, `/dm/{user}`, `/settings`, `/admin`, `/channel/new`, `/channel/{id}/settings`, `/login`, `/verify/{user}`, `/invite/{code}` | `index.html` with the build stamp injected (new). `/` serves `Data/welcome/welcome.html` to a signed-out visitor when the welcome page is enabled. |
| `GET /manifest.webmanifest`, `GET /pwa-launch` | kept |
| static: `/uploads`, `/gif-cache`, `/media-cache`, `/custom-emojis`, `/emoji-packs`, `/welcome-content`, branding overrides | kept |

### Sign-in

All anonymous except sign-out. The reasons behind each are on the [sign-in page](sign-in.md).

| Route | Purpose |
| --- | --- |
| `GET /api/auth/check?username=` | `{ state: "invalid" \| "free" \| "closed" \| "pending" \| "smart" \| "verify" \| "guide", reason? }` (new). |
| `POST /api/auth/signin` `{ username, code? }` | New account, smart login, or code. 200 `{ username }` with the cookie. 202 `{ state: "pending" }` when approval is required: the request is on the admin's list and the client polls `pending`. 4xx with a reason (new). A 202 also sets the `yap_pending` cookie, the token of this browser's request; only this browser turns the admin's approval into an account (AU-05). |
| `GET /api/auth/pending/{username}` | `{ state: "waiting" \| "approved" \| "rejected" }`, polled by the login page (new). Answers for the browser that holds the request's cookie; any other browser sees `waiting`, whatever the decision. |
| `GET /api/invite/{code}` | `{ state: "join" \| "continue" \| "self" \| "switch" \| "invalid" \| "busy", owner?, current? }` (new). `self`: signed in as the owner, the client opens the lobby. Counts a miss. |
| `POST /api/invite/{code}` `{ username? }` | Redeems an invite or a login link. 200 with the cookie (new). |
| `POST /api/auth/signout` `{ pushEndpoint?, deviceId? }` | Clears the cookie and sets the sign-out mark (a second cookie; `/pwa-launch` does not redeem a token while it is there, AU-22), removes the device's push subscription, ends the hub connections of `deviceId` (new). |
| `GET /pwa-launch`, `GET /manifest.webmanifest` | kept |
| `GET /auth/signin`, `POST /auth/signin`, `GET /auth/signout`, `POST /auth/invite`, `GET /auth/refresh-token` | removed; Blazor workarounds for setting a cookie by navigation |

### Bootstrap and account

| Route | Purpose |
| --- | --- |
| `GET /api/bootstrap` | Anonymous. The full document with a cookie, the texts-only shape without. Fetched on every hub connect, and at start only when the device has no stored copy. The beacon nonce comes from the hub (`beaconNonce`), not from here. |
| `PATCH /api/account` | Display name, bio, location, theme, fontSize, timeZone, locale, dateFormat, smartLoginOptOut (new). |
| `PUT /api/account/avatar` (multipart), `DELETE /api/account/avatar` | (new) |
| `GET /api/account/location` | Country suggestion from the address; 204 when unknown (new). |
| `GET /api/account/locale-options` | `{ dateOrders[], clocks[], cultures[{ name, nativeName }], current: { order, clock, culture } }`: the Time & Date cards in the language's order (ST-19, ST-20) (new). |
| `GET /api/account/devices?device=` | One row per device, tabs share a row; `device` marks the caller's row as current (AU-19) (new). |
| `POST /api/account/devices/sign-out-others` `{ deviceId, pushEndpoint? }` | Rotates the token, keeps this device's cookie and push subscription (AU-20) (new). |
| `GET /api/account/link`, `POST /api/account/link`, `DELETE /api/account/link`, `PUT /api/account/link/expiry` | Login link (AU-11): the current one with its code and URL, a new one, revoke, expiry (new). The `url` carries `ChatSettings:PublicOrigin`, or else the address this person's own requests used; another person's Host header never reaches it (AU-15). |
| `GET /api/account/passphrase`, `POST /api/account/passphrase`, `DELETE /api/account/passphrase` | Secret code (AU-13, retired): reveal, replace an existing code (410 for an account without one), disable (new). |
| `PUT /api/account/mutes` | Server mute with duration, DM and room modes, new-DMs bell, one channel (NT-16..22) (new). |

### Messages and media

| Route | Purpose |
| --- | --- |
| `POST /api/channels/{id}/messages` | `{ clientId, text?, replyToId?, images?, videos?, gifs?: [ { entryId } \| { provider: {...}, searchText } ], voice?: { url, durationMs, peaks } }` → 200 `Message` as soon as it is in memory; the database write is queued, not awaited. Idempotent on `(user, clientId)` for one day; a second post while the first is still being stored gets 409 and the client tries again later. The `message` hub event can arrive before this response; the client treats both as the same confirmation (new). `replyToId` must name a message of the same conversation; another conversation's message is refused with 400 (GEN-04). A `provider` item must be one this server showed in a recent search or trending answer; the server sends its own copy of the item and never the client's URLs (PK-20). See [Message path](message-path.md). |
| `POST /api/dm/{username}/messages` | The same body and answer; the server finds or creates the direct message with `username` (404 for an unknown name). The outbox addresses a direct message by its partner, because a conversation never opened on the device has no channel id (OF-08) (new). |
| `/api/tus`, `GET /api/tus/info/{id}` | kept. An upload in progress answers its creator only (another person's HEAD, PATCH or DELETE gets 404); an unfinished upload expires a day after its last chunk. The info route needs the cookie and answers the uploader once, with `{ url, type }` and no server path (new). An upload with the metadata `kind: voice` is transcoded to `.m4a`: the answer is `{ type: "voice", url, durationMs }`, or `{ type: "error", error }`. Without ffmpeg the create is refused with 400 "Voice messages are unavailable on this server (ffmpeg missing)" (IB-71). |
| `GET /api/ipv4-beacon` | kept |

### GIFs

| Route | Purpose |
| --- | --- |
| `GET /api/gifs/recent`, `/favorites`, `/server` | The picker tabs (PK-16, PK-32, PK-37). Favorites and server return `{ folders[], gifs[] }` (new). |
| `GET /api/gifs/trending?cursor=`, `GET /api/gifs/search?q=&cursor=` | Provider pages of 30 (PK-18, PK-24, PK-28). Trending returns `{ items[], nextCursor }`; search returns `{ library[], provider[], nextCursor }`; the provider list is empty without a provider or when it does not answer (PK-29, PK-31) (new). |
| `PUT /api/gifs/{id}/favorite` `{ on, folder? }` | Star, unstar, or file into a folder (PK-21, PK-34) (new). 404 for an entry the person may not use: another person's upload that was never sent in a conversation and never starred by the person (the search rule). The same rule applies to a send by `entryId`. |
| `PUT /api/gifs/{id}/tags` `{ tags[] }` | The uploader of an own upload, or the admin; 404 for everyone else (new). |
| `DELETE /api/gifs/{id}` | Own upload (ST-24). 200 with a note when the GIF is still used and was only unstarred (new). |
| `GET /api/gifs/library` | My GIFs: `{ folders[], gifs[], usedBytes, quotaBytes }` (ST-21) (new). |
| `GET /api/gifs/export`, `GET /api/admin/gifs/export` | kept |

A GIF card: `{ id, preview, src, isImage, width, height, favorite, folder, tags[], isServer, serverFolder, uploader, mine, sizeBytes }`.

### Push

| Route | Purpose |
| --- | --- |
| `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/delivered` | kept. An endpoint must be an https URL and belongs to the account that registered it: a second account gets 409 on subscribe and 404 on unsubscribe, and a sign-out removes the account's own endpoint only. |
| `GET /api/push/devices`, `DELETE /api/push/devices` `{ endpoint }`, `POST /api/push/test` | Settings device list `{ endpoint, platform, addedAt, deliveredAt }[]`, Remove, test send returning `{ sent, failed, total }` (ST-17, NT-30) (new). |

### Rooms (admin)

| Route | Purpose |
| --- | --- |
| `POST /api/rooms`, `PATCH /api/rooms/{id}`, `DELETE /api/rooms/{id}`, `POST /api/rooms/{id}/move` `{ up }` | AD-29..35, AD-37 (new). The POST and PATCH body is `{ name, description?, adminOnly, historyLimit?, sinceJoined?, pinPermission?, pinners? }`. `pinPermission` and `pinners` are optional: on a PATCH, a missing one leaves the room's value unchanged, so a tab on an older build that sends neither keeps the pin setting (SH-50). A POST without `pinPermission` starts the room with `adminOnly`. A missing `historyLimit` or `sinceJoined` means `oneMonth` and `true`, on a PATCH too. |

### Admin

All behind the admin policy: 404 to everyone else. Reads compose from the services; actions call one service each.

| Route | Purpose |
| --- | --- |
| `GET /api/admin/users` | `{ users[], themes[], total }`: every account with its id, with its status pill (online, away, invisible, offline), PWA, created, last action, zone and locale, recent addresses with countries; the themes in order of use (AD-04, AD-07). Read when the page loads (GEN-22). |
| `GET /api/admin/users/{username}` | `{ pushSubscriptions, pwaInstalledAt, theme, ips[], userAgents[] }` (AD-05). |
| `GET /api/admin/inactive?days=N` | AD-39. `{ users: [ { username, displayName, avatarUrl, lastActiveAt } ] }`, oldest first. `days` defaults to 90, at least 1. Not under `/users/`, so a person named "inactive" keeps their detail route. |
| `POST /api/admin/users/delete` `{ usernames }` | AD-38 to AD-40. One route for one account and for the sweep. A refusal (the admin, the bot) stops the request before anything is deleted, 400 with the reason; a name that is gone already is skipped. Each connection of the account gets `signedOut` first. Answers `{ deleted }`. |
| `POST /api/admin/generate` `{ channelId, count, hours }` | AD-08. Test messages add no unread counts. |
| `GET /api/admin/bot`, `PUT /api/admin/bot` `{ displayName?, welcomeMessage?, phoneMessage?, linkMessage? }` | AD-09. The GET answers `{ username, displayName, avatarUrl, customAvatar, serverName, welcomeMessage, phoneMessage, linkMessage }`. On the PUT a missing part keeps its text; a display name has at most 32 characters and each part at most 1000 (400 otherwise). |
| `PUT /api/admin/bot/avatar` (multipart `file`), `DELETE /api/admin/bot/avatar` | AD-09. The PUT answers `{ avatarUrl }`, or 400 "Choose an image up to 10 MB"; the DELETE brings the default picture back (204). |
| `GET /api/admin/settings`, `PUT /api/admin/settings` `{ registrationClosed?, requireApproval?, smartLogin?, linkPreviews?, mediaCaching?, gifRating? }` | AD-10, AD-12, AD-13, AD-14. The GET carries `persistence`, `mediaCachingAvailable`, the deployment values and the pending list. |
| `POST /api/admin/pending/{username}/approve`, `.../reject` | AD-11. The pending list arrives in the settings answer; the admin's connections also receive the `pending` hub message. |
| `GET /api/admin/links`, `POST /api/admin/links` `{ userId?, note?, expiresAt? }`, `DELETE /api/admin/links/{id}`, `PUT /api/admin/links/{id}/expiry` | AD-15 to AD-17. `{ open[], users[] }`; a code shows only while the admin may see it. |
| `GET /api/admin/logs`, query `action`, `user`, `skip` (all optional) | AD-18. `{ available, rows[] }`, 100 rows a page; `available` is false without persistence (AD-03). |
| `GET /api/admin/media`, query `type`, `user`, `skip` | AD-19. `{ available, stats, rows[] }` with the preview and the link per row. |
| `DELETE /api/admin/media/{id}?force=true` | AD-19. 200 `{ bytes }`. Without `force`, an upload that a message still shows answers 409 "Used in {n} messages.", and the page asks the admin; 400 "Not an upload.", 404 "Upload unknown". A GIF row goes the GIFs tab's way (AD-23): out of every library, its file kept while a message shows it. |
| `GET /api/admin/media/unreferenced?database=bool`, `POST /api/admin/media/prune` `{ database }` | AD-19. The count `{ files, bytes, recent }` and the delete `{ files, bytes }` of the uploads no message shows. `recent` counts the uploads of the last hour, which are kept. `database: true` scans the whole saved history, not only the messages in memory (AD-03). |
| `GET /api/admin/visitors`, query `action`, `skip` | AD-20. `{ available, stats, rows[] }` with the country and the readable reason. |
| `GET /api/admin/status` | `{ proxy: { trusted[], untrustedPeer, forwardedFor, firstSeenAt, count } }`: the standing notices of the admin page; today the proxy that is not in TrustedProxies (new). |
| `GET /api/admin/gifs`, `PUT /api/admin/gifs/{id}/server` `{ on, folder? }`, `DELETE /api/admin/gifs/{id}` | AD-21 to AD-23. The table with stats and server folders; the force delete answers with the note the spec names. |
| `GET /api/admin/gifs/export` | kept |
| `GET /api/admin/diagnostics` | AD-24 to AD-28: `{ latest, series[], sessions[], recentlyClosed[], push: { keyStatus, detail, decisions[], results[] }, unread[], writer: { enabled, depth, lastError, lastErrorAt }, events }`. Replaces `/api/diagnostics` and `/api/diagnostics/circuits`. |
| `GET /api/admin/load?seconds=&step=` | AD-24. `{ latest, series[] }`: one-second samples of the process (CPU, memory, GC, thread pool, hub rates, writer depth), up to an hour (`seconds`, default 60). `step` (1 to 60, default 1) averages them into buckets of that many seconds; `latest` is always the real last second. |
