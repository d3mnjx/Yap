using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Yap.Configuration;
using Yap.Helpers;
using Yap.Models.Accounts;
using Yap.Models.Admin;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Gifs;
using Yap.Services.Media;
using Yap.Services.Notifications;
using Yap.Services.Persistence;
using Yap.Services.Presence;

namespace Yap.Services.Chat;

/// <summary>
/// The chat: rooms, direct messages, messages, reactions and read states, in memory, in one instance. This
/// is the source of truth. Every change happens here first, raises one event, and is enqueued on the
/// persistence writer. The database is read once, at startup. See docs/architecture/message-path.md and
/// chat-hub.md.
/// </summary>
public class ChatService
{
    private readonly PersistenceWriter _writer;
    private readonly IDbContextFactory<ChatDbContext>? _db;   // startup load only; null without persistence
    private readonly LoadSettings _load;                       // what the startup load reads per conversation
    private readonly PushNotificationService _pushService;
    private readonly PresenceService _presence;
    private readonly UserService _userService;
    private readonly LinkPreviewService _linkPreviewService;
    private readonly LinkPreviewSettingsService _linkPreviewSettings;
    private readonly MediaCacheService _mediaCacheService;
    private readonly GifService _gifService;
    private readonly MediaSizes _mediaSizes;
    private readonly NotificationAudit _audit;
    private readonly NotificationSettingsService _notifications;
    private readonly ILogger<ChatService> _logger;

    private readonly ConcurrentDictionary<Guid, Channel> _channels = new();
    private readonly ConcurrentDictionary<Guid, List<ChatMessage>> _channelMessages = new();
    private readonly ConcurrentDictionary<Guid, Lock> _channelLocks = new();          // one lock per message list
    private readonly ConcurrentDictionary<Guid, Guid> _channelOfMessage = new();        // the hub names a message by id alone
    private readonly ConcurrentDictionary<(Guid UserId, Guid ChannelId), ChannelReadState> _readStates = new();

    // (sender, clientId) -> message id, for one day. A repeated send returns the existing message instead
    // of a duplicate (offline design notes, "Server side"). Rebuilt from recent messages at startup.
    private readonly ConcurrentDictionary<(Guid UserId, Guid ClientId), (Guid MessageId, DateTime At)> _byClientId = new();
    private static readonly TimeSpan ClientIdMemory = TimeSpan.FromDays(1);

    private Guid _lobbyId;

