# Bootstrap and events

The client needs data from the server in two ways. At start, it needs all data at once, to draw the page. After that, it needs each change as it happens, to update the page. This page specifies the two server parts that do this.

- **The bootstrap** is one HTTP endpoint, `GET /api/bootstrap`. It returns one JSON document with every value the client needs to draw the frame: the account, the rooms, the people, the unread counts, the settings, and the configured texts.
- **The broadcaster** is one class, `ChatHubBroadcaster`. The services raise C# events when their data changes. The broadcaster listens to these events and sends one SignalR message to the clients for each event.

The JSON shapes are in the [wire contract](wire-contract.md).

## The bootstrap

### What it does

The endpoint is anonymous. It reads the principal from the cookie.

- Without a signed-in user, it returns a small document: the project name and the three text lists of the login page. The login, verify and invite pages use these texts and set them as plain text. The emoji image rules are not in this answer: they would list every custom pack to anyone who asks.
- With a signed-in user, it returns the full document. It also does three things on the side: it sets the cookie again (this extends the cookie's life, AU-18), it records the client's network address (smart login uses this, AU-09), and it records the address of the server as the client sees it (links use this, AU-15).

The endpoint asks each service for its part and puts the parts in one object. This is data mapping, not a business rule, so the code is in the endpoint and not in a service.

```cs
// Endpoints/BootstrapEndpoints.cs (sketch)
api.MapGet("/bootstrap", (HttpContext http, ClaimsPrincipal principal, UserService users, ChatService chat,
                          PresenceService presence, NotificationSettingsService mutes, GifService gifs,
                          AccessLinkService links, ServerConfig config, PushNotificationService push,
                          EmojiImages images, string? emojiStamp) =>   // as built: ServerConfig holds the texts too; emojiStamp is the query value
{
    if (principal.Identity?.IsAuthenticated != true)
        return Results.Ok(new { config = new { config.ProjectName }, texts = texts.ForLogin() });

    var me = users.ById(principal.Id())!;
    var ip = IpHelper.Get(http);
    AuthCookie.Set(http.Response, me.Token);                         // extends the cookie's life (AU-18)
    users.RecordKnownIp(me.Id, ip);                                  // smart login remembers this address (AU-09)
    links.ObserveOrigin(http.Request);                               // links use the address the client used (AU-15)

    return Results.Ok(new BootstrapDto
    {
        User = UserDto.Me(me, hasLink: links.HasActiveLink(me.Id)),
        Config = config.ForClient(push.PublicKey, gifs.ProviderInfo),   // the beacon nonce comes from the hub (BeaconNonce), which knows its connection id
        Texts = texts.All(),
        Rooms = chat.Rooms().Select(RoomDto.From),
        Users = users.All().Select(UserDto.Public),
        Presence = presence.Effective(),                             // username -> "online" or "away"; invisible people are absent
        Dms = chat.DmConversations(me.Id),
        Unread = chat.UnreadCounts(me.Id),                           // channelId -> count; only counts above zero
        Mutes = mutes.For(me.Id),
        Emoji = new(users.RecentEmojis(me.Id), chat.TopReactionEmojis(me.Id, 3)),
        FavoriteGifIds = gifs.FavoriteIds(me.Id),
        EmojiImages = images.Rules.Stamp == emojiStamp ? null : images.Rules,   // where emoji pictures come from; null: the client named the stamp of the rules it holds
    });
}).AllowAnonymous();
```

### Each part of the document and its source

| Part | Service | Content |
| --- | --- | --- |
| `user` | UserService, AccessLinkService | the signed-in account: profile, theme, text size, time zone, locale, date format, chosen status, smart-login opt-out, has a passphrase, has a login link |
| `config` | `ServerConfig`, PushNotificationService, PresenceService, GifService | project name, upload URL, upload size limit, beacon URL and a nonce, link previews on or off, media caching on or off, GIF provider, VAPID public key, build stamp, smart login allowed |
| `texts` | `ServerConfig` | every configured text list, with its fallback (GEN-12) |
| `rooms` | ChatService | every room: id, name, description, sort order, admin only, history limit, since joined, is lobby (the room `/lobby` opens, SH-43) |
| `users` | UserService | every account: username, display name, avatar, bio, location, creation date, is admin, is bot (SH-35) |
| `presence` | PresenceService | the status of every person who is online or away. Invisible people are not in the list (PR-05) |
| `dms` | ChatService | the signed-in person's direct messages that have at least one message (SH-29) |
| `unread` | ChatService | the signed-in person's unread counts that are above zero (NT-01) |
| `mutes` | NotificationSettingsService | the server mute and its end time, the DM mode, the room mode, the new-DMs bell, the per-conversation choices (NT-16) |
| `emoji` | UserService, ChatService | the 20 most recent emoji (PK-07) and the three quick reactions (MR-41) |
| `favoriteGifIds` | GifService | the ids of the person's favourite GIFs. The star on a GIF in a message uses this (MR-30) |
| `emojiImages` | EmojiImages, CustomEmojiService | where emoji pictures come from (GEN-20): the Twemoji base URL, the names of the self-hosted overrides, the custom packs with their shortcodes, and a stamp of that content. It is in the bootstrap, and not in a document of its own, because the stored copy paints before any answer: with these rules in it, no row is ever drawn with the device's own emoji font and redrawn later. The client sends the stamp it holds as `?emojiStamp=`, and the part is `null` while the rules match, so the packs do not travel on every connect. The picker's list (categories, keywords) is fixed for a build and ships with the shell as `js/data/emoji-list.js` |

### Values the client computes itself

The document does not contain these values. The client computes them from the document.

- The mailbox total. The client adds the `unread` counts of the unmuted conversations and leaves out the open conversation (SH-09).
- The app badge. The client adds the `unread` counts of the unmuted conversations (NT-11).
- Read-only. A room is read-only for the person when `room.adminOnly` is true and `user.isAdmin` is false (IB-62). The server also checks this when a message is sent and refuses with 403. The document has no `canWrite` field, and there is no `canWrite` event.
- The order of the people list (SH-30). The client sorts with `presence`, `dms`, `unread`, `mutes` and `users`.
- Display names. The client looks up each username in `users`.

### Size and storage on the client

For a server with 200 accounts, the document is some tens of kilobytes before compression and a few kilobytes after Brotli. The `users` list is the largest part. The client stores the document in IndexedDB, keyed by the account id. At the next start, the client draws the page from the stored copy first, and replaces it when the server answers. A sign-out deletes the stored copy (GEN-05).

## The broadcaster

### What it does

The services do not know about SignalR. When ChatService stores a message, it raises a C# event, `OnMessageReceived`. When PresenceService changes a person's status, it raises `OnPresenceChanged`. The broadcaster is the one class that listens to these events. For each event, it builds the hub message and sends it to the right clients.

The broadcaster is a hosted service. At start, it subscribes to every event. At stop, it unsubscribes. It stores no data.

```cs
// Endpoints/ChatHubBroadcaster.cs (sketch)
public sealed class ChatHubBroadcaster(IHubContext<ChatHub> hub, ChatService chat, PresenceService presence,
                                       UserService users, NotificationSettingsService mutes, GifService gifs,
                                       RegistrationGateService gate, MessageMapper map, ILogger<ChatHubBroadcaster> log) : IHostedService
{
    public Task StartAsync(CancellationToken ct)
    {
        chat.OnMessageReceived += m => ToChannel(m.ChannelId, "message", map.From(m));
        chat.OnMessageEdited   += m => ToChannel(m.ChannelId, "messageEdited", map.From(m));
        chat.OnMessageDeleted  += (channelId, id) => ToChannel(channelId, "messageDeleted", channelId, id);
        chat.OnReactionChanged += m => ToChannel(m.ChannelId, "reactions", m.Id, map.Reactions(m));
        chat.OnPreviewsReady   += m => ToChannel(m.ChannelId, "previews", m.Id, map.Previews(m));
        chat.OnUnreadChanged   += (userId, channelId, count) => ToUser(userId, "unread", channelId, count);
        chat.OnDmStarted       += c => ToUsers(c.ParticipantIds, "dm", DmDto.From(c));
        chat.OnRoomsChanged    += () => ToAll("rooms", chat.Rooms().Select(RoomDto.From));
        presence.OnPresenceChanged     += (username, status, kind) => ToAll("presence", username, status, kind);
        presence.OnTypingChanged       += (channelId, username, on) => ToChannel(channelId, "typing", channelId, username, on);
        presence.OnChosenStatusChanged += (userId, status) => ToUser(userId, "me", new { status });
        users.OnProfileChanged  += u => ToAll("profile", UserDto.Public(u));
        users.OnSettingsChanged += (userId, partial) => ToUser(userId, "me", partial);
        mutes.OnChanged         += userId => ToUser(userId, "me", new { mutes = mutes.For(userId) });
        gifs.OnFavoritesChanged += userId => ToUser(userId, "gifFavorites", gifs.FavoriteIds(userId));
        gate.OnPendingChanged   += () => ToUser(users.AdminId, "pending", gate.Pending());
        return Task.CompletedTask;
    }

    // A room message goes to the connections that have the room open. A direct message goes to the two
    // persons, on all their devices. The channel type decides.
    void ToChannel(Guid channelId, string name, params object?[] args)
    {
        var channel = chat.GetChannel(channelId);
        if (channel is null) return;
        var target = channel.IsDm ? hub.Clients.Users(channel.ParticipantIds.Select(id => id.ToString()).ToList())
                                  : hub.Clients.Group($"channel:{channelId}");
        Fire(target.SendCoreAsync(name, args));
    }
    void ToUser(Guid userId, string name, params object?[] args)  => Fire(hub.Clients.User(userId.ToString()).SendCoreAsync(name, args));
    void ToUsers(IEnumerable<Guid> ids, string name, params object?[] args) => Fire(hub.Clients.Users(ids.Select(i => i.ToString()).ToList()).SendCoreAsync(name, args));
    void ToAll(string name, params object?[] args)               => Fire(hub.Clients.All.SendCoreAsync(name, args));

    // The service events are synchronous. The send is not awaited. A slow client never delays a service.
    void Fire(Task send) => send.ContinueWith(t => log.LogWarning(t.Exception, "hub send failed"), TaskContinuationOptions.OnlyOnFaulted);
}
```

### Every event and its hub message

| Service event | Hub message | Receivers | Content |
| --- | --- | --- | --- |
| ChatService `OnMessageReceived` | `message` | the room's open connections, or the two DM persons; a reply in a room with a history cutoff goes per reader | the message, with the quote built for the reader (TL-05, `ToReaders`) |
| ChatService `OnMessageEdited` | `messageEdited` | same; in a room with a history cutoff only the readers who may read the message, each with their own quote (TL-05) | the message |
| ChatService `OnMessageDeleted` | `messageDeleted` | same | channel id, message id |
| ChatService `OnPinsChanged` | `pins` | same; in a room with a history cutoff each reader gets their own list (TL-05) | channel id, the pins |
| ChatService `OnReactionChanged` | `reactions` | same | message id, the reactions grouped by emoji |
| ChatService `OnPreviewsReady` | `previews` | same | message id, the link previews |
| ChatService `OnUnreadChanged` | `unread` | the one person, all devices | channel id, count |
| ChatService `OnDmStarted` | `dm` | the two persons | channel id, partner, time of the last message |
| ChatService `OnRoomsChanged` | `rooms` | everyone | the full room list |
| PresenceService `OnPresenceChanged` | `presences` | everyone | the changes of one 250 ms tick as a list of { username, status, kind (join, leave, change) } |
| PresenceService `OnTypingChanged` | `typing` | the room's open connections, or the other DM person | channel id, username, on or off |
| PresenceService `OnChosenStatusChanged` | `me` | the one person, all devices | `{ status }` |
| UserService `OnProfileChanged` | `profile` | everyone | the public profile |
| UserService `OnSettingsChanged` | `me` | the one person, all devices | the fields that changed |
| NotificationSettingsService `OnChanged` | `me` | the one person, all devices | `{ mutes }` |
| GifService `OnFavoritesChanged` | `gifFavorites` | the one person, all devices | the favourite ids |
| RegistrationGateService `OnPendingChanged` | `pending` | the admin | the waiting list |
| AccountDeletionService `OnAccountDeleted` | `accountDeleted` | everyone | the username. Clients drop the person and the direct message with them (AD-40) |
| the sign-out-others endpoint | `signedOut` | the connections of the other devices | nothing. The endpoint sends this itself, then closes those connections |

### Rules

- One service event produces one hub message. A handler never sends two messages.
- A handler reads no other service, with one exception: `ToChannel` asks ChatService whether a channel is a direct message or a room.
- `me` carries only the fields that changed. The client copies these fields into `user`, `mutes` or `emoji` in its store. Theme, text size, date format, chosen status, mutes and recent emoji all travel in `me` (ST-10, NT-22, PK-07, PR-01).
- A room message reaches only the connections that have the room open. A direct message reaches both persons on every device, whether the conversation is open or not. The sound rule (NT-13) and the tab title rule (NT-12) need this.
- The broadcaster does not await a send. The client must accept two messages in either order. Example: for one new message, `message` and `unread` can arrive in either order. `message` appends a row. `unread` sets a count. Neither depends on the other.
- The system bot does not use the broadcaster. The bot sends messages through ChatService, so they arrive as `message` events like all other messages.
- Only two classes subscribe to the service events: the bot and the broadcaster. The table above answers the question "who is informed when this data changes".

## The bootstrap and the events describe the same data

Each part of the bootstrap document has one hub message that updates it:

| Bootstrap part | Updated by |
| --- | --- |
| `rooms` | `rooms` |
| `users` | `profile` |
| `presence` | `presences` |
| `unread` | `unread` |
| `dms` | `dm` |
| `user`, `mutes`, `emoji` | `me` |
| `favoriteGifIds` | `gifFavorites` |

The client stores the bootstrap document as its state. Each hub message changes one part of that state. When the hub reconnects, the client requests the bootstrap again and replaces the whole state with the new document. Then it applies new hub messages on top. No merge logic is needed. This is the rule from the wire contract, section "Bootstrap".
