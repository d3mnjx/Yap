using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Yap.Models.Accounts;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Admin;
using Yap.Services.Chat;
using Yap.Services.Gifs;
using Yap.Services.Notifications;
using Yap.Services.Presence;

namespace Yap.Endpoints;

/// <summary>
/// Listens to the services' events and sends one hub message for each. The services know nothing about
/// SignalR. A room event goes to the connections that have the room open; a direct message goes to the two
/// people on every device; presence, rooms and profiles go to everyone. The table is in
/// docs/architecture/bootstrap-and-events.md.
/// </summary>
public sealed class ChatHubBroadcaster(IHubContext<ChatHub> hub, ChatService chat, PresenceService presence, UserService users,
    NotificationSettingsService mutes, GifService gifs, RegistrationGateService gate, SystemBotService bot, AccountDeletionService deletion,
    MessageMapper map, LoadCounters load, ILogger<ChatHubBroadcaster> log) : IHostedService
{
    private readonly List<Action> _unsubscribe = [];

    // The latest unread count per person and channel, sent four times a second at most. A room message raises the
    // count of every recipient, and sending each raise at once meant one hub call per recipient per message: 9,000 a
    // second at 1,000 users on the 2026-10-18 load test, most of the hub-send rate. The badge is a number, and the
    // latest number is all a tab needs. A markRead's zero goes through the same key, so a stale count cannot
    // overtake it. The wire event stays `unread(channelId, count)`; the client does not know the difference.
    private static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(250);
    private readonly ConcurrentDictionary<(Guid User, Guid Channel), int> _unread = new();

    // The presence changes of one tick go out as one list to everyone. A crowd changes several times a second,
    // and each change was a broadcast to every connection: a wave of 70 a second at 1,500 connections wrote
    // 105,000 frames a second on the 2026-10-18 load test (run 3, the idle rule five minutes after the ramp).
    // A queue, not a dictionary: a person who leaves and comes back inside a tick is two changes, in order.
    private readonly ConcurrentQueue<PresenceDto> _presence = new();
    private readonly CancellationTokenSource _stopping = new();
    private Task? _unreadLoop;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // A new message is inside everyone's history; only the quote of a reply can differ between readers (TL-05).
        On<ChatMessage>(h => chat.OnMessageReceived += h, h => chat.OnMessageReceived -= h, m =>
        {
            if (m.ReplyToMessageId is null) ToChannel(m.ChannelId, "message", map.From(m, null));
            else ToReaders(m, "message", viewer => [map.From(m, viewer)]);
        });
        On<ChatMessage>(h => chat.OnMessageEdited += h, h => chat.OnMessageEdited -= h, m => ToReaders(m, "messageEdited", viewer => [map.From(m, viewer)]));
        On<Guid, Guid>(h => chat.OnMessageDeleted += h, h => chat.OnMessageDeleted -= h, (channelId, id) => ToChannel(channelId, "messageDeleted", channelId, id));
        On<ChatMessage>(h => chat.OnReactionChanged += h, h => chat.OnReactionChanged -= h, m => ToReaders(m, "reactions", _ => [m.Id, map.Reactions(m)]));
        On<ChatMessage>(h => chat.OnPreviewsReady += h, h => chat.OnPreviewsReady -= h, m => ToReaders(m, "previews", _ => [m.Id, chat.Previews(m)]));
        On<Guid, Guid, int>(h => chat.OnUnreadChanged += h, h => chat.OnUnreadChanged -= h, (userId, channelId, count) => _unread[(userId, channelId)] = count);   // sent by the tick
        _unreadLoop = SendBatchesAsync(_stopping.Token);
        On<Channel>(h => chat.OnDmStarted += h, h => chat.OnDmStarted -= h, DmStarted);
        On(h => chat.OnRoomsChanged += h, h => chat.OnRoomsChanged -= h, () => ToAll("rooms", chat.Rooms().Select(RoomDto.From).ToList()));
        On<Channel>(h => chat.OnPinsChanged += h, h => chat.OnPinsChanged -= h, c => ToViewers(c, "pins", viewer => [c.Id, chat.PinsFor(c.Id, viewer)]));   // SH-48

        On<string, EffectiveStatus, PresenceChange>(h => presence.OnPresenceChanged += h, h => presence.OnPresenceChanged -= h,
            (username, status, change) => _presence.Enqueue(new PresenceDto(username, status, change)));   // sent by the tick, in order
        On<Guid, string, bool>(h => presence.OnTypingChanged += h, h => presence.OnTypingChanged -= h,
            (channelId, username, on) => ToWatching(channelId, username, "typing", channelId, username, on));
        On<Guid, UserStatus>(h => presence.OnChosenStatusChanged += h, h => presence.OnChosenStatusChanged -= h,
            (userId, status) => ToUser(userId, "me", new { status }));

        On<User>(h => users.OnProfileChanged += h, h => users.OnProfileChanged -= h,
            u => ToAll("profile", UserDto.From(u, users.IsAdmin(u.Id), bot.IsBotUser(u.Username))));
        On<Guid, object>(h => users.OnSettingsChanged += h, h => users.OnSettingsChanged -= h, (userId, partial) => ToUser(userId, "me", partial));
        On<string>(h => deletion.OnAccountDeleted += h, h => deletion.OnAccountDeleted -= h, username => ToAll("accountDeleted", username));   // AD-40
        On<Guid, List<string>>(h => users.OnRecentEmojiChanged += h, h => users.OnRecentEmojiChanged -= h,
            (userId, recent) => ToUser(userId, "me", new { emoji = new { recent, quickReactions = chat.QuickReactions(userId) } }));   // MR-41
        On<Guid>(h => mutes.OnChanged += h, h => mutes.OnChanged -= h, userId => ToUser(userId, "me", new { mutes = mutes.For(userId) }));
        On<Guid>(h => gifs.OnFavoritesChanged += h, h => gifs.OnFavoritesChanged -= h, userId => ToUser(userId, "gifFavorites", gifs.GetFavorites(userId).Select(e => e.Id).ToList()));
        On(h => gate.OnPendingChanged += h, h => gate.OnPendingChanged -= h, () =>
        {
            if (users.GetAdminUserId() is { } admin)
                ToUser(admin, "pending", gate.GetPendingUsers().Select(p => new PendingDto(p.Username, p.RequestedAt)).ToList());
        });
        On<GifImportProgress>(h => gifs.OnImportProgress += h, h => gifs.OnImportProgress -= h, p => ToUser(p.ActorUserId, "gifImport", p));   // ST-22
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _stopping.Cancel();
        if (_unreadLoop is not null) await _unreadLoop;
        // The list is taken under a lock, and the handlers go after it. The stop can run two times at once: under
        // the test host 3 class clean-ups in 120 failed here with "Collection was modified", and the only other
        // writer of the list after the start is the Clear of this method.
        Action[] offs;
        lock (_unsubscribe) { offs = [.. _unsubscribe]; _unsubscribe.Clear(); }
        foreach (var off in offs) off();
    }

    // The two batches of a tick: the latest unread counts, one call per person and channel, and the presence
    // changes of the tick, one call to everyone.
    private async Task SendBatchesAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(Tick);
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                // Remove, then send: a count written between the two lands in the next tick, never lost.
                foreach (var key in _unread.Keys)
                    if (_unread.TryRemove(key, out var count)) ToUser(key.User, "unread", key.Channel, count);
                var changes = new List<PresenceDto>();
                while (_presence.TryDequeue(out var change)) changes.Add(change);
                if (changes.Count > 0) ToAll("presences", changes);
            }
        }
        catch (OperationCanceledException) { }   // StopAsync: the hub goes down with us, and a tab bootstraps its counts on reconnect
    }

    // Each person gets their own partner name, so the same event becomes two messages.
    private void DmStarted(Channel c)
    {
        var at = DateTime.UtcNow;
        if (c.Participant1Id is { } p1 && c.Participant2 is { } n2) ToUser(p1, "dm", new DmDto(c.Id, n2, at));
        if (c.Participant2Id is { } p2 && c.Participant1 is { } n1) ToUser(p2, "dm", new DmDto(c.Id, n1, at));
    }

    // A room message goes to the connections that have the room open. A direct message goes to the two
    // people, on all their devices. The channel type decides.
    private void ToChannel(Guid channelId, string name, params object?[] args)
    {
        var channel = chat.GetChannel(channelId);
        if (channel is null) return;
        var target = channel.IsDirectMessage
            ? hub.Clients.Users(new[] { channel.Participant1Id, channel.Participant2Id }.OfType<Guid>().Select(id => id.ToString()).ToList())
            : hub.Clients.Group(ChatHub.Group(channelId));
        Fire(target.SendCoreAsync(name, args));
    }

    // A room with a history cutoff (TL-05) has a different past for each reader: an event about a message goes to
    // the connections whose person may read that message, with the arguments built for that person (the quote of
    // a reply). A direct message and an unrestricted room have one truth for everyone and get one send.
    private void ToReaders(ChatMessage m, string name, Func<Guid?, object?[]> argsFor)
    {
        if (chat.GetChannel(m.ChannelId) is { } channel) ToViewers(channel, name, argsFor, viewer => chat.MayRead(viewer, m));
    }

    // The per-person send behind ToReaders. The pins of a restricted room also differ by reader, but every reader
    // hears that they changed: each person's arguments carry their own list, so that send has no reads filter.
    private void ToViewers(Channel channel, string name, Func<Guid?, object?[]> argsFor, Func<Guid, bool>? reads = null)
    {
        if (!chat.IsRestricted(channel)) { ToChannel(channel.Id, name, argsFor(null)); return; }
        foreach (var person in presence.All().Where(s => s.Connected && s.Viewing == channel.Id).GroupBy(s => s.UserId))
        {
            if (reads is not null && !reads(person.Key)) continue;
            Fire(hub.Clients.Clients(person.Select(s => s.ConnectionId).ToList()).SendCoreAsync(name, argsFor(person.Key)));
        }
    }

    // The tabs that show the conversation right now: connected, visible, with it open. A hidden tab or a tab on
    // another conversation cannot draw the typing strip, and the client drops the event anyway (store.setTyping).
    // On the 2026-10-18 load test 70 % of 1,000 users were hidden tabs, so one typist's event wrote to 1,000
    // connections for the 300 that could show it, 12,000 writes a second in all. The typist's own tabs are left
    // out too: the client ignores its own name. One send call, so the message is serialized once.
    private void ToWatching(Guid channelId, string typist, string name, params object?[] args)
    {
        var connections = presence.All().Where(s => s.Connected && s.Visible && s.Viewing == channelId && s.Username != typist).Select(s => s.ConnectionId).ToList();
        if (connections.Count > 0) Fire(hub.Clients.Clients(connections).SendCoreAsync(name, args));
    }

    private void ToUser(Guid userId, string name, params object?[] args) => Fire(hub.Clients.User(userId.ToString()).SendCoreAsync(name, args));

    private void ToAll(string name, params object?[] args) => Fire(hub.Clients.All.SendCoreAsync(name, args));

    // The service events are synchronous. The send is not awaited, so a slow client never delays a service.
    private void Fire(Task send)
    {
        load.HubSend();   // one per send call, not per recipient: the admin load card shows the fan-out rate
        send.ContinueWith(t => log.LogWarning(t.Exception, "A hub send failed"), TaskContinuationOptions.OnlyOnFaulted);
    }

    // Subscribe now, remember how to unsubscribe at stop.
    private void On(Action<Action> add, Action<Action> remove, Action handler) { add(handler); _unsubscribe.Add(() => remove(handler)); }
    private void On<T>(Action<Action<T>> add, Action<Action<T>> remove, Action<T> handler) { add(handler); _unsubscribe.Add(() => remove(handler)); }
    private void On<T1, T2>(Action<Action<T1, T2>> add, Action<Action<T1, T2>> remove, Action<T1, T2> handler) { add(handler); _unsubscribe.Add(() => remove(handler)); }
    private void On<T1, T2, T3>(Action<Action<T1, T2, T3>> add, Action<Action<T1, T2, T3>> remove, Action<T1, T2, T3> handler) { add(handler); _unsubscribe.Add(() => remove(handler)); }
}

/// <summary>One presence change in a `presences` batch: the status is "online", "away" or "offline", the kind "join", "leave" or "change" (wire-contract.md).</summary>
public sealed record PresenceDto(string Username, EffectiveStatus Status, PresenceChange Kind);