    public const int MaxTextLength = 4000;      // IB-14, MR-11
    public const int MaxMediaPerMessage = 10;   // IB-32
    // The waveform of a voice message: one base-36 digit per bar, at most 64 bars (VoiceAttachment).
    private static readonly System.Text.RegularExpressions.Regex VoicePeaks = new("^[0-9a-z]{0,64}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    // Every change raises one event. The broadcaster turns each into one hub message; the bot listens too.
    public event Action<ChatMessage>? OnMessageReceived;
    public event Action<ChatMessage>? OnMessageEdited;
    public event Action<Guid, Guid>? OnMessageDeleted;            // channelId, messageId
    public event Action<ChatMessage>? OnReactionChanged;
    public event Action<ChatMessage>? OnPreviewsReady;            // a link card or a cached media player is ready (MR-22, MR-23)
    public event Action<Guid, Guid, int>? OnUnreadChanged;        // userId, channelId, count
    public event Action<Channel>? OnDmStarted;                    // a direct message got its first message (SH-29)
    public event Action? OnRoomsChanged;                          // created, updated, reordered or deleted (SH-25)
    public event Action<Channel>? OnPinsChanged;                  // a pin or an unpin, or an edit or a delete of a pinned message (SH-48)

    public ChatService(IServiceProvider services, PersistenceWriter writer, PushNotificationService pushService, UserService userService,
        PresenceService presence, LinkPreviewService linkPreviewService, LinkPreviewSettingsService linkPreviewSettings,
        MediaCacheService mediaCacheService, GifService gifService, MediaSizes mediaSizes, NotificationAudit audit,
        NotificationSettingsService notifications, IOptions<PersistenceSettings> persistence, ILogger<ChatService> logger)
    {
        _db = services.GetService<IDbContextFactory<ChatDbContext>>();
        _load = persistence.Value.Load;
        _writer = writer;
        _pushService = pushService;
        _presence = presence;
        _userService = userService;
        _linkPreviewService = linkPreviewService;
        _linkPreviewSettings = linkPreviewSettings;
        _mediaCacheService = mediaCacheService;
        _gifService = gifService;
        _mediaSizes = mediaSizes;
        _audit = audit;
        _notifications = notifications;
        _logger = logger;

        _linkPreviewService.OnPreviewFetched = (messageId, _, _) => RaisePreviewsReady(messageId);

        // A cached media file completes the LinkPreview of its URL, then the card becomes a player (MR-23).
        _mediaCacheService.OnMediaCached = (messageId, url, entry) =>
        {
            _linkPreviewService.AttachMedia(url, entry);
            RaisePreviewsReady(messageId);
        };

        // The lobby exists from the first second. The startup load replaces it when the database has one.
        var lobby = Channel.CreateRoom("lobby", createdById: null, createdBy: null, isDefault: true);
        _lobbyId = lobby.Id;
        _channels[lobby.Id] = lobby;
        _channelMessages[lobby.Id] = [];
    }

    #region Startup and diagnostics

    /// <summary>Fills memory from the database. Runs once, after the users are loaded.</summary>
    public async Task InitializeAsync()
    {
        if (_db is null) return;
        var snapshot = await Loads.ChatSnapshotAsync(_db, _load);

        _channels.Clear();
        _channelMessages.Clear();
        foreach (var channel in snapshot.Channels)
        {
            _channels[channel.Id] = channel;
            var messages = snapshot.MessagesByChannel.GetValueOrDefault(channel.Id, []);
            _channelMessages[channel.Id] = messages;
            foreach (var m in messages)
            {
                _channelOfMessage[m.Id] = channel.Id;
                if (m.ClientId is { } clientId && DateTime.UtcNow - m.Timestamp < ClientIdMemory)
                    _byClientId[(m.UserId, clientId)] = (m.Id, m.Timestamp);
            }
        }
        foreach (var state in snapshot.ReadStates)
            _readStates[(state.UserId, state.ChannelId)] = state;

        var orphaned = _channels.Values.Count(c => c.IsDirectMessage
            && (_userService.GetByUsername(c.Participant1 ?? "") is null || _userService.GetByUsername(c.Participant2 ?? "") is null));
        if (orphaned > 0)
            _logger.LogWarning("{Count} direct message channel(s) name a participant that no longer exists", orphaned);

        var lobby = _channels.Values.FirstOrDefault(c => c.Type == ChannelType.Room && c.IsDefault);
        if (lobby is not null)
        {
            _lobbyId = lobby.Id;
        }
        else
        {
            lobby = Channel.CreateRoom("lobby", createdById: null, createdBy: null, isDefault: true);
            _lobbyId = lobby.Id;
            _channels[lobby.Id] = lobby;
            _channelMessages[lobby.Id] = [];
            _writer.Enqueue(Writes.Channel(lobby));
        }

        if (snapshot.MessagesLeft > 0)
            _logger.LogInformation("Loaded {Channels} channels, {Messages} messages ({Left} more stay in the database: {Bounds}), {ReadStates} read states",
                snapshot.Channels.Count, _channelOfMessage.Count, snapshot.MessagesLeft, _load.Describe(), snapshot.ReadStates.Count);
        else
            _logger.LogInformation("Loaded {Channels} channels, {Messages} messages, {ReadStates} read states",
                snapshot.Channels.Count, _channelOfMessage.Count, snapshot.ReadStates.Count);
    }

    public Guid LobbyId => _lobbyId;

    public ChatDiagnostics GetDiagnostics() => new()
    {
        UserSessions = _presence.Stats().Connected,
        UniqueUsers = _presence.ConnectedUserIds().Count,
        Channels = _channels.Count,
        RoomChannels = _channels.Values.Count(c => c.Type == ChannelType.Room),
        DmChannels = _channels.Values.Count(c => c.Type == ChannelType.DirectMessage),
        TotalMessages = _channelOfMessage.Count,
        EventSubscribers = new Dictionary<string, int>
        {
            ["OnMessageReceived"] = OnMessageReceived?.GetInvocationList().Length ?? 0,
            ["OnMessageEdited"] = OnMessageEdited?.GetInvocationList().Length ?? 0,
            ["OnMessageDeleted"] = OnMessageDeleted?.GetInvocationList().Length ?? 0,
            ["OnReactionChanged"] = OnReactionChanged?.GetInvocationList().Length ?? 0,
            ["OnPreviewsReady"] = OnPreviewsReady?.GetInvocationList().Length ?? 0,
            ["OnUnreadChanged"] = OnUnreadChanged?.GetInvocationList().Length ?? 0,
            ["OnDmStarted"] = OnDmStarted?.GetInvocationList().Length ?? 0,
            ["OnRoomsChanged"] = OnRoomsChanged?.GetInvocationList().Length ?? 0,
        },
        AdminUser = _userService.GetAdminUsername(),
    };

    #endregion

    #region Rooms

    public List<Channel> Rooms() =>
        _channels.Values.Where(c => c.Type == ChannelType.Room).OrderBy(c => c.SortOrder).ThenBy(c => c.CreatedAt).ToList();

    public Channel? GetChannel(Guid channelId) => _channels.GetValueOrDefault(channelId);

    public Channel? GetRoom(Guid channelId) => _channels.TryGetValue(channelId, out var c) && !c.IsDirectMessage ? c : null;

    /// <summary>AD-30 to AD-34. Returns the room, or the reason the admin sees.</summary>
    public (Channel? Room, string? Error) CreateRoom(Guid adminUserId, string name, string? description,
        ChannelPermission writePermission, HistoryLimit historyLimit, bool sinceJoined,
        PinPermission pinPermission = PinPermission.AdminOnly, IEnumerable<string>? pinners = null)
    {
        if (!_userService.IsAdmin(adminUserId)) return (null, "Not authorized.");
        var (names, badName) = Pinners(pinners);
        if (badName is not null) return (null, badName);
        name = name.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(name)) return (null, "Channel name is required.");
        if (name.Contains(' ')) return (null, "Lowercase, no spaces.");
        if (_channels.Values.Any(c => c.Type == ChannelType.Room && c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            return (null, "A channel with that name already exists.");

        var bottom = _channels.Values.Where(c => c.Type == ChannelType.Room).Select(c => c.SortOrder).DefaultIfEmpty(-1).Max() + 1;
        var admin = _userService.GetById(adminUserId);
        var room = Channel.CreateRoom(name, adminUserId, admin?.Username, description: Clean(description), sortOrder: bottom,
            writePermission: writePermission, historyLimit: historyLimit, sinceJoined: sinceJoined, pinPermission: pinPermission, pinners: names);
        _channels[room.Id] = room;
        _channelMessages[room.Id] = [];

        OnRoomsChanged?.Invoke();
        _writer.Enqueue(Writes.Channel(room));
        return (room, null);
    }

    /// <summary>AD-30 to AD-34, AD-37. A null pin field stays as it is: a tab on an older build sends neither (SH-50).</summary>
    public string? UpdateRoom(Guid adminUserId, Guid channelId, string name, string? description,
        ChannelPermission writePermission, HistoryLimit historyLimit, bool sinceJoined,
        PinPermission? pinPermission = null, IEnumerable<string>? pinners = null)
    {
        if (!_userService.IsAdmin(adminUserId)) return "Not authorized.";
        if (GetRoom(channelId) is not { } room) return "Channel not found.";
        var (names, badName) = Pinners(pinners);
        if (badName is not null) return badName;
        name = name.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(name)) return "Channel name is required.";
        if (name.Contains(' ')) return "Lowercase, no spaces.";
        if (_channels.Values.Any(c => c.Type == ChannelType.Room && c.Id != channelId && c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            return "A channel with that name already exists.";

        room.Name = name;
        room.Description = Clean(description);
        room.WritePermission = writePermission;
        room.HistoryLimit = historyLimit;
        room.SinceJoined = sinceJoined;
        room.PinPermission = pinPermission ?? room.PinPermission;
        if (pinners is not null) room.Pinners = names;

        OnRoomsChanged?.Invoke();
        _writer.Enqueue(Writes.Channel(room));
        return null;
    }

    /// <summary>Swaps the sort order with the neighbour (AD-33).</summary>
    public bool MoveRoom(Guid adminUserId, Guid channelId, bool up)
    {
        if (!_userService.IsAdmin(adminUserId)) return false;
        var rooms = Rooms();
        var index = rooms.FindIndex(r => r.Id == channelId);
        var other = up ? index - 1 : index + 1;
        if (index < 0 || other < 0 || other >= rooms.Count) return false;

        (rooms[index].SortOrder, rooms[other].SortOrder) = (rooms[other].SortOrder, rooms[index].SortOrder);
        OnRoomsChanged?.Invoke();
        _writer.Enqueue(Writes.Channel(rooms[index]));
        _writer.Enqueue(Writes.Channel(rooms[other]));
        return true;
    }

    /// <summary>The lobby cannot be deleted (AD-35). The mutes of every person for the room are cleared.</summary>
    public bool DeleteRoom(Guid adminUserId, Guid channelId)
    {
        if (!_userService.IsAdmin(adminUserId)) return false;
        if (GetRoom(channelId) is not { } room || room.IsDefault) return false;

        Purge(channelId);
        OnRoomsChanged?.Invoke();
        return true;
    }

    // A conversation leaves memory with everything keyed on it; the database cascade follows the one write.
    private void Purge(Guid channelId)
    {
        _channels.TryRemove(channelId, out _);
        if (_channelMessages.TryRemove(channelId, out var messages))
            foreach (var m in messages) _channelOfMessage.TryRemove(m.Id, out _);
        _channelLocks.TryRemove(channelId, out _);
        foreach (var key in _readStates.Keys.Where(k => k.ChannelId == channelId).ToList())
            _readStates.TryRemove(key, out _);
        _presence.ForgetChannel(channelId);
        _notifications.ClearOverridesForChannel(channelId);
        _writer.Enqueue(Writes.DeleteChannel(channelId));
    }

    /// <summary>
    /// An account is deleted (AD-40). Its direct messages go on both sides: a conversation with nobody could not be
    /// opened or answered, and nothing lets the other person dismiss it. Its room messages, reactions and pins stay
    /// under <paramref name="ghostName"/>, which no account can register, so a newcomer with the old name inherits
    /// nothing: not a row, not a pin's author or pinner, not a place among a room's pinners (AD-37). Rooms it created
    /// lose the id and carry the ghost name as creator. Returns the deleted direct messages.
    /// </summary>
    public List<Guid> RemoveAccount(User user, string ghostName)
    {
        var dms = DmChannelsOf(user.Id).Select(c => c.Id).ToList();
        foreach (var id in dms) Purge(id);

        foreach (var (channelId, messages) in _channelMessages)
        {
            lock (LockOf(channelId))
                foreach (var m in messages)
                {
                    if (m.UserId == user.Id) m.Username = ghostName;
                    lock (m.Reactions)
                        foreach (var r in m.Reactions.Where(r => r.UserId == user.Id)) r.Username = ghostName;
                }
        }

        // The channel rows name the person by username: a pin's author and pinner, a room's pinners, the creator.
        bool Theirs(string name) => name.Equals(user.Username, StringComparison.OrdinalIgnoreCase);
        var roomsChanged = false;
        foreach (var channel in _channels.Values)
        {
            var created = channel.CreatedById == user.Id;
            var pinner = channel.Pinners.Any(Theirs);
            var named = channel.Pins.Any(p => Theirs(p.Username) || Theirs(p.PinnedBy));
            if (!created && !pinner && !named) continue;
            if (created) { channel.CreatedById = null; channel.CreatedBy = ghostName; }
            lock (LockOf(channel.Id))
            {
                if (pinner) channel.Pinners = channel.Pinners.Where(n => !Theirs(n)).ToList();   // or a newcomer with the name could pin, and every save of the room would fail on an unknown name
                if (named) channel.Pins = channel.Pins.Select(p => p with { Username = Theirs(p.Username) ? ghostName : p.Username, PinnedBy = Theirs(p.PinnedBy) ? ghostName : p.PinnedBy }).ToList();
            }
            if (named) OnPinsChanged?.Invoke(channel);
            roomsChanged |= pinner;
            _writer.Enqueue(Writes.Channel(channel));
        }
        if (roomsChanged) OnRoomsChanged?.Invoke();   // the room settings page sends back the pinners it was given

        foreach (var key in _readStates.Keys.Where(k => k.UserId == user.Id).ToList()) _readStates.TryRemove(key, out _);
        foreach (var key in _byClientId.Keys.Where(k => k.UserId == user.Id).ToList()) _byClientId.TryRemove(key, out _);

        _writer.Enqueue(Writes.RelabelAuthor(user.Id, ghostName));
        return dms;
    }

    private static string? Clean(string? description) =>
        string.IsNullOrWhiteSpace(description) ? null : description.Trim();

    /// <summary>The selected pinners (AD-37): known usernames in their stored spelling, once each. An unknown name is the
    /// admin's error and is reported, not dropped.</summary>
    private (List<string> Names, string? Error) Pinners(IEnumerable<string>? pinners)
    {
        var names = new List<string>();
        foreach (var name in (pinners ?? []).Select(n => n.Trim()).Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (_userService.GetByUsername(name) is not { } user) return ([], $"Unknown user: {name}.");
            names.Add(user.Username);
        }
        return (names, null);
    }

    #endregion

    #region Direct messages

    /// <summary>The direct message between two people, created on first open. Null when the other person is unknown.</summary>
    public Channel? GetOrCreateDm(Guid userId, Guid otherUserId)
    {
        if (userId == otherUserId) return null;
        if (_channels.Values.FirstOrDefault(c => c.IsDMBetween(userId, otherUserId)) is { } existing) return existing;
        if (_userService.GetById(userId) is not { } me || _userService.GetById(otherUserId) is not { } other) return null;

        var channel = Channel.CreateDM(me.Id, me.Username, other.Id, other.Username);
        _channels[channel.Id] = channel;
        _channelMessages[channel.Id] = [];
        _writer.Enqueue(Writes.Channel(channel));
        return channel;
    }

    public Channel? GetOrCreateDm(Guid userId, string otherUsername) =>
        _userService.GetByUsername(otherUsername) is { } other ? GetOrCreateDm(userId, other.Id) : null;

    public List<Channel> DmChannelsOf(Guid userId) =>
        _channels.Values.Where(c => c.IsDirectMessage && c.CanAccess(userId)).ToList();

    /// <summary>The person's direct messages with at least one message, for the sidebar (SH-29).</summary>
    public List<(Channel Channel, string Partner, DateTime LastMessageAt)> DmConversations(Guid userId)
    {
        var me = _userService.GetById(userId);
        if (me is null) return [];
        var result = new List<(Channel, string, DateTime)>();
        foreach (var channel in DmChannelsOf(userId))
        {
            var partner = channel.GetOtherParticipant(me.Username);
            if (string.IsNullOrEmpty(partner)) continue;
            DateTime? last;   // of the last message: a pin line (MR-80) is no reason to move the conversation up the list
            lock (LockOf(channel.Id)) last = _channelMessages.GetValueOrDefault(channel.Id)?.LastOrDefault(m => m.Kind == MessageKind.Normal)?.Timestamp;
            if (last is { } at) result.Add((channel, partner, at));
        }
        return result;
    }

    #endregion

    #region Reading

    /// <summary>The newest messages of a conversation, within the viewer's history cutoff (TL-01, TL-05).</summary>
    public (List<ChatMessage> Messages, bool HasMore, bool Restricted) Tail(Guid channelId, int count, Guid viewerId) =>
        Page(channelId, count, viewerId, before: null);

    /// <summary>The messages before the oldest loaded one (TL-06). The cursor is found by id; when that message
    /// was deleted meanwhile, the timestamp takes over.</summary>
    public (List<ChatMessage> Messages, bool HasMore) Older(Guid channelId, DateTime beforeTimestamp, Guid beforeId, int count, Guid viewerId)
    {
        var (messages, hasMore, _) = Page(channelId, count, viewerId, before: (beforeTimestamp, beforeId));
        return (messages, hasMore);
    }

    private (List<ChatMessage>, bool HasMore, bool Restricted) Page(Guid channelId, int count, Guid viewerId, (DateTime Timestamp, Guid Id)? before)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(viewerId) || !_channelMessages.TryGetValue(channelId, out var all))
            return ([], false, false);
        var cutoff = Cutoff(channel, viewerId);

        lock (LockOf(channelId))
        {
            var end = EndBefore(all, before);   // exclusive: the page is all[start..end)
            var first = FirstVisible(all, cutoff);
            var start = Math.Max(first, end - count);
            var page = start < end ? all.GetRange(start, end - start) : [];
            return (page, start > first, first > 0);
        }
    }

    // Where a page that ends before the cursor message stops, exclusive: all.Count without a cursor. The cursor is
    // found by id; when that message was deleted meanwhile, the timestamp takes over (TL-06). Call under the lock.
    private static int EndBefore(List<ChatMessage> all, (DateTime Timestamp, Guid Id)? before)
    {
        if (before is not { } cursor) return all.Count;
        var end = all.FindIndex(m => m.Id == cursor.Id);
        if (end < 0) end = all.FindIndex(m => m.Timestamp >= cursor.Timestamp);
        return end < 0 ? all.Count : end;
    }

    // The oldest message the viewer may see (TL-05), or all.Count when the cutoff hides every message. Call under the lock.
    private static int FirstVisible(List<ChatMessage> all, DateTime? cutoff)
    {
        var first = cutoff is { } c ? all.FindIndex(m => m.Timestamp >= c) : 0;
        return first < 0 ? all.Count : first;
    }

    private const int Before = 25, After = 24;   // one page around the target: the window replaces the rows, and a page is what they hold after an open (TL-41)

    /// <summary>SH-49, MR-34, TL-41: the messages around one message, inside the viewer's history cutoff (TL-05). HasNewer
    /// false means the window reaches the newest message, and the client treats it as a tail.</summary>
    public (List<ChatMessage> Messages, bool HasMore, bool HasNewer, string? Error) Around(Guid channelId, Guid messageId, Guid viewerId)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(viewerId) || !_channelMessages.TryGetValue(channelId, out var all))
            return ([], false, false, "Message not found.");
        var cutoff = Cutoff(channel, viewerId);
        // The id map says in O(1) whether the message is in memory and in this channel, as in GetMessage: a pin whose
        // message left memory costs no scan under the lock. Send writes the map after the list, but a client learns an
        // id only from the send's answer or the broadcast, and both come after the map write.
        var inMemory = _channelOfMessage.TryGetValue(messageId, out var home) && home == channelId;
        lock (LockOf(channelId))
        {
            var index = inMemory ? all.FindIndex(m => m.Id == messageId) : -1;
            // A delete removes the pin too (Delete), so a pin whose message is not in memory points before the startup
            // load (SH-48): the reader learns that, instead of "not found".
            if (index < 0) return ([], false, false, channel.Pins.Any(p => p.MessageId == messageId) ? "Too old to load" : "Message not found.");
            var first = FirstVisible(all, cutoff);
            if (index < first) return ([], false, false, "Message not found.");   // behind the cutoff: the same answer as an unknown id, so the refusal tells nothing about the hidden part
            var start = Math.Max(first, index - Before);
            var end = Math.Min(all.Count, index + 1 + After);
            return (all.GetRange(start, end - start), start > first, end < all.Count, null);
        }
    }

    public const int MaxQueryLength = 100;   // SR-05; the client's fields have the same limit
    private const int MinQueryLength = 2;    // SR-05: one character matches nearly every message

    /// <summary>SR-01 to SR-06: the messages of one conversation whose text holds every word of the query, newest
    /// first, inside the viewer's history cutoff (TL-05). The cursor is the last result the client has, as in
    /// <see cref="Older"/>. Total counts every match and comes only without a cursor: a count taken again for each page
    /// would move while messages arrive (SR-11). Since is the time of the oldest message the viewer can see, null
    /// when there is none (SR-12). Error is the refusal the reader sees; the other values are empty then.</summary>
    public (List<ChatMessage> Hits, int? Total, bool HasMore, DateTime? Since, string? Error) Search(
        Guid channelId, string? query, DateTime? beforeTimestamp, Guid? beforeId, int count, Guid viewerId)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(viewerId) || !_channelMessages.TryGetValue(channelId, out var all))
            return ([], null, false, null, "Conversation not found.");
        var cutoff = Cutoff(channel, viewerId);
        var words = SearchWords(query);
        (DateTime, Guid)? before = beforeId is { } id && beforeTimestamp is { } time ? (time, id) : null;
        var paged = before is not null;

        // Only the copy runs under the lock. The match reads and folds every text, and a send to this conversation
        // must not wait for it (chat-hub.md: nothing slow under the lock). A text edited meanwhile is read as either
        // version: the property holds one reference.
        List<ChatMessage> visible;
        DateTime? since;
        lock (LockOf(channelId))
        {
            var first = FirstVisible(all, cutoff);
            var end = EndBefore(all, before);
            visible = first < end ? all.GetRange(first, end - first) : [];
            since = first < all.Count ? all[first].Timestamp : null;
        }
        if (words.Length == 0) return ([], paged ? null : 0, false, since, null);

        var hits = new List<ChatMessage>(count);
        var matches = 0;
        for (var i = visible.Count - 1; i >= 0; i--)
        {
            var m = visible[i];
            if (m.Kind != MessageKind.Normal) continue;   // SR-01: a system line is not a result. A message without text needs no check: an empty text holds no word
            if (!TextFold.HoldsAll(m.Content, words)) continue;
            matches++;
            if (hits.Count < count) hits.Add(m);
            else if (paged) break;   // a later page gives no total: one match past the page says there is more
        }
        return (hits, paged ? null : matches, matches > hits.Count, since, null);
    }

    // The folded words of a query (SR-03, SR-05), none when the query is too short. The cut at the limit keeps a
    // surrogate pair whole: half an emoji is a text that Fold cannot normalize.
    private static string[] SearchWords(string? query)
    {
        var text = (query ?? "").Trim();
        if (text.Length > MaxQueryLength) text = text[..(char.IsHighSurrogate(text[MaxQueryLength - 1]) ? MaxQueryLength - 1 : MaxQueryLength)];
        return text.Length < MinQueryLength ? [] : TextFold.Fold(text).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
    }

    /// <summary>A non-admin sees a room from the later of the room's history window and, when the room says so,
    /// the person's own account creation. Admins and direct messages have no cutoff (TL-05).</summary>
    private DateTime? Cutoff(Channel channel, Guid viewerId)
    {
        if (channel.IsDirectMessage || _userService.IsAdmin(viewerId)) return null;
        var window = channel.GetHistoryCutoff();
        var joined = channel.SinceJoined ? _userService.GetById(viewerId)?.CreatedAt : null;
        if (window is null) return joined;
        if (joined is null) return window;
        return window > joined ? window : joined;
    }

    /// <summary>Whether a room hides part of its past from non-admins (TL-05): a time window, or "since joined".</summary>
    public bool IsRestricted(Channel channel) => !channel.IsDirectMessage && (channel.HistoryLimit != HistoryLimit.Unlimited || channel.SinceJoined);

    /// <summary>Whether the person may read this message: access to the conversation, and the message inside the
    /// person's history cutoff. The one rule for history pages, the quote of a reply and live events (TL-05).</summary>
    public bool MayRead(Guid viewerId, ChatMessage m) => _channels.TryGetValue(m.ChannelId, out var channel) && MayRead(viewerId, channel, m.Timestamp);

    /// <summary>The same rule for a pin, which stands in for a message that may have left memory (SH-48).</summary>
    public bool MayRead(Guid viewerId, Channel channel, DateTime timestamp) =>
        channel.CanAccess(viewerId) && (Cutoff(channel, viewerId) is not { } c || timestamp >= c);

    public ChatMessage? GetMessage(Guid messageId)
    {
        if (!_channelOfMessage.TryGetValue(messageId, out var channelId) || !_channelMessages.TryGetValue(channelId, out var messages)) return null;
        lock (LockOf(channelId)) return messages.FirstOrDefault(m => m.Id == messageId);
    }

    #endregion

    #region Sending

    /// <summary>
    /// The one write path for messages. Changes memory, raises the events, enqueues the writes, returns.
    /// Nothing here waits for the database (message-path.md).
    /// </summary>
    public SendResult Send(SendMessage request)
    {
        if (_userService.GetById(request.UserId) is null) return SendResult.Refused("Unknown user.");   // the account is being deleted (AD-40): nothing is stored for nobody
        if (!_channels.TryGetValue(request.ChannelId, out var channel) || !channel.CanAccess(request.UserId))
            return SendResult.Refused("Unknown conversation", 404);
        if (!channel.CanWrite(request.UserId, _userService.IsAdmin(request.UserId)))
            return SendResult.Refused("You do not have permission to send messages in this channel", 403);   // IB-62

        var text = request.Text ?? "";
        var media = (request.ImageUrls?.Count ?? 0) + (request.VideoUrls?.Count ?? 0) + (request.GifAttachments?.Count ?? 0);
        if (request.Voice is { } voice)
        {
            // A voice message carries nothing else (IB-70): the row has no caption and no gallery to draw with it.
            if (media > 0 || !string.IsNullOrWhiteSpace(text)) return SendResult.Refused("A voice message is sent alone.");
            if (voice.DurationMs <= 0 || voice.DurationMs > VoiceService.MaxDurationMs) return SendResult.Refused("The voice message is too long.");
            if (!VoicePeaks.IsMatch(voice.Peaks ?? "")) return SendResult.Refused("The voice message is malformed.");
            media = 1;
        }
        if (text.Length > MaxTextLength) return SendResult.Refused($"A message has at most {MaxTextLength} characters.");
        if (media > MaxMediaPerMessage) return SendResult.Refused($"Choose at most {MaxMediaPerMessage} files.");   // IB-32
        if (string.IsNullOrWhiteSpace(text) && media == 0) return SendResult.Refused("The message is empty.");
        // A reply quotes its original to every reader of the conversation. An original from another conversation
        // would carry that conversation's text here, a direct message's included (GEN-04). An original that is gone
        // passes: the quote then says so (MR-35).
        if (request.ReplyToMessageId is { } replyId && _channelOfMessage.TryGetValue(replyId, out var home) && home != channel.Id)
            return SendResult.Refused("The original message is not in this conversation.");
        if (request.ReplyToMessageId is { } quoted && GetMessage(quoted)?.Kind is { } kind && kind != MessageKind.Normal)
            return SendResult.Refused("A system line cannot be quoted.");   // MR-80: the row offers no Reply; the call is refused too

        if (request.ClientId is { } clientId)
        {
            // The key is reserved before the insert, so two parallel posts with one clientId cannot both store.
            if (!_byClientId.TryAdd((request.UserId, clientId), (Guid.Empty, DateTime.UtcNow)))
            {
                if (!_byClientId.TryGetValue((request.UserId, clientId), out var known) || known.MessageId == Guid.Empty)
                    return SendResult.Refused("This message is already being sent.", 409);
                if (GetMessage(known.MessageId) is { } existing)
                    return SendResult.Ok(existing);   // the same send twice: the first result, no duplicate
                // The first copy was deleted since: this send stores a new message under the same key.
            }
            if (_byClientId.Count > 1000) ForgetOldClientIds();
        }

        var message = new ChatMessage(channel.Id, request.UserId, request.Username, text, DateTime.UtcNow,
            request.ImageUrls, request.ReplyToMessageId, request.VideoUrls, request.GifAttachments, request.Voice) { ClientId = request.ClientId };
        _gifService.IncrementReferences(request.GifAttachments);   // an entry in chat history is never evicted

        bool firstInDm;
        lock (LockOf(channel.Id))
        {
            var messages = _channelMessages.GetOrAdd(channel.Id, _ => []);
            firstInDm = channel.IsDirectMessage && messages.Count == 0;
            messages.Add(message);
        }
        _channelOfMessage[message.Id] = channel.Id;
        if (request.ClientId is { } id) _byClientId[(request.UserId, id)] = (message.Id, message.Timestamp);

        // The message's own write goes into the queue before anyone hears of the message. A reaction that a fast
        // client sends after the broadcast has a row with a foreign key to this message; queued ahead of the
        // insert, it failed with "FOREIGN KEY constraint failed" and was dropped (five times on the 2026-10-18
        // load test, when the broadcast and the unread sends below held this thread for tens of milliseconds).
        _writer.Enqueue(Writes.Message(message));

        var unread = IncrementUnread(channel, request.UserId);
        _presence.StopTyping(channel.Id, request.Username);   // IB-59

        OnMessageReceived?.Invoke(message);
        if (firstInDm) OnDmStarted?.Invoke(channel);
        foreach (var (userId, count) in unread) OnUnreadChanged?.Invoke(userId, channel.Id, count);

        // Coalesced by (person, channel): a room of a thousand writes the same thousand rows on every message (PersistenceWriter).
        foreach (var (userId, _) in unread) _writer.EnqueueCoalesced((userId, channel.Id), Writes.ReadState(_readStates[(userId, channel.Id)]));

        QueuePreviews(message);
        DispatchPush(channel, request.Username, message);
        return SendResult.Ok(message);
    }

    private void ForgetOldClientIds()
    {
        var limit = DateTime.UtcNow - ClientIdMemory;
        foreach (var key in _byClientId.Where(e => e.Value.At < limit).Select(e => e.Key).ToList())
            _byClientId.TryRemove(key, out _);
    }

    /// <summary>Link cards for a text message, in text order (MR-19). Media messages get none.</summary>
    private void QueuePreviews(ChatMessage message) => EnsurePreviews([message]);

    /// <summary>
    /// The cards of a message or of a served page. A card stays in memory and on disk (Data/link-cards), so the mapper
    /// puts it into the page whatever its age, and a good card is never fetched again. The hub calls this for every
    /// page it serves: a link with no card, or a card without content after an hour, is fetched in the background,
    /// and a "previews" message fills in the row while the reader looks at it (MR-22). A media file already on disk
    /// is attached by the mapper.
    /// </summary>
    public void EnsurePreviews(IEnumerable<ChatMessage> messages)
    {
        if (!_linkPreviewSettings.Enabled) return;
        foreach (var message in messages)
        {
            if (message.HasMedia) continue;
            foreach (var url in LinkPreviewService.ExtractUrls(message.Content).Take(LinkPreviewService.MaxLinksPerMessage))
            {
                if (LinkPreviewService.NeedsFetch(_linkPreviewService.GetCachedPreview(url))) _linkPreviewService.QueueFetch(message.Id, url);
                if (_linkPreviewSettings.MediaCachingEnabled) _mediaCacheService.QueueDownload(message.Id, url);   // a no-op for a file on disk
            }
        }
    }

    /// <summary>The cards of a text message: one per link with a title or a description, at most five (MR-19, MR-20).
    /// The mapper puts them into the row; the pin copy takes its picture from the first one (SH-48).</summary>
    public IReadOnlyList<PreviewDto> Previews(ChatMessage m)
    {
        if (!_linkPreviewSettings.Enabled || m.HasMedia) return [];
        var result = new List<PreviewDto>();
        foreach (var url in LinkPreviewService.ExtractUrls(m.Content).Take(LinkPreviewService.MaxLinksPerMessage))
        {
            var p = _linkPreviewService.GetCachedPreview(url);
            // A card loaded from its file after a restart has no media fields (they are not stored): the media file
            // on disk completes it here.
            if (p?.CachedMediaUrl is null && _mediaCacheService.GetOrLoadCachedMedia(url) is { } file) p = _linkPreviewService.AttachMedia(url, file);
            if (p is null || (!p.HasContent && p.CachedMediaUrl is null)) continue;
            var media = p.CachedMediaUrl is null ? null
                : new PreviewMediaDto(p.MediaType?.ToString().ToLowerInvariant() ?? "video", p.CachedMediaUrl, p.CachedPosterUrl, p.MediaWidth, p.MediaHeight, p.MediaDurationSeconds);
            result.Add(new PreviewDto(url, p.SiteName, p.Title, Cut(p.Description, 300), p.ImageUrl, media));
        }
        return result;
    }

    private static string? Cut(string? text, int max) =>
        text is null || text.Length <= max ? text : text[..max].TrimEnd() + "…";

    private void RaisePreviewsReady(Guid messageId)
    {
        if (GetMessage(messageId) is not { } message) return;
        RefreshPinMedia(message);   // a pinned link gets its card's picture when the card arrives after the pin
        OnPreviewsReady?.Invoke(message);
    }

    /// <summary>
    /// Web push for the people who are not looking (NT-25, NT-26). Away does not suppress it: a phone in a pocket
    /// must get it, and an idle but visible desktop still gets it. Muted conversations get nothing.
    /// </summary>
    private List<ChatMessage> RepliesTo(ChatMessage original)
    {
        lock (LockOf(original.ChannelId))
            return _channelMessages.TryGetValue(original.ChannelId, out var list) ? list.Where(m => m.ReplyToMessageId == original.Id).ToList() : [];
    }

    private void DispatchPush(Channel channel, string senderUsername, ChatMessage message)
    {
        var preview = !string.IsNullOrWhiteSpace(message.Content) ? message.Content   // NT-27: a caption is the text
            : message.Voice is { } voice ? $"[Voice message {VoiceService.FormatDuration(voice.DurationMs)}]"
            : message.HasGifs ? "[GIF]" : "[Attachment]";
        var senderName = _userService.GetByUsername(senderUsername)?.DisplayName ?? senderUsername;        // NT-27: the display name

        foreach (var recipient in PushRecipients(channel, senderUsername))
        {
            var lookingNow = _presence.IsOnlineAndVisible(recipient.Id);
            var sessions = _presence.Describe(recipient.Id);
            var subscriptions = _pushService.GetSubscriptionCount(recipient.Username);
            var totalUnread = TotalUnread(recipient.Id);

            if (lookingNow)
            {
                _audit.RecordPushDecision(senderUsername, recipient.Username, "suppressed: Online + visible", sessions, subscriptions, totalUnread);
                continue;
            }
            _audit.RecordPushDecision(senderUsername, recipient.Username, "push", sessions, subscriptions, totalUnread);

            _ = channel.IsDirectMessage
                ? _pushService.SendDmNotificationAsync(recipient.Username, senderUsername, preview, totalUnread, senderName)
                : _pushService.SendRoomNotificationAsync(recipient.Username, channel.Name, channel.Id, senderUsername, preview, totalUnread, senderName);
        }
    }

    private IEnumerable<User> PushRecipients(Channel channel, string senderUsername)
    {
        if (channel.IsDirectMessage)
        {
            var other = channel.GetOtherParticipant(senderUsername);
            var user = other is null ? null : _userService.GetByUsername(other);
            if (user is not null && !_notifications.IsMuted(user, channel.Id, isDirectMessage: true)) yield return user;
            yield break;
        }
        // Rooms are muted by default, so this normally yields nobody and the scan stays cheap.
        foreach (var user in _userService.GetAllUsers())
            if (!user.Username.Equals(senderUsername, StringComparison.OrdinalIgnoreCase) && !_notifications.IsMuted(user, channel.Id, isDirectMessage: false))
                yield return user;
    }

    #endregion

    #region Edit, delete, react

    /// <summary>MR-57, MR-61. Returns the reason for a refusal, or null.</summary>
    public string? Edit(Guid userId, Guid messageId, string text)
    {
        if (GetMessage(messageId) is not { } message) return "Message not found.";
        if (message.Kind != MessageKind.Normal) return "A system line cannot be edited.";   // MR-80: its text is not stored
        if (message.UserId != userId) return "You can edit your own messages only.";
        if (message.HasMedia && string.IsNullOrWhiteSpace(message.Content)) return "A media message without a caption cannot be edited.";   // the caption is the part that an edit changes (MR-57)
        if (text.Length > MaxTextLength) return $"A message has at most {MaxTextLength} characters.";
        if (string.IsNullOrWhiteSpace(text) || text == message.Content) return null;   // nothing changes, nothing to say

        message.Content = text;
        message.IsEdited = true;
        OnMessageEdited?.Invoke(message);
        foreach (var reply in RepliesTo(message)) OnMessageEdited?.Invoke(reply);   // their quotes show the new text (MR-32)
        _writer.Enqueue(Writes.MessageEdit(message.Id, text));
        QueuePreviews(message);   // an edit that adds or removes a link adds or removes the card (MR-22)
        if (_channels.TryGetValue(message.ChannelId, out var channel) && channel.Pins.Any(p => p.MessageId == message.Id))
        {
            var media = PinMediaOf(message);   // outside the lock: it may read a cached card from disk
            lock (LockOf(channel.Id)) channel.Pins = channel.Pins.Select(p => p.MessageId == message.Id ? p with { Text = text, Media = media } : p).ToList();   // the panel shows the new text, and a link card that came or went with it (SH-48)
            PinsChanged(channel);
        }
        return null;
    }

    /// <summary>MR-64, MR-68. The row disappears for everyone; nothing is stored about the deletion.</summary>
    public string? Delete(Guid userId, Guid messageId)
    {
        if (!_channelOfMessage.TryGetValue(messageId, out var channelId) || !_channelMessages.TryGetValue(channelId, out var messages))
            return "Message not found.";
        ChatMessage? message;
        lock (LockOf(channelId))
        {
            message = messages.FirstOrDefault(m => m.Id == messageId);
            if (message is null) return "Message not found.";
            if (message.UserId != userId) return "You can delete your own messages only.";
            messages.Remove(message);
        }
        _channelOfMessage.TryRemove(messageId, out _);
        _gifService.DecrementReferences(message.GifAttachments);

        OnMessageDeleted?.Invoke(channelId, messageId);
        _writer.Enqueue(Writes.DeleteMessage(messageId));
        if (_channels.TryGetValue(channelId, out var channel) && channel.Pins.Any(p => p.MessageId == messageId))
        {
            lock (LockOf(channelId)) channel.Pins = channel.Pins.Where(p => p.MessageId != messageId).ToList();   // a deleted message leaves the panel (SH-48)
            PinsChanged(channel);
        }
        return null;
    }

    /// <summary>MR-40, MR-45. Toggles the person's reaction with that emoji. Anyone who can see the message can react.</summary>
    public string? ToggleReaction(Guid userId, string username, Guid messageId, string emoji)
    {
        if (emoji.Length is 0 or > 64) return "Not an emoji.";
        if (GetMessage(messageId) is not { } message) return "Message not found.";
        if (message.Kind != MessageKind.Normal) return "System lines do not accept reactions.";   // MR-45
        if (!_channels.TryGetValue(message.ChannelId, out var channel) || !channel.CanAccess(userId)) return "Message not found.";

        bool added;
        lock (message.Reactions)
        {
            var mine = message.Reactions.FirstOrDefault(r => r.Emoji == emoji && r.UserId == userId);
            if (mine is not null) { message.Reactions.Remove(mine); added = false; }
            else { message.Reactions.Add(new Reaction { MessageId = messageId, UserId = userId, Username = username, Emoji = emoji }); added = true; }
        }

        OnReactionChanged?.Invoke(message);
        _userService.RecordEmojiUse(userId, emoji);   // a reaction, added or removed, moves the emoji to the front of the recent list (MR-44, PK-07)
        _writer.Enqueue(added ? Writes.Reaction(messageId, userId, username, emoji) : Writes.DeleteReaction(messageId, userId, emoji));
        return null;
    }

    #endregion

    #region Pins

    /// <summary>MR-77, MR-78. Pins a message of the conversation for everyone in it: at most <see cref="Channel.MaxPins"/>, the newest pin first.</summary>
    public string? Pin(Guid userId, string username, Guid channelId, Guid messageId)
    {
        if (!_channels.TryGetValue(channelId, out var channel)) return "Conversation not found.";
        if (GetMessage(messageId) is not { } message || message.ChannelId != channelId || !MayRead(userId, message)) return "Message not found.";   // MayRead covers access and the history cutoff (TL-05)
        if (message.Kind != MessageKind.Normal) return "A system line cannot be pinned.";   // MR-80
        if (!channel.CanPin(userId, username, _userService.IsAdmin(userId))) return "You cannot pin messages here.";
        var media = PinMediaOf(message);   // outside the lock: it may read a cached card from disk
        lock (LockOf(channelId))
        {
            if (!_channelMessages.TryGetValue(channelId, out var messages) || !messages.Contains(message)) return "Message not found.";   // deleted since the check above; Delete looks for the pin only after this lock (MR-64)
            if (channel.Pins.Any(p => p.MessageId == messageId)) return null;   // someone else pinned it a moment ago: nothing to say
            if (channel.Pins.Count >= Channel.MaxPins) return $"Up to {Channel.MaxPins} pinned messages. Unpin one first.";
            channel.Pins = [Models.Chat.Pin.Of(message, username, media), .. channel.Pins];   // qualified: Pin is also this method
        }
        PinsChanged(channel);
        AddSystemLine(channel, userId, username, MessageKind.Pin, about: messageId);   // "{name} pinned a message" (MR-80); an unpin writes nothing
        return null;
    }

    /// <summary>
    /// A stored system line (MR-80): a row of the conversation that stays in the history like a message, so a person
    /// who opens the conversation later sees it at its place in time. Unlike a message it counts as unread for nobody
    /// and sends no push (NT-02), gets no link card and stops no typing. The author is the person who acted;
    /// <paramref name="about"/> is the message the line is about. The open tabs get it by the message event.
    /// </summary>
    private void AddSystemLine(Channel channel, Guid userId, string username, MessageKind kind, Guid about)
    {
        var line = new ChatMessage(channel.Id, userId, username, "", DateTime.UtcNow, replyToMessageId: about) { Kind = kind };
        lock (LockOf(channel.Id)) _channelMessages.GetOrAdd(channel.Id, _ => []).Add(line);
        _channelOfMessage[line.Id] = channel.Id;
        _writer.Enqueue(Writes.Message(line));   // queued before anyone hears of the row, as in Send
        OnMessageReceived?.Invoke(line);
    }

    /// <summary>MR-77. The pin goes; the message stays. Named by conversation and message, because a pinned message may be
    /// older than the messages in memory.</summary>
    public string? Unpin(Guid userId, string username, Guid channelId, Guid messageId)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(userId)) return "Conversation not found.";
        if (!channel.CanPin(userId, username, _userService.IsAdmin(userId))) return "You cannot unpin messages here.";
        lock (LockOf(channelId))
        {
            if (channel.Pins.All(p => p.MessageId != messageId)) return null;
            channel.Pins = channel.Pins.Where(p => p.MessageId != messageId).ToList();
        }
        PinsChanged(channel);
        return null;
    }

    /// <summary>The pins a person may see (SH-48): all of them for the admin and in a direct message; in a restricted room,
    /// only those inside the person's history cutoff (TL-05). A null viewer is the broadcaster's "everyone" of an unrestricted room.</summary>
    public List<Pin> PinsFor(Guid channelId, Guid? viewerId)
    {
        if (!_channels.TryGetValue(channelId, out var channel)) return [];
        var pins = channel.Pins;   // the list is replaced, never edited in place, so the reference is a snapshot
        return viewerId is { } viewer ? pins.Where(p => MayRead(viewer, channel, p.Timestamp)).ToList() : pins.ToList();
    }

    // After a new pin list was assigned: the event, then the row write. The write reads the channel when it runs.
    private void PinsChanged(Channel channel)
    {
        OnPinsChanged?.Invoke(channel);
        _writer.Enqueue(Writes.Channel(channel));
    }

    /// <summary>What the pin entry shows under the text (SH-48, <see cref="PinMedia"/>), in the row's order: every
    /// picture, every uploaded video, every GIF, the voice note; for a text message, the first link card that has
    /// something to show. The URLs are the row's own (MessageMapper), copied because the pin outlives the memory window.
    /// The panel opens a picture in the gallery viewer, so a picture carries its large and original files too: the
    /// client must not build them from the medium URL, the naming rule is the server's.</summary>
    private IReadOnlyList<PinMedia> PinMediaOf(ChatMessage m)
    {
        var list = AttachmentsOf(m);
        if (list.Count > 0) return list;
        var card = Previews(m).FirstOrDefault(p => p.Title is not null || p.ImageUrl is not null || p.Media is not null);
        return card switch
        {
            null => [],
            { Media: { Type: "video" } media } => [new("video", Src: media.Src, Poster: media.Poster ?? card.ImageUrl, Width: media.Width, Height: media.Height, Title: card.Title, Site: card.SiteName, Url: card.Url)],   // the size: the player's box before the poster loads, as in the row (MR-27)
            _ => [new("link", Poster: card.ImageUrl, Title: card.Title, Site: card.SiteName, Url: card.Url)],
        };
    }

    /// <summary>The message's own files in the shape of a pin entry: pictures, uploaded videos, GIFs, the voice note.
    /// A search result shows these and no link card (SR-08), so the hub maps a hit with this part alone.</summary>
    public List<PinMedia> AttachmentsOf(ChatMessage m)
    {
        var list = new List<PinMedia>();
        foreach (var image in m.ImageUrls)
        {
            var src = Media.ImageService.GetMediumUrl(image);
            var size = _mediaSizes.Of(src);   // the box before the file loads, as in the row
            list.Add(new("image", Src: src, Width: size?.Width, Height: size?.Height,
                Large: Media.ImageService.GetLargeUrl(image), Original: image));   // the viewer's stage and Download (TL-24)
        }
        foreach (var video in m.VideoUrls)
        {
            var poster = Media.VideoService.GetPosterUrl(video);
            var size = _mediaSizes.Of(poster);
            list.Add(new("video", Src: Media.VideoService.GetCompressedUrl(video), Poster: poster, Width: size?.Width, Height: size?.Height));
        }
        foreach (var gif in m.GifAttachments)
        {
            var entry = _gifService.GetEntry(gif.GifEntryId);
            if (entry is null || entry.DeletedAt is not null || entry.Src is null) { list.Add(new("gif")); continue; }   // the file is gone: the panel shows a label
            var (w, h) = gif.Width > 0 && gif.Height > 0 ? (gif.Width, gif.Height) : (entry.Width, entry.Height);
            list.Add(new("gif", Src: entry.Src, Width: w, Height: h, IsImage: entry.SrcIsImage));   // a GIF stays out of the viewer, as in the row (TL-22)
        }
        if (m.Voice is { } voice) list.Add(new("voice", Src: voice.Url, DurationMs: voice.DurationMs, Peaks: voice.Peaks));
        return list;
    }

    /// <summary>At start, once the GIF entries are in: the pins of messages still in memory get their media resolved
    /// again, so a pin made on an older build shows what this build shows (the whole gallery, the video itself). A
    /// text message's pin keeps its copy: its link card loads only when a page shows the link, and the copy is all there is.
    /// A picture pinned before 2026-11-04 whose message is no longer in memory gets its large URL from the medium one,
    /// by the same naming rule: the viewer's stage then shows the large file (TL-23). Its original stays unknown (the
    /// medium URL lost the extension), and the panel's Download falls back to the medium picture (TL-24).</summary>
    public void RefreshPinMedia()
    {
        foreach (var channel in _channels.Values)
        {
            foreach (var pin in channel.Pins)   // the refresh replaces channel.Pins with a new list; this loop walks the old one
                if (GetMessage(pin.MessageId) is { HasMedia: true } message) RefreshPinMedia(message);
            lock (LockOf(channel.Id))
            {
                if (!channel.Pins.Any(p => p.Media.Any(m => WithLarge(m) != m))) continue;
                channel.Pins = channel.Pins.Select(p => p with { Media = p.Media.Select(WithLarge).ToList() }).ToList();
            }
            _writer.Enqueue(Writes.Channel(channel));   // no event: at start nobody is connected, and a later call (VideoPosterBackfill) finds nothing left to upgrade
        }

        static PinMedia WithLarge(PinMedia m) =>
            m is { Kind: "image", Large: null, Src: { } src } && Media.ImageService.LargeOfMedium(src) is { } large ? m with { Large = large } : m;
    }

    /// <summary>The pin copy of a text message follows its link cards: the first scrape lands after the pin when
    /// someone pins a fresh message, and an edit can change the link.</summary>
    private void RefreshPinMedia(ChatMessage message)
    {
        if (!_channels.TryGetValue(message.ChannelId, out var channel) || channel.Pins.All(p => p.MessageId != message.Id)) return;
        var media = PinMediaOf(message);
        lock (LockOf(channel.Id))
        {
            if (channel.Pins.FirstOrDefault(p => p.MessageId == message.Id) is not { } pin || pin.Media.SequenceEqual(media)) return;   // records: value equality per item
            channel.Pins = channel.Pins.Select(p => p.MessageId == message.Id ? p with { Media = media } : p).ToList();
        }
        PinsChanged(channel);
    }

    private static readonly string[] DefaultQuickReactions = ["❤️", "😂", "👍"];

    /// <summary>The three quick reactions of the action bar: the person's most used, padded with the fixed three in
    /// order and without duplicates (MR-41).</summary>
    public List<string> QuickReactions(Guid userId)
    {
        var top = TopReactionEmojis(userId, 3);
        foreach (var e in DefaultQuickReactions)
        {
            if (top.Count >= 3) break;
            if (!top.Contains(e)) top.Add(e);
        }
        return top;
    }

    /// <summary>The emoji the person reacts with most (MR-41). Reactions only: typed emoji are a different habit.</summary>
    public List<string> TopReactionEmojis(Guid userId, int count)
    {
        var mine = new List<string>();
        foreach (var (channelId, messages) in _channelMessages)
            lock (LockOf(channelId))
                foreach (var message in messages)
                    lock (message.Reactions)
                        mine.AddRange(message.Reactions.Where(r => r.UserId == userId).Select(r => r.Emoji));
        return mine.GroupBy(e => e).OrderByDescending(g => g.Count()).Take(count).Select(g => g.Key).ToList();
    }

    /// <summary>Every image, video and voice URL a message in memory carries, and the pictures the pins keep. The admin's
    /// media clean-up matches uploads against it.</summary>
    public List<string> MediaUrls()
    {
        var urls = new List<string>();
        foreach (var (channelId, messages) in _channelMessages)
            lock (LockOf(channelId))
                foreach (var message in messages)
                {
                    urls.AddRange(message.ImageUrls);
                    urls.AddRange(message.VideoUrls);
                    if (message.Voice is { } voice) urls.Add(voice.Url);
                }
        // A pin's copy outlives the memory window (SH-48): its pictures, posters and files are in use as long as the pin is.
        foreach (var channel in _channels.Values)
            foreach (var item in channel.Pins.SelectMany(pin => pin.Media))
            {
                if (item.Src is { } src) urls.Add(src);
                if (item.Poster is { } poster) urls.Add(poster);
            }
        return urls;
    }

    #endregion

    #region Read state

    public int UnreadCount(Guid userId, Guid channelId) =>
        _readStates.TryGetValue((userId, channelId), out var state) ? state.UnreadCount : 0;

    /// <summary>The person's raw counts above zero, for the bootstrap. The client applies the mutes (NT-04, NT-09).</summary>
    public Dictionary<Guid, int> UnreadCounts(Guid userId) =>
        _readStates.Where(e => e.Key.UserId == userId && e.Value.UnreadCount > 0).ToDictionary(e => e.Key.ChannelId, e => e.Value.UnreadCount);

    /// <summary>The sum over unmuted conversations, for the push payload of a closed app (NT-11).</summary>
    public int TotalUnread(Guid userId)
    {
        var user = _userService.GetById(userId);
        if (user is null) return 0;
        return _readStates.Where(e => e.Key.UserId == userId && e.Value.UnreadCount > 0)
            .Where(e => _channels.TryGetValue(e.Key.ChannelId, out var ch) && !_notifications.IsMuted(user, ch.Id, ch.IsDirectMessage))
            .Sum(e => e.Value.UnreadCount);
    }

    /// <summary>
    /// Clears the whole conversation for the person (NT-06, NT-08). The hub calls it on open and when the client
    /// says the person read the newest message. Nothing is raised when nothing changed.
    /// </summary>
    public void MarkRead(Guid userId, Guid channelId, string source = "open", string? callerConnectionId = null)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(userId)) return;   // a channel id from the client is not an entry ticket
        var state = _readStates.GetOrAdd((userId, channelId), _ => new ChannelReadState { UserId = userId, ChannelId = channelId, UnreadCount = 0 });
        int had;
        lock (state)
        {
            had = state.UnreadCount;
            state.UnreadCount = 0;
            state.LastReadAt = DateTime.UtcNow;
        }
        if (had == 0) return;

        if (channel.IsDirectMessage)   // AD-27: the unread audit covers direct messages only
        {
            var session = callerConnectionId is null ? null : _presence.Get(callerConnectionId);
            _audit.RecordUnreadChange(_userService.GetById(userId)?.Username ?? "?", Describe(channel), "clear", had, source,
                _audit.DescribeCallerSession(session, _presence.EffectiveOf(userId)));
        }
        OnUnreadChanged?.Invoke(userId, channelId, 0);
        _writer.EnqueueCoalesced((userId, channelId), Writes.ReadState(state));   // the same key as the increments: the latest state wins
    }

    /// <summary>
    /// NT-02, NT-03: a direct message counts for the other person; a room message counts for everyone who has Yap
    /// open and everyone who has the room unmuted, minus the sender and the people reading the room right now
    /// (NT-07, see <see cref="PresenceService.Looking"/>). Returns each affected person's new count.
    /// </summary>
    private List<(Guid UserId, int Count)> IncrementUnread(Channel channel, Guid senderId)
    {
        IEnumerable<Guid> recipients;
        if (channel.IsDirectMessage)
            recipients = channel.GetOtherParticipantId(senderId) is { } other ? [other] : [];
        else
        {
            // A person who is reading the room sees the message. A count, an `unread` event and a read-state
            // write for them is work the client undoes with markRead a moment later; in a room of 800 on the
            // 2026-10-16 load test that was nearly all of the unread cost (one send and one write per member).
            var looking = _presence.Looking(channel.Id);
            recipients = _presence.ConnectedUserIds()
                .Concat(_userService.GetAllUsers().Where(u => !_notifications.IsMuted(u, channel.Id, isDirectMessage: false)).Select(u => u.Id))
                .Where(id => id != senderId && !looking.Contains(id)).Distinct();
        }

        var result = new List<(Guid, int)>();
        foreach (var userId in recipients)
        {
            var state = _readStates.GetOrAdd((userId, channel.Id), _ => new ChannelReadState { UserId = userId, ChannelId = channel.Id, LastReadAt = DateTime.MinValue });
            int count;
            lock (state) count = ++state.UnreadCount;
            result.Add((userId, count));

            if (channel.IsDirectMessage)
                _audit.RecordUnreadChange(_userService.GetById(userId)?.Username ?? "?", Describe(channel), "+1", count,
                    $"msg from {_userService.GetById(senderId)?.Username}", "—");
        }
        return result;
    }

    private static string Describe(Channel channel) =>
        channel.IsDirectMessage ? $"{channel.Participant1} ↔ {channel.Participant2}" : $"#{channel.Name}";

    #endregion

    #region Test data

    /// <summary>AD-08: real messages from the admin and five fictional people, spread over a span in bursts. No unread counts, no push.</summary>
    public int GenerateTestMessages(Guid channelId, Guid userId, string username, int count, TimeSpan span)
    {
        if (!_channels.ContainsKey(channelId) || count <= 0) return 0;
        var speakers = new List<(Guid Id, string Name)> { (userId, username) };
        speakers.AddRange(_fakeUsers);

        var now = DateTime.UtcNow;
        var cursor = now - span;
        var average = span.TotalSeconds / count;
        var rng = Random.Shared;
        var speaker = rng.Next(speakers.Count);
        var burst = rng.Next(1, 6);
        var made = new List<ChatMessage>(count);
        for (var i = 0; i < count; i++)
        {
            cursor = cursor.AddSeconds(average * (0.5 + rng.NextDouble()));
            if (cursor > now) cursor = now;
            var (id, name) = speakers[speaker];
            made.Add(new ChatMessage(channelId, id, name, $"[Test #{i + 1}/{count}] {_testPhrases[rng.Next(_testPhrases.Length)]}", cursor));
            if (--burst <= 0)
            {
                var next = rng.Next(speakers.Count - 1);
                speaker = next >= speaker ? next + 1 : next;
                burst = rng.Next(1, 6);
            }
        }

        lock (LockOf(channelId))
        {
            var messages = _channelMessages.GetOrAdd(channelId, _ => []);
            messages.AddRange(made);
            messages.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));
        }
        foreach (var m in made) _channelOfMessage[m.Id] = channelId;

        OnMessageReceived?.Invoke(made[^1]);   // only the last one is announced: the rows are history, seen whole at the next open
        _writer.Enqueue(Writes.Messages(made));
        return count;
    }

    private static readonly string[] _testPhrases =
    [
        "The quick brown fox jumps over the lazy dog",
        "Hello world! This is a test message",
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit",
        "Testing 1, 2, 3... Is this thing on?",
        "All your base are belong to us",
        "I'm sorry Dave, I'm afraid I can't do that",
        "To be or not to be, that is the question",
        "May the force be with you",
        "Here's looking at you, kid",
        "Life is like a box of chocolates",
        "Houston, we have a problem",
        "Elementary, my dear Watson",
        "That's one small step for man, one giant leap for mankind",
        "Winter is coming",
        "I'll be back",
        "Do or do not, there is no try",
        "Just keep swimming",
        "Bazinga!",
        "It's dangerous to go alone! Take this.",
        "The cake is a lie",
    ];

    private static readonly (Guid Id, string Name)[] _fakeUsers =
    [
        (Guid.Parse("aa000000-0000-0000-0000-000000000001"), "Alice"),
        (Guid.Parse("aa000000-0000-0000-0000-000000000002"), "Bob"),
        (Guid.Parse("aa000000-0000-0000-0000-000000000003"), "Charlie"),
        (Guid.Parse("aa000000-0000-0000-0000-000000000004"), "Diana"),
        (Guid.Parse("aa000000-0000-0000-0000-000000000005"), "Eve"),
    ];

    #endregion

    private Lock LockOf(Guid channelId) => _channelLocks.GetOrAdd(channelId, _ => new Lock());
}
