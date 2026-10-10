using Yap.Offline;
using System.Collections.Concurrent;
using System.Diagnostics;
using Yap.Models;
using Yap.Services.Gifs;

namespace Yap.Services;

/// <summary>
/// Singleton service that holds all chat state and broadcasts changes via events.
/// Components subscribe to events and call StateHasChanged() to update their UI.
/// State is kept in-memory for fast access. When persistence is enabled, changes are
/// written through to the database and loaded on startup.
/// </summary>
public partial class ChatService
{
    private readonly ConcurrentDictionary<string, UserSession> _users = new();
    private readonly PushNotificationService _pushService;
    private readonly ChatPersistenceService _persistence;
    private readonly UserService _userService;
    private readonly LinkPreviewService _linkPreviewService;
    private readonly LinkPreviewSettingsService _linkPreviewSettings;
    private readonly MediaCacheService _mediaCacheService;
    private readonly GifService _gifService;
    private readonly NotificationAudit _audit;
    private readonly NotificationSettingsService _notifications;
    private readonly ILogger<ChatService> _logger;

    // Channels (rooms and DMs)
    private readonly ConcurrentDictionary<Guid, Channel> _channels = new();
    private readonly ConcurrentDictionary<Guid, List<ChatMessage>> _channelMessages = new();
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<string, DateTime>> _channelTypingUsers = new();
    private readonly OfflineChangeSignal _changes;

    // Unread tracking: (UserId, ChannelId) -> ChannelReadState
    private readonly ConcurrentDictionary<(Guid UserId, Guid ChannelId), ChannelReadState> _readStates = new();

    // Default lobby channel ID (updated in InitializeAsync if loaded from DB)
    private Guid _lobbyId;

    // Events for real-time updates (unified for all channel types)
    // All events are synchronous (Action) - handlers use fire-and-forget internally
    public event Action<ChatMessage>? OnMessageReceived;
    public event Action<ChatMessage>? OnMessageUpdated;
    public event Action<Guid, Guid>? OnMessageDeleted; // messageId, channelId
    public event Action<ChatMessage>? OnReactionChanged;
    public event Action<string, bool>? OnUserChanged;
    public event Action? OnUsersListChanged;
    public event Action<Guid>? OnTypingUsersChanged; // channelId

    // Channel events
    public event Action<Channel>? OnChannelCreated;
    public event Action<Channel>? OnChannelUpdated;
    public event Action<Guid>? OnChannelDeleted;

    // User status events
    public event Action<string, UserStatus>? OnUserStatusChanged; // username, newStatus

    // Unread state events
    public event Action<Guid, Guid>? OnUnreadChanged; // userId, channelId

    // Session kicked event (sessionId) - used to force-disconnect remote circuits
    public event Action<string>? OnSessionKicked;

    // Link preview ready (messageId) - fired when OG data is fetched for a message's URL
    public event Action<Guid>? OnLinkPreviewReady;

    // Media cache ready (messageId) - fired when yt-dlp download completes
    public event Action<Guid>? OnMediaCacheReady;

    // Per-user status (shared across all sessions for the same user)
    private readonly ConcurrentDictionary<string, UserStatus> _userStatuses = new(StringComparer.OrdinalIgnoreCase);

    // Auto-away tracking: username -> status to restore when user becomes active again.
    // Present in this dictionary = user was auto-away'd (by idle timer or disconnect timer).
    // Cleared on manual status change or when restored.
    private readonly ConcurrentDictionary<string, UserStatus> _statusBeforeAutoAway = new(StringComparer.OrdinalIgnoreCase);

    // Presence extras live in init-only props so the original positional construction stays untouched
    // (same idiom as CircuitTracker.CircuitInfo).
    public record UserSession(Guid UserId, string Username, string SessionId, bool? IsMobile = null, bool PageVisible = true, DateTime LastActivity = default, string? ClientIp = null)
    {
        public bool Connected { get; init; } = true; // Retained disconnected sessions still serve presence/reconnect recovery.
        public string? CircuitId { get; init; }       // joins this session to CircuitTracker's transport/RTT telemetry
        public string? ViewingChannel { get; init; }  // display label of the channel this session has open
        public DateTime CreatedAt { get; init; }
        public DateTime LastReportAt { get; init; }   // last client-state heartbeat — stale means frozen/disconnected/legacy client
    }

    private readonly Yap.Offline.ChatLimits _limits;

    public ChatService(PushNotificationService pushService, ChatPersistenceService persistence, UserService userService,
        LinkPreviewService linkPreviewService, LinkPreviewSettingsService linkPreviewSettings,
        MediaCacheService mediaCacheService, GifService gifService, NotificationAudit audit,
        NotificationSettingsService notifications, ILogger<ChatService> logger, Yap.Offline.ChatLimits limits, OfflineChangeSignal changes)
    {
        _changes = changes;
        _limits = limits;
        _pushService = pushService;
        _audit = audit;
        _notifications = notifications;
        _persistence = persistence;
        _userService = userService;
        _linkPreviewService = linkPreviewService;
        _linkPreviewSettings = linkPreviewSettings;
        _mediaCacheService = mediaCacheService;
        _gifService = gifService;
        _logger = logger;

        // Wire link preview callback
        _linkPreviewService.OnPreviewFetched = (msgId, url, preview) => OnLinkPreviewReady?.Invoke(msgId);

        // Wire media cache callback: attach media info to LinkPreview, then fire event
        _mediaCacheService.OnMediaCached = (msgId, url, entry) =>
        {
            var preview = _linkPreviewService.GetOrCreatePreview(url);
            preview.CachedMediaUrl = entry.LocalUrl;
            preview.CachedPosterUrl = entry.PosterUrl;
            preview.MediaType = entry.MediaType;
            preview.MediaDurationSeconds = entry.DurationSeconds;
            if (entry.Width > 0 && entry.Height > 0)
            {
                preview.MediaWidth = entry.Width;
                preview.MediaHeight = entry.Height;
            }
            // Fall back to yt-dlp's own title/thumbnail when the OG scrape didn't get them (e.g.
            // YouTube serves a bot/consent page with no og: tags). OG values win when present.
            if (string.IsNullOrEmpty(preview.Title)) preview.Title = entry.Title;
            if (string.IsNullOrEmpty(preview.ImageUrl)) preview.ImageUrl = entry.Thumbnail;
            // A successful media cache is a real preview even if the scrape was marked failed —
            // clear the flag so HasContent turns true and the card renders.
            if (!string.IsNullOrEmpty(preview.Title) || !string.IsNullOrEmpty(preview.ImageUrl) || !string.IsNullOrEmpty(preview.CachedMediaUrl))
                preview.Failed = false;
            OnMediaCacheReady?.Invoke(msgId);
        };

        // Create default lobby channel (will be replaced if loading from DB)
        var lobby = Channel.CreateRoom("lobby", createdById: null, createdBy: null, isDefault: true);
        _lobbyId = lobby.Id;
        _channels[lobby.Id] = lobby;
        _channelMessages[lobby.Id] = new List<ChatMessage>();
        _channelTypingUsers[lobby.Id] = new ConcurrentDictionary<string, DateTime>();
    }


    #region Diagnostics

    /// <summary>
    /// Gets diagnostic information about event subscribers and system state.
    /// </summary>
    public ChatDiagnostics GetDiagnostics()
    {
        return new ChatDiagnostics
        {
            UserSessions = _users.Count,
            UniqueUsers = _users.Values.Select(u => u.Username).Distinct().Count(),
            Channels = _channels.Count,
            RoomChannels = _channels.Values.Count(c => c.Type == ChannelType.Room),
            DmChannels = _channels.Values.Count(c => c.Type == ChannelType.DirectMessage),
            TotalMessages = _channelMessages.Values.Sum(m => m.Count),
            EventSubscribers = new Dictionary<string, int>
            {
                ["OnMessageReceived"] = OnMessageReceived?.GetInvocationList().Length ?? 0,
                ["OnMessageUpdated"] = OnMessageUpdated?.GetInvocationList().Length ?? 0,
                ["OnMessageDeleted"] = OnMessageDeleted?.GetInvocationList().Length ?? 0,
                ["OnReactionChanged"] = OnReactionChanged?.GetInvocationList().Length ?? 0,
                ["OnUserChanged"] = OnUserChanged?.GetInvocationList().Length ?? 0,
                ["OnUsersListChanged"] = OnUsersListChanged?.GetInvocationList().Length ?? 0,
                ["OnTypingUsersChanged"] = OnTypingUsersChanged?.GetInvocationList().Length ?? 0,
                ["OnChannelCreated"] = OnChannelCreated?.GetInvocationList().Length ?? 0,
                ["OnChannelUpdated"] = OnChannelUpdated?.GetInvocationList().Length ?? 0,
                ["OnChannelDeleted"] = OnChannelDeleted?.GetInvocationList().Length ?? 0,
                ["OnUserStatusChanged"] = OnUserStatusChanged?.GetInvocationList().Length ?? 0,
                ["OnUnreadChanged"] = OnUnreadChanged?.GetInvocationList().Length ?? 0
            },
            AdminUser = _userService.GetAdminUsername()
        };
    }

    #endregion

    /// <summary>
    /// Initializes chat data from the database if persistence is enabled.
    /// Called on application startup.
    /// </summary>
    public async Task InitializeAsync()
    {
        var snapshot = await _persistence.LoadSnapshotAsync();
        if (snapshot == null)
            return;

        // Clear default lobby (will be replaced from DB or recreated)
        _channels.Clear();
        _channelMessages.Clear();
        _channelTypingUsers.Clear();

        // Load channels from database
        foreach (var channel in snapshot.Channels)
        {
            _channels[channel.Id] = channel;
            _channelMessages[channel.Id] = snapshot.MessagesByChannel.GetValueOrDefault(channel.Id, new List<ChatMessage>());
            _channelTypingUsers[channel.Id] = new ConcurrentDictionary<string, DateTime>();
        }

        // Check for orphaned DM channels (participants that no longer exist as users)
        var orphanedDMs = _channels.Values
            .Where(c => c.Type == ChannelType.DirectMessage &&
                       (_userService.GetByUsername(c.Participant1 ?? "") == null ||
                        _userService.GetByUsername(c.Participant2 ?? "") == null))
            .ToList();

        if (orphanedDMs.Count > 0)
        {
            _logger.LogWarning("Found {Count} orphaned DM channel(s) with non-existent participants:", orphanedDMs.Count);
            foreach (var dm in orphanedDMs)
            {
                var p1Exists = _userService.GetByUsername(dm.Participant1 ?? "") != null;
                var p2Exists = _userService.GetByUsername(dm.Participant2 ?? "") != null;
                _logger.LogWarning("  - Channel {Id}: Participant1='{P1}' ({P1Status}), Participant2='{P2}' ({P2Status})",
                    dm.Id,
                    dm.Participant1 ?? "(null)", p1Exists ? "exists" : "MISSING",
                    dm.Participant2 ?? "(null)", p2Exists ? "exists" : "MISSING");
            }
        }

        // Load read states
        foreach (var readState in snapshot.ReadStates)
        {
            _readStates[(readState.UserId, readState.ChannelId)] = readState;
        }

        // Ensure lobby exists and update _lobbyId
        var existingLobby = _channels.Values.FirstOrDefault(c => c.Type == ChannelType.Room && c.IsDefault);
        if (existingLobby != null)
        {
            // Use lobby from database
            _lobbyId = existingLobby.Id;
        }
        else
        {
            // Create lobby if it doesn't exist in DB
            var lobby = Channel.CreateRoom("lobby", createdById: null, createdBy: null, isDefault: true);
            _lobbyId = lobby.Id;
            _channels[lobby.Id] = lobby;
            _channelMessages[lobby.Id] = new List<ChatMessage>();
            _channelTypingUsers[lobby.Id] = new ConcurrentDictionary<string, DateTime>();
            await _persistence.PersistChannelAsync(lobby);
        }
    }

    /// <summary>
    /// Gets the lobby channel ID.
    /// </summary>
    public Guid GetLobbyId() => _lobbyId;

    #region Admin

    public string? GetAdmin() => _userService.GetAdminUsername();

    public bool IsAdmin(string username) => _userService.IsAdmin(username);

    public bool IsAdmin(Guid userId) => _userService.IsAdmin(userId);

    #endregion

    #region Channel Management

    /// <summary>
    /// Gets or creates a lock object for a specific channel.
    /// This allows concurrent operations on different channels.
    /// </summary>
    internal object GetChannelLock(Guid channelId) =>
        _changes.ChannelLock(channelId);

    public List<Channel> GetRooms() =>
        _channels.Values
            .Where(c => c.Type == ChannelType.Room)
            .OrderBy(c => c.SortOrder)
            .ThenBy(c => c.CreatedAt)
            .ToList();

    public Channel? GetChannel(Guid channelId) =>
        _channels.TryGetValue(channelId, out var channel) ? channel : null;

    public async Task<Channel?> CreateRoomAsync(Guid adminUserId, string adminUsername, string roomName,
        string? description = null, ChannelPermission writePermission = ChannelPermission.Everyone,
        HistoryLimit historyLimit = HistoryLimit.OneMonth, bool sinceJoined = true)
    {
        if (!IsAdmin(adminUserId))
            return null;

        // Normalize room name
        roomName = roomName.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(roomName))
            return null;

        // Check if room already exists
        if (_channels.Values.Any(c => c.Type == ChannelType.Room &&
            c.Name.Equals(roomName, StringComparison.OrdinalIgnoreCase)))
            return null;

        // Auto-assign sort order: new rooms go to the bottom
        var maxSortOrder = _channels.Values
            .Where(c => c.Type == ChannelType.Room)
            .Select(c => c.SortOrder)
            .DefaultIfEmpty(-1)
            .Max();

        var channel = Channel.CreateRoom(roomName, adminUserId, adminUsername,
            description: description, sortOrder: maxSortOrder + 1, writePermission: writePermission,
            historyLimit: historyLimit, sinceJoined: sinceJoined);
        _channels[channel.Id] = channel;
        _channelMessages[channel.Id] = new List<ChatMessage>();
        _channelTypingUsers[channel.Id] = new ConcurrentDictionary<string, DateTime>();

        // Persist to database
        var sw = Stopwatch.StartNew();
        await _persistence.PersistChannelAsync(channel);

        _logger.LogDebug("CreateRoom '{RoomName}' by {User}: persist={ElapsedMs}ms", roomName, adminUsername, sw.ElapsedMilliseconds);

        _changes.Touch(channel.Id);
        OnChannelCreated?.Invoke(channel);

        return channel;
    }

    public async Task<bool> DeleteRoomAsync(Guid adminUserId, Guid channelId)
    {
        if (!IsAdmin(adminUserId))
            return false;

        if (!_channels.TryGetValue(channelId, out var channel))
            return false;

        // Cannot delete default lobby or DM channels
        if (channel.IsDefault || channel.IsDirectMessage)
            return false;

        _channels.TryRemove(channelId, out _);
        _channelMessages.TryRemove(channelId, out _);
        _channelTypingUsers.TryRemove(channelId, out _);
        _notifications.ClearOverridesForChannel(channelId);

        // Delete from database
        var sw = Stopwatch.StartNew();
        await _persistence.DeleteChannelAsync(channelId);

        _logger.LogDebug("DeleteRoom '{RoomName}' channel={ChannelId}: persist={ElapsedMs}ms", channel.Name, channelId, sw.ElapsedMilliseconds);

        _changes.Touch(channelId);
        OnChannelDeleted?.Invoke(channelId);

        return true;
    }

    /// <summary>
    /// Updates a channel's name, description and write permission. Admin only.
    /// Returns null on success, or an error message string on failure.
    /// </summary>
    public async Task<string?> UpdateChannelAsync(Guid adminUserId, Guid channelId, string name, string? description, ChannelPermission writePermission, HistoryLimit historyLimit = HistoryLimit.Unlimited, bool sinceJoined = false)
    {
        if (!IsAdmin(adminUserId))
            return "Not authorized.";

        if (!_channels.TryGetValue(channelId, out var channel))
            return "Channel not found.";

        if (channel.IsDirectMessage)
            return "Cannot edit DM channels.";

        // Normalize name
        name = name.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(name))
            return "Channel name is required.";

        // Check for duplicate name (excluding self)
        if (_channels.Values.Any(c => c.Type == ChannelType.Room &&
            c.Id != channelId &&
            c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            return "A channel with that name already exists.";

        channel.Name = name;
        channel.Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        channel.WritePermission = writePermission;
        channel.HistoryLimit = historyLimit;
        channel.SinceJoined = sinceJoined;

        var sw = Stopwatch.StartNew();
        await _persistence.PersistChannelAsync(channel);

        _logger.LogDebug("UpdateChannel '{ChannelName}' channel={ChannelId}: persist={ElapsedMs}ms",
            channel.Name, channelId, sw.ElapsedMilliseconds);

        _changes.Touch(channel.Id);
        OnChannelUpdated?.Invoke(channel);
        return null;
    }

    /// <summary>
    /// Moves a channel up or down in the sort order by swapping with the adjacent room.
    /// </summary>
    public async Task<bool> ReorderChannelAsync(Guid adminUserId, Guid channelId, bool moveUp)
    {
        if (!IsAdmin(adminUserId))
            return false;

        var rooms = GetRooms();
        var index = rooms.FindIndex(r => r.Id == channelId);
        if (index < 0)
            return false;

        var swapIndex = moveUp ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= rooms.Count)
            return false;

        // Swap sort orders
        var currentChannel = rooms[index];
        var adjacentChannel = rooms[swapIndex];
        (currentChannel.SortOrder, adjacentChannel.SortOrder) = (adjacentChannel.SortOrder, currentChannel.SortOrder);

        var sw = Stopwatch.StartNew();
        await _persistence.PersistChannelAsync(currentChannel);
        await _persistence.PersistChannelAsync(adjacentChannel);

        _logger.LogDebug("ReorderChannel '{ChannelName}' {Direction}: persist={ElapsedMs}ms",
            currentChannel.Name, moveUp ? "up" : "down", sw.ElapsedMilliseconds);

        _changes.Touch(currentChannel.Id);
        OnChannelUpdated?.Invoke(currentChannel);
        return true;
    }

    /// <summary>
    /// Gets or creates a DM channel between two users (by UserId)
    /// </summary>
    public Channel GetOrCreateDMChannel(Guid userId1, string username1, Guid userId2, string username2)
    {
        // Check if DM channel already exists
        var existing = _channels.Values.FirstOrDefault(c => c.IsDMBetween(userId1, userId2));
        if (existing != null)
            return existing;

        // Create new DM channel
        var channel = Channel.CreateDM(userId1, username1, userId2, username2);
        _channels[channel.Id] = channel;
        _channelMessages[channel.Id] = new List<ChatMessage>();
        _channelTypingUsers[channel.Id] = new ConcurrentDictionary<string, DateTime>();

        // Persist to database (fire and forget)
        _ = _persistence.PersistChannelAsync(channel);

        return channel;
    }

    /// <summary>
    /// Gets or creates a DM channel between two users (legacy - by username)
    /// </summary>
    public Channel? GetOrCreateDMChannelByUsername(string username1, string username2)
    {
        var user1 = _userService.GetByUsername(username1);
        var user2 = _userService.GetByUsername(username2);

        if (user1 == null || user2 == null)
            return null;

        return GetOrCreateDMChannel(user1.Id, user1.Username, user2.Id, user2.Username);
    }

    internal IEnumerable<Channel> GetAllDMChannels() => _channels.Values.Where(c => c.IsDirectMessage);

    /// <summary>
    /// Gets all DM channels for a user
    /// </summary>
    public List<Channel> GetDMChannels(string username) =>
        _channels.Values
            .Where(c => c.IsDirectMessage && c.CanAccess(username))
            .ToList();

    /// <summary>
    /// Gets all users that have DM history with the specified user, with the timestamp
    /// of the last message in each conversation. Channels without messages are skipped —
    /// opening /dm/{user} creates the channel eagerly, so an empty channel means someone
    /// merely peeked at a profile, not a conversation worth showing in the sidebar.
    /// </summary>
    public List<(string Username, DateTime LastMessageAt)> GetDMConversations(string username)
    {
        var conversations = new List<(string Username, DateTime LastMessageAt)>();

        foreach (var channel in GetDMChannels(username))
        {
            var partner = channel.GetOtherParticipant(username);
            if (string.IsNullOrWhiteSpace(partner))
                continue;

            DateTime? lastMessageAt;
            lock (GetChannelLock(channel.Id))
            {
                lastMessageAt = _channelMessages.TryGetValue(channel.Id, out var messages)
                    ? messages.LastOrDefault()?.Timestamp
                    : null;
            }

            if (lastMessageAt is { } last)
                conversations.Add((partner, last));
        }

        return conversations;
    }

    #endregion

    #region User Management

    public Task AddUserAsync(string sessionId, Guid userId, string username, UserStatus status = UserStatus.Online, bool? isMobile = null, string? clientIp = null, string? circuitId = null, bool pageVisible = true)
    {
        // Check if this is the first session for this user
        var existingSessions = _users.Values
            .Where(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
            .ToList();
        var isFirstSession = existingSessions.Count == 0;

        _users[sessionId] = new UserSession(userId, username, sessionId, isMobile, PageVisible: pageVisible, LastActivity: DateTime.UtcNow, ClientIp: clientIp)
        {
            CircuitId = circuitId,
            CreatedAt = DateTime.UtcNow,
            LastReportAt = DateTime.UtcNow
        };

        // Set status: only if first session (don't override active status from other devices)
        if (isFirstSession)
        {
            _userStatuses[username] = status;
        }

        _logger.LogDebug("AddUser {User} session={SessionId} status={Status} isFirst={IsFirst} totalSessions={TotalSessions}",
            username, sessionId, status, isFirstSession, _users.Count);

        // Only fire user-joined if this is the first session
        if (isFirstSession)
        {
            OnUserChanged?.Invoke(username, true);
        }
        _changes.Touch(OfflineChangeKind.People);
        OnUsersListChanged?.Invoke();

        return Task.CompletedTask;
    }

    /// <summary>
    /// Sets user status. When autoAwayPreviousStatus is provided, this is an auto-away change
    /// (records previous status for restoration). When null (default), this is a manual change
    /// (clears any auto-away state so activity won't restore it).
    /// </summary>
    public Task SetUserStatusAsync(string sessionId, UserStatus status, UserStatus? autoAwayPreviousStatus = null)
    {
        if (!_users.TryGetValue(sessionId, out var session))
            return Task.CompletedTask;

        var oldStatus = _userStatuses.GetValueOrDefault(session.Username, UserStatus.Online);
        _userStatuses[session.Username] = status;

        if (autoAwayPreviousStatus.HasValue)
        {
            // Auto-away: record what to restore to when user becomes active
            _statusBeforeAutoAway[session.Username] = autoAwayPreviousStatus.Value;
        }
        else
        {
            // Manual status change: clear any auto-away state
            _statusBeforeAutoAway.TryRemove(session.Username, out _);
        }

        _logger.LogDebug("SetUserStatus {User}: {OldStatus} -> {NewStatus} (autoAway={IsAutoAway})",
            session.Username, oldStatus, status, autoAwayPreviousStatus.HasValue);

        OnUserStatusChanged?.Invoke(session.Username, status);
        _changes.Touch(OfflineChangeKind.People);
        OnUsersListChanged?.Invoke();

        return Task.CompletedTask;
    }

    public UserStatus? GetUserStatus(string username)
    {
        return _userStatuses.TryGetValue(username, out var status) ? status : null;
    }

    /// <summary>
    /// The status the user held before auto-away kicked in, or null when their current status
    /// wasn't applied automatically. The record's existence is what MAKES an Away automatic —
    /// it's what activity restores via TryRestoreFromAutoAway. A chosen Away has no record and
    /// never self-reverts, so any code that re-applies or copies a status must go through here
    /// first: treating an auto-Away as chosen strands the user Away (mark-read-on-receive and
    /// push suppression both gate on Away → unread piles up and push fires mid-conversation).
    /// </summary>
    public UserStatus? GetStatusBeforeAutoAway(string username) =>
        _statusBeforeAutoAway.TryGetValue(username, out var status) ? status : null;

    /// <summary>True when the user's current Away was applied automatically (restore record exists).</summary>
    public bool IsAutoAway(string username) => _statusBeforeAutoAway.ContainsKey(username);

    /// <summary>
    /// Attempts to restore a user from auto-away to their previous status.
    /// Returns the restored status if successful, null if user wasn't auto-away.
    /// Can be called from any circuit/session for the user.
    /// </summary>
    public UserStatus? TryRestoreFromAutoAway(string sessionId)
    {
        if (!_users.TryGetValue(sessionId, out var session))
            return null;

        if (!_statusBeforeAutoAway.TryRemove(session.Username, out var restoreTo))
            return null;

        _userStatuses[session.Username] = restoreTo;

        _logger.LogDebug("Auto-away restored: {User} -> {Status}", session.Username, restoreTo);

        OnUserStatusChanged?.Invoke(session.Username, restoreTo);
        _changes.Touch(OfflineChangeKind.People);
        OnUsersListChanged?.Invoke();

        return restoreTo;
    }

    // Auto-away: a user goes Away when every session stops showing signs of life (rules below).
    private static readonly TimeSpan AutoAwayIdleThreshold = TimeSpan.FromMinutes(5);

    // A session whose last heartbeat is older than this has no live client behind it (frozen tab,
    // dead circuit, legacy JS) — its PageVisible/LastActivity are stale echoes, not presence.
    private static readonly TimeSpan HeartbeatStaleAfter = TimeSpan.FromSeconds(90);

    // "Live foreground client" = visible and heartbeated within ~3 probe intervals.
    private static readonly TimeSpan ForegroundReportWindow = TimeSpan.FromSeconds(35);

    /// <summary>
    /// Per-session client-state heartbeat from the latency probe (~10s foreground, ~60s hidden):
    /// real page visibility + seconds since last user input. The single source of presence truth —
    /// replaces inferring activity from circuit traffic, which the probe itself used to pollute
    /// (a visible idle tab reset the idle timer every 10s and could never go Away).
    /// </summary>
    public async Task ReportClientStateAsync(string sessionId, bool visible, double idleSeconds)
    {
        if (!double.IsFinite(idleSeconds)) return;                 // client input is untrusted
        idleSeconds = Math.Clamp(idleSeconds, 0, 86400);

        if (!_users.TryGetValue(sessionId, out var session)) return;

        var now = DateTime.UtcNow;
        _users[sessionId] = session with
        {
            PageVisible = visible,
            LastActivity = now.AddSeconds(-idleSeconds),
            LastReportAt = now
        };

        if (idleSeconds < 30)
        {
            TryRestoreFromAutoAway(sessionId);
        }
        else if (idleSeconds >= AutoAwayIdleThreshold.TotalSeconds)
        {
            await TrySetAutoAwayIfAllIdleAsync(sessionId);
        }
    }

    /// <summary>
    /// Heartbeat-driven auto-away: Away when EVERY session is input-idle past the threshold or has
    /// stopped heartbeating (frozen/disconnected/legacy client). Called from ReportClientStateAsync.
    /// </summary>
    public Task TrySetAutoAwayIfAllIdleAsync(string sessionId)
    {
        var now = DateTime.UtcNow;
        return TrySetAutoAwayCoreAsync(sessionId, sessions => sessions.All(u =>
            now - u.LastReportAt > HeartbeatStaleAfter ||
            now - u.LastActivity >= AutoAwayIdleThreshold));
    }

    /// <summary>
    /// Disconnect-driven auto-away (circuit grace timer): Away unless another device is a live
    /// foreground client RIGHT NOW (visible + recently heartbeating). Input-idle alone doesn't
    /// keep the user Online here — but a visible, heartbeating tab does, even if its user is just
    /// reading. Prevents the phone-locks → attended-desktop-flaps-to-Away regression.
    /// </summary>
    public Task TrySetAutoAwayAfterDisconnectAsync(string sessionId)
    {
        var now = DateTime.UtcNow;
        return TrySetAutoAwayCoreAsync(sessionId, sessions => !sessions.Any(u =>
            u.PageVisible && now - u.LastReportAt <= ForegroundReportWindow));
    }

    private async Task TrySetAutoAwayCoreAsync(string sessionId, Func<List<UserSession>, bool> shouldGoAway)
    {
        if (!_users.TryGetValue(sessionId, out var session)) return;

        // Never override an explicit Away or Invisible
        var currentStatus = GetUserStatus(session.Username);
        if (currentStatus is UserStatus.Away or UserStatus.Invisible) return;

        var sessions = _users.Values
            .Where(u => u.Username.Equals(session.Username, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (!shouldGoAway(sessions))
        {
            _logger.LogDebug("Auto-away skipped for {Username}: another session is active", session.Username);
            return;
        }

        _logger.LogDebug("Auto-away: no session for {Username} shows signs of life, setting Away", session.Username);
        await SetUserStatusAsync(sessionId, UserStatus.Away, autoAwayPreviousStatus: currentStatus ?? UserStatus.Online);
    }

    public void SetPageVisibility(string sessionId, bool visible)
    {
        if (_users.TryGetValue(sessionId, out var session))
            _users[sessionId] = session with { PageVisible = visible };
    }

    public bool IsPageVisible(string username)
    {
        return _users.Values
            .Where(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
            .Any(u => u.PageVisible);
    }

    /// <summary>
    /// Checks whether a SPECIFIC session's page is currently visible (foreground).
    /// Unlike <see cref="IsPageVisible"/> (an OR across all of a user's sessions), this is
    /// per-session — used to gate auto-mark-read so only the device you're actually looking at
    /// advances read state.
    /// </summary>
    public bool IsSessionPageVisible(string sessionId) =>
        _users.TryGetValue(sessionId, out var session) && session.PageVisible;

    /// <summary>
    /// Records which channel a session currently has open (display label, e.g. "#lobby" or "DM: bob").
    /// Diagnostic — the admin Sessions table uses it to answer "which device is parked on that DM".
    /// </summary>
    public void SetSessionViewing(string sessionId, string? label)
    {
        if (_users.TryGetValue(sessionId, out var session))
            _users[sessionId] = session with { ViewingChannel = label };
    }

    /// <summary>
    /// All live sessions across all users — the admin diagnostics "session truth table".
    /// </summary>
    public List<UserSession> GetAllSessions() => _users.Values.ToList();

    public Task RemoveUserAsync(string circuitId)
    {
        if (_users.TryRemove(circuitId, out var session))
        {
            // Remove from all typing indicators
            foreach (var typingUsers in _channelTypingUsers.Values)
            {
                typingUsers.TryRemove(session.Username, out _);
            }

            // Check if other sessions remain for this user
            var hasOtherSessions = _users.Values
                .Any(u => u.Username.Equals(session.Username, StringComparison.OrdinalIgnoreCase));

            _logger.LogDebug("RemoveUser {User} circuit={CircuitId} hasOtherSessions={HasOther} remainingSessions={TotalSessions}",
                session.Username, circuitId, hasOtherSessions, _users.Count);

            // Only fire user-left and clean up status if no other sessions remain
            if (!hasOtherSessions)
            {
                _userStatuses.TryRemove(session.Username, out _);
                _statusBeforeAutoAway.TryRemove(session.Username, out _);
                OnUserChanged?.Invoke(session.Username, false);
            }
            _changes.Touch(OfflineChangeKind.People);
            OnUsersListChanged?.Invoke();
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Gets all connected users (including invisible). For internal use.
    /// </summary>
    public List<string> GetOnlineUsers() =>
        _users.Values.Select(u => u.Username).Distinct().ToList();

    /// <summary>
    /// Gets all connected users with their status for UI display.
    /// Invisible users appear with gray dot (like "appears offline").
    /// </summary>
    public List<(string Username, UserStatus Status, bool? IsMobile)> GetAllUsersWithStatus() =>
        _users.Values
            .GroupBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
            .Select(g => (g.Key, _userStatuses.GetValueOrDefault(g.Key, UserStatus.Online), g.First().IsMobile))
            .ToList();

    public bool IsUsernameTaken(string username) =>
        _users.Values.Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Checks if any session for the given user is on mobile.
    /// </summary>
    public bool IsUserMobile(string username) =>
        _users.Values.Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase) && u.IsMobile == true);

    /// <summary>
    /// Checks if a session ID exists in the active users list.
    /// </summary>
    public bool HasSession(string sessionId) =>
        _users.ContainsKey(sessionId);

    /// <summary>
    /// Checks for any registered session, including disconnected recovery records.
    /// </summary>
    public bool HasActiveSession(string username)
    {
        return _users.Values
            .Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Marks transport connectivity without deleting retained presence state.
    /// </summary>
    public void SetSessionConnected(string sessionId, bool connected)
    {
        if (!_users.TryGetValue(sessionId, out var session) || session.Connected == connected) return;
        _users[sessionId] = session with { Connected = connected };
        _changes.Touch(OfflineChangeKind.People);
        OnUsersListChanged?.Invoke();
    }

    // Settings lists live connections, not the four-hour recovery records behind presence.
    public List<UserSession> GetActiveSessionsForUser(string username) =>
        GetSessionsForUser(username).Where(session => session.Connected).ToList();

    public List<UserSession> GetSessionsForUser(string username)
    {
        return _users.Values
            .Where(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    /// <summary>
    /// Builds a compact per-session description (id prefix, mobile flag, page-visibility, idle age)
    /// for a user. Diagnostic-only — used when logging push decisions to reveal which device
    /// (session) is forcing push suppression.
    /// </summary>
    private string DescribeRecipientSessions(string username)
    {
        var now = DateTime.UtcNow;
        var sessions = _users.Values
            .Where(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
            .Select(u => $"{u.SessionId[..Math.Min(8, u.SessionId.Length)]}(mobile={u.IsMobile} visible={u.PageVisible} idle={(int)(now - u.LastActivity).TotalSeconds}s)")
            .ToList();
        return sessions.Count == 0 ? "no sessions" : string.Join(", ", sessions);
    }

    /// <summary>
    /// Checks if a user has any active session from the given IP address.
    /// Used by Smart Mode to auto-login from same network.
    /// </summary>
    public bool HasActiveSessionFromIp(string username, string? ipAddress)
    {
        if (string.IsNullOrEmpty(ipAddress)) return false;
        return _users.Values.Any(u =>
            u.Username.Equals(username, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(u.ClientIp, ipAddress, StringComparison.Ordinal));
    }

    /// <summary>
    /// Removes all sessions for a user except the specified one.
    /// Used for "sign out all other devices". Does NOT fire OnUserChanged(left)
    /// since the user remains online via the kept session.
    /// </summary>
    public Task RemoveAllSessionsExcept(string username, string keepSessionId)
    {
        var sessionsToRemove = _users.Values
            .Where(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase)
                        && u.SessionId != keepSessionId)
            .ToList();

        foreach (var session in sessionsToRemove)
        {
            if (_users.TryRemove(session.SessionId, out _))
            {
                // Remove from typing indicators
                foreach (var typingUsers in _channelTypingUsers.Values)
                {
                    typingUsers.TryRemove(session.Username, out _);
                }
            }
        }

        if (sessionsToRemove.Count > 0)
        {
            _logger.LogInformation("RemoveAllSessionsExcept: removed {Count} sessions for {User}, kept {KeptSession}",
                sessionsToRemove.Count, username, keepSessionId);

            // Notify each kicked session so their circuit can force-navigate to login
            foreach (var session in sessionsToRemove)
            {
                OnSessionKicked?.Invoke(session.SessionId);
            }

            _changes.Touch(OfflineChangeKind.People);
            OnUsersListChanged?.Invoke();
        }

        return Task.CompletedTask;
    }

    #endregion

    #region Messaging

    public async Task SendMessageAsync(Guid channelId, Guid userId, string username, string content, List<string>? imageUrls = null, Guid? replyToMessageId = null, List<string>? videoUrls = null, List<GifAttachment>? gifAttachments = null)
    {
        if (!_channels.TryGetValue(channelId, out var channel) || !channel.CanAccess(userId)
            || !channel.CanWrite(userId, IsAdmin(userId))) return;
        var message = new ChatMessage(channelId, userId, username, content, DateTime.UtcNow, imageUrls, replyToMessageId, videoUrls, gifAttachments);
        await _persistence.PersistNewMessageAsync(message);
        await PublishMessageAsync(channel, message);
    }

    private async Task PublishMessageAsync(Channel channel, ChatMessage message, List<Guid>? acceptedRecipients = null)
    {
        var totalSw = Stopwatch.StartNew();
        var channelId = channel.Id;
        var userId = message.UserId;
        var username = message.Username;
        var content = message.Content;
        lock (GetChannelLock(channelId))
        {
            if (!_channelMessages.TryGetValue(channelId, out var messages)) return;
            if (messages.Any(m => m.Id == message.Id))
            {
                if (acceptedRecipients == null) return;
            }
            else messages.Add(message);
        }
        RunNotification(() => _gifService.IncrementReferences(message.GifAttachments));

        // Update unread counts in memory + DB (awaited — fast, no events)
        var unreadSw = Stopwatch.StartNew();
        List<Guid> affectedUserIds = acceptedRecipients ?? [];
        try { if (acceptedRecipients == null) affectedUserIds = await IncrementUnreadCountsAsync(channelId, userId); }
        catch (Exception error)
        {
            // Acceptance is already durable. The incremental stream has no periodic full
            // snapshot to repair a swallowed event, so publish even if unread persistence fails.
            _logger.LogError(error, "Unread persistence failed after accepting {MessageId}", message.Id);
        }
        var unreadMs = unreadSw.ElapsedMilliseconds;

        // Clear typing state in memory (fast, no event dispatch)
        var wasTyping = _channelTypingUsers.TryGetValue(channelId, out var typingUsers) && typingUsers.TryRemove(username, out _);

        _logger.LogDebug("PublishMessage by {User} to channel {ChannelId}: unread={UnreadMs}ms ({AffectedUsers} users) publishTotal={TotalMs}ms media={HasMedia}",
            username, channelId, unreadMs, affectedUserIds.Count, totalSw.ElapsedMilliseconds, message.HasMedia);

        // Notify all subscribers
        if (wasTyping)
            NotifySubscribers(OnTypingUsersChanged, channelId);

        _changes.Touch(message.ChannelId, message.Id, history: false);
        NotifySubscribers(OnMessageReceived, message);
        NotifyUnreadChanged(channelId, affectedUserIds);

        // Queue link preview fetches for URLs in the message (fire-and-forget)
        if (_linkPreviewSettings.Enabled && !message.HasMedia)
        {
            var urls = LinkPreviewService.ExtractUrls(content);
            foreach (var url in urls.Take(5))
            {
                RunNotification(() => _linkPreviewService.QueueFetch(message.Id, url));

                // Also queue media caching (yt-dlp determines if URL is supported)
                if (_linkPreviewSettings.MediaCachingEnabled)
                    RunNotification(() => _mediaCacheService.QueueDownload(message.Id, url));
            }
        }

        // Push (fire-and-forget, doesn't block the send).
        RunNotification(() => DispatchPush(channel, username, message, content));
    }

    /// <summary>
    /// Decides who gets a web push for a new message and sends it.
    /// </summary>
    /// <remarks>
    /// One suppression rule for both channel kinds: skip only a recipient who is actively looking,
    /// meaning Online AND holding some foreground session. Away deliberately does NOT suppress —
    /// Away is exactly when the phone push is wanted, and an idle-but-visible desktop must not eat it.
    /// Muted channels never reach here.
    /// </remarks>
    private void DispatchPush(Channel channel, string senderUsername, ChatMessage message, string content)
    {
        var preview = message.HasGifs ? "[GIF]"
                    : message.HasMedia ? "[Attachment]"
                    : content;

        foreach (var recipient in ResolvePushRecipients(channel, senderUsername))
        {
            var status = GetUserStatus(recipient.Username);
            var pageVisible = IsPageVisible(recipient.Username);
            var sessionsSnapshot = DescribeRecipientSessions(recipient.Username);
            var subCount = _pushService.GetSubscriptionCount(recipient.Username);
            var totalUnread = GetTotalUnreadCount(recipient.Id);

            // Diagnostic: show which session (device) makes the recipient "visible" and how many
            // push subscriptions they have — explains skipped pushes / silent phone.
            _logger.LogDebug("Push decision: to={Recipient} channel={Channel} status={Status} anyPageVisible={PageVisible} subscriptions={SubCount} sessions=[{Sessions}]",
                recipient.Username, DescribeChannel(channel), status, pageVisible, subCount, sessionsSnapshot);

            if (status == UserStatus.Online && pageVisible)
            {
                _audit.RecordPushDecision(senderUsername, recipient.Username, "suppressed: Online + visible", sessionsSnapshot, subCount, totalUnread);
                _logger.LogDebug("Push skipped: {Recipient} is Online and has a visible page", recipient.Username);
                continue;
            }

            _audit.RecordPushDecision(senderUsername, recipient.Username, "push", sessionsSnapshot, subCount, totalUnread);
            _logger.LogDebug("Push: from={From} to={To} channel={Channel} totalUnread={UnreadCount} status={Status}",
                senderUsername, recipient.Username, DescribeChannel(channel), totalUnread, status);

            _ = channel.IsDirectMessage
                ? _pushService.SendDmNotificationAsync(recipient.Username, senderUsername, preview, totalUnread)
                : _pushService.SendRoomNotificationAsync(recipient.Username, channel.Name, channel.Id, senderUsername, preview, totalUnread);
        }
    }

    /// <summary>
    /// The users a message could push to, before the presence check: the other DM participant, or
    /// every user who has this room unmuted. Rooms are muted by default, so the room branch
    /// normally yields nobody, and the scan over all users stays cheap.
    /// </summary>
    private IEnumerable<User> ResolvePushRecipients(Channel channel, string senderUsername)
    {
        if (channel.IsDirectMessage)
        {
            var other = channel.GetOtherParticipant(senderUsername);
            var user = other != null ? _userService.GetByUsername(other) : null;
            if (user != null && !_notifications.IsMuted(user, channel.Id, isDirectMessage: true))
                yield return user;
            yield break;
        }

        foreach (var user in _userService.GetAllUsers())
        {
            if (user.Username.Equals(senderUsername, StringComparison.OrdinalIgnoreCase)) continue;
            if (_notifications.IsMuted(user, channel.Id, isDirectMessage: false)) continue;
            yield return user;
        }
    }

    /// <summary>
    /// Generates test messages spread across a time span for debugging scroll and history limits.
    /// Messages are inserted directly into memory and DB without firing events.
    /// </summary>
    public async Task<int> GenerateTestMessagesAsync(Guid channelId, Guid userId, string username, int count, TimeSpan timeSpan)
    {
        if (!_channels.TryGetValue(channelId, out var channel))
            return 0;
        if (!_channelMessages.TryGetValue(channelId, out var messages))
            return 0;

        // Build participant list: real user + fake users
        var participants = new List<(Guid Id, string Name)> { (userId, username) };
        foreach (var fake in _fakeUsers)
            participants.Add((fake.Id, fake.Name));

        var now = DateTime.UtcNow;
        var start = now - timeSpan;
        var cursor = start;
        var avgInterval = timeSpan.TotalSeconds / count;

        var testMessages = new List<ChatMessage>(count);
        var rng = Random.Shared;
        var currentSpeaker = rng.Next(participants.Count);
        var burstRemaining = rng.Next(1, 6); // messages left in current speaker's "burst"

        for (int i = 0; i < count; i++)
        {
            // Advance time with some jitter (0.5x - 1.5x avg interval)
            cursor = cursor.AddSeconds(avgInterval * (0.5 + rng.NextDouble()));
            if (cursor > now) cursor = now;

            var (speakerId, speakerName) = participants[currentSpeaker];
            var content = $"[Test #{i + 1}/{count}] {_testPhrases[rng.Next(_testPhrases.Length)]}";
            testMessages.Add(new ChatMessage(channelId, speakerId, speakerName, content, cursor));

            burstRemaining--;
            if (burstRemaining <= 0)
            {
                // Switch to a different speaker
                var next = rng.Next(participants.Count - 1);
                if (next >= currentSpeaker) next++;
                currentSpeaker = next;
                burstRemaining = rng.Next(1, 6);
            }
        }

        // Insert into memory (sorted by timestamp, before any newer messages)
        lock (GetChannelLock(channelId))
        {
            messages.AddRange(testMessages);
            messages.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));
        }

        // Persist all to DB in one batch
        await _persistence.PersistMessagesInBulkAsync(testMessages);

        _logger.LogInformation("Generated {Count} test messages in channel {ChannelId} spanning {TimeSpan}", count, channelId, timeSpan);

        // Incremental subscribers need every inserted record; one final pulse no longer
        // causes a full snapshot rebuild. Their bounded queues coalesce this burst.
        foreach (var message in testMessages) { _changes.Touch(message.ChannelId, message.Id, history: false); OnMessageReceived?.Invoke(message); }

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

    internal bool HasMoreMessages(User user, Guid channelId, int limit)
    {
        lock (GetChannelLock(channelId))
        {
            if (!_channelMessages.TryGetValue(channelId, out var messages)) return false;
            var channel = GetChannel(channelId);
            if (IsAdmin(user.Id) || channel is { SinceJoined: false, HistoryLimit: HistoryLimit.Unlimited }) return messages.Count > limit;
            return messages.Where(m => CanReadMessage(user, m)).Take(limit + 1).Count() > limit;
        }
    }

    public List<ChatMessage> GetMessages(Guid channelId, int count = 50)
    {
        if (!_channelMessages.TryGetValue(channelId, out var messages))
            return new List<ChatMessage>();

        lock (GetChannelLock(channelId))
        {
            return messages.TakeLast(Math.Min(count, messages.Count)).ToList();
        }
    }

    /// <summary>
    /// Gets messages with pagination support for infinite scroll.
    /// Returns messages in chronological order (oldest first).
    /// When isAdmin is false, applies the channel's HistoryLimit cutoff.
    /// </summary>
    /// <param name="channelId">The channel ID</param>
    /// <param name="count">Number of messages to return</param>
    /// <param name="beforeTimestamp">Return messages older than this timestamp. Null = most recent.</param>
    /// <param name="isAdmin">If true, bypasses history limit and returns all messages.</param>
    /// <returns>Messages and whether there are more older messages available</returns>
    public (List<ChatMessage> Messages, bool HasMore) GetMessagesPaginated(
        Guid channelId,
        int count = 20,
        DateTime? beforeTimestamp = null,
        bool isAdmin = false,
        Guid? userId = null)
    {
        if (!_channelMessages.TryGetValue(channelId, out var messages))
            return (new List<ChatMessage>(), false);

        lock (GetChannelLock(channelId))
        {
            IEnumerable<ChatMessage> filtered = messages;

            // Apply history limit cutoff for non-admin users
            DateTime? historyCutoff = null;
            if (!isAdmin && _channels.TryGetValue(channelId, out var channel))
            {
                // Time-based cutoff (e.g. 1 month)
                historyCutoff = channel.GetHistoryCutoff();

                // "Since Joined" cutoff (user's signup date)
                if (channel.SinceJoined && userId.HasValue)
                {
                    var user = _userService.GetById(userId.Value);
                    var joinedAt = user?.CreatedAt ?? DateTime.UtcNow;
                    // Take the more restrictive (later) of the two
                    historyCutoff = historyCutoff.HasValue
                        ? (joinedAt > historyCutoff.Value ? joinedAt : historyCutoff.Value)
                        : joinedAt;
                }

                if (historyCutoff.HasValue)
                {
                    filtered = filtered.Where(m => m.Timestamp >= historyCutoff.Value);
                }
            }

            if (beforeTimestamp.HasValue)
            {
                filtered = filtered.Where(m => m.Timestamp < beforeTimestamp.Value);
            }

            var result = filtered
                .OrderByDescending(m => m.Timestamp)
                .Take(count)
                .OrderBy(m => m.Timestamp)
                .ToList();

            // Check if there are older messages (within the visible range)
            var oldestReturned = result.FirstOrDefault()?.Timestamp;
            bool hasMore;
            if (oldestReturned.HasValue)
            {
                if (historyCutoff.HasValue)
                    hasMore = messages.Any(m => m.Timestamp < oldestReturned.Value && m.Timestamp >= historyCutoff.Value);
                else
                    hasMore = messages.Any(m => m.Timestamp < oldestReturned.Value);
            }
            else
            {
                hasMore = false;
            }

            return (result, hasMore);
        }
    }

    public ChatMessage? GetMessageById(Guid channelId, Guid messageId)
    {
        if (!_channelMessages.TryGetValue(channelId, out var messages)) return null;
        lock (GetChannelLock(channelId))
        {
            return messages.FirstOrDefault(m => m.Id == messageId);
        }
    }

    /// <summary>
    /// The user's most-used reaction emojis for the quick-reaction bar. Reads full
    /// reaction history from the DB when persistence is on; otherwise counts reactions
    /// on in-memory messages, which ARE the complete history in memory-only mode.
    /// </summary>
    public async Task<List<string>> GetTopReactionEmojisAsync(Guid userId, int count)
    {
        if (_persistence.IsEnabled)
            return await _persistence.GetTopReactionEmojisAsync(userId, count);

        var mine = new List<Reaction>();
        foreach (var (chanId, messages) in _channelMessages)
        {
            lock (GetChannelLock(chanId))
            {
                foreach (var message in messages)
                {
                    lock (message.Reactions)
                    {
                        mine.AddRange(message.Reactions.Where(r => r.UserId == userId));
                    }
                }
            }
        }

        return mine
            .GroupBy(r => r.Emoji)
            .OrderByDescending(g => g.Count())
            .Take(count)
            .Select(g => g.Key)
            .ToList();
    }

    #endregion

    #region Unread Tracking

    /// <summary>
    /// Gets unread count for a user in a specific channel.
    /// </summary>
    public int GetUnreadCount(Guid userId, Guid channelId)
    {
        if (_readStates.TryGetValue((userId, channelId), out var state))
        {
            return state.UnreadCount;
        }
        return 0;
    }

    /// <summary>
    /// Increments unread count for all participants except the sender (memory + DB only).
    /// Returns the list of affected user IDs for notification.
    /// </summary>
    // One faulty listener must not suppress the stream, other listeners, or push.
    private void RunNotification(Action action)
    {
        try { action(); }
        catch (Exception error) { _logger.LogError(error, "Chat notification failed"); }
    }
    private void NotifySubscribers<T>(Action<T>? handlers, T value)
    {
        if (handlers == null) return;
        foreach (Action<T> handler in handlers.GetInvocationList()) RunNotification(() => handler(value));
    }

    private async Task<List<Guid>> IncrementUnreadCountsAsync(Guid channelId, Guid senderUserId,
        Func<IReadOnlyList<Guid>, Task>? accept = null)
    {
        if (!_channels.TryGetValue(channelId, out var channel))
            return new List<Guid>();

        // Collect user IDs to update
        var userIdsToIncrement = new List<Guid>();

        if (channel.IsDirectMessage)
        {
            var otherUserId = channel.GetOtherParticipantId(senderUserId);
            if (otherUserId.HasValue)
                userIdsToIncrement.Add(otherUserId.Value);
        }
        else
        {
            // Connected sessions, as before: that is what puts the unread dot on a room for people
            // who are actually here. Offline users are deliberately left out, so nobody comes back
            // to a sidebar full of dots for rooms they never opened.
            var live = _users.Values
                .Where(s => s.UserId != senderUserId)
                .Select(s => s.UserId);

            // Plus everyone who unmuted this room, connected or not. Their badge has to agree with
            // the push they are about to receive, and a push with no matching count is a lie.
            var subscribed = _userService.GetAllUsers()
                .Where(u => u.Id != senderUserId)
                .Where(u => !_notifications.IsMuted(u, channelId, isDirectMessage: false))
                .Select(u => u.Id);

            userIdsToIncrement = live.Concat(subscribed).Distinct().ToList();
        }

        if (userIdsToIncrement.Count == 0)
        {
            if (accept != null) await accept(userIdsToIncrement);
            return userIdsToIncrement;
        }

        await readStateGate.WaitAsync();
        try
        {
            var updated = userIdsToIncrement.Select(id =>
            {
                var state = CopyReadState(id, channelId);
                state.ReceivedCount++;
                state.UnreadCount++;
                return state;
            }).ToArray();
            if (accept != null) await accept(userIdsToIncrement);
            else
            {
                try { await _persistence.IncrementReadStatesAsync(channelId, userIdsToIncrement); }
                catch (Exception error) { _logger.LogError(error, "Legacy unread persistence failed for {ChannelId}", channelId); }
            }
            foreach (var state in updated) _readStates[(state.UserId, channelId)] = state;
            if (channel.IsDirectMessage)
                foreach (var state in updated)
                    RunNotification(() => _audit.RecordUnreadChange(_userService.GetById(state.UserId)?.Username ?? "?", DescribeChannel(channel), "+1",
                        state.UnreadCount, $"msg from {_userService.GetById(senderUserId)?.Username}", "—"));
        }
        finally { readStateGate.Release(); }

        return userIdsToIncrement;
    }

    /// <summary>Channel label for audit rows — "#room" or "alice ↔ bob" for DMs.</summary>
    private static string DescribeChannel(Channel channel) =>
        channel.IsDirectMessage ? $"{channel.Participant1} ↔ {channel.Participant2}" : $"#{channel.Name}";

    /// <summary>
    /// Fires OnUnreadChanged for all affected users.
    /// </summary>
    private void NotifyUnreadChanged(Guid channelId, List<Guid> userIds)
    {
        foreach (var userId in userIds)
        {
            _changes.Touch(OfflineChangeKind.Unread, userId, channelId);
            if (OnUnreadChanged is { } handlers)
                foreach (Action<Guid, Guid> handler in handlers.GetInvocationList())
                    RunNotification(() => handler(userId, channelId));
        }
    }

    /// <summary>
    /// Gets the user's app-wide unread count: every channel that still notifies them, DM or room.
    /// This is the number on the mailbox icon, the PWA app badge, and every push payload.
    /// </summary>
    /// <remarks>
    /// Muted channels are excluded here, not at increment time. They keep counting internally so
    /// the sidebar can still show a dot, and so unmuting reveals a true count.
    /// </remarks>
    /// <param name="userId">The user ID</param>
    /// <param name="excludeChannelId">Optional channel ID to exclude (e.g., currently viewed channel)</param>
    public int GetTotalUnreadCount(Guid userId, Guid? excludeChannelId = null)
    {
        var user = _userService.GetById(userId);
        if (user == null) return 0;

        return _readStates
            .Where(kvp => kvp.Key.UserId == userId && kvp.Value.UnreadCount > 0)
            .Where(kvp => excludeChannelId == null || kvp.Key.ChannelId != excludeChannelId)
            .Where(kvp => _channels.TryGetValue(kvp.Key.ChannelId, out var ch)
                          && !_notifications.IsMuted(user, ch.Id, ch.IsDirectMessage))
            .Sum(kvp => kvp.Value.UnreadCount);
    }

    /// <summary>
    /// Whether a channel is muted for a user. Convenience for components, which hold a channel id
    /// but not always the channel: resolves the DM-versus-room question here.
    /// </summary>
    public bool IsChannelMuted(Guid userId, Guid channelId)
    {
        if (!_channels.TryGetValue(channelId, out var channel)) return false;
        return _notifications.IsMuted(userId, channelId, channel.IsDirectMessage);
    }

    /// <summary>
    /// Clears all read states for a user (used when user is deleted).
    /// </summary>
    public void ClearReadStatesForUser(Guid userId)
    {
        var keysToRemove = _readStates.Keys.Where(k => k.UserId == userId).ToList();
        foreach (var key in keysToRemove)
        {
            _readStates.TryRemove(key, out _);
        }
    }

    #endregion

    #region DM-specific helpers

    /// <summary>
    /// Gets the timestamp of the last message in a DM channel
    /// </summary>
    public DateTime? GetLastDMTimestamp(string user1, string user2)
    {
        var channel = _channels.Values.FirstOrDefault(c => c.IsDMBetween(user1, user2));
        if (channel == null || !_channelMessages.TryGetValue(channel.Id, out var messages) || messages.Count == 0)
            return null;

        lock (GetChannelLock(channel.Id))
        {
            return messages.LastOrDefault()?.Timestamp;
        }
    }

    #endregion

    #region Typing Indicators

    public Task StartTypingAsync(Guid channelId, string username)
    {
        if (_channelTypingUsers.TryGetValue(channelId, out var typingUsers))
        {
            typingUsers[username] = DateTime.UtcNow;
            _logger.LogDebug("StartTyping {User} in channel {ChannelId}", username, channelId);
            OnTypingUsersChanged?.Invoke(channelId);
        }
        return Task.CompletedTask;
    }

    public Task StopTypingAsync(Guid channelId, string username)
    {
        if (_channelTypingUsers.TryGetValue(channelId, out var typingUsers))
        {
            typingUsers.TryRemove(username, out _);
            _logger.LogDebug("StopTyping {User} in channel {ChannelId}", username, channelId);
            OnTypingUsersChanged?.Invoke(channelId);
        }
        return Task.CompletedTask;
    }

    public List<string> GetTypingUsers(Guid channelId)
    {
        if (!_channelTypingUsers.TryGetValue(channelId, out var typingUsers))
            return new List<string>();

        // Take a snapshot first (ToArray on ConcurrentDictionary is more atomic than enumeration)
        var snapshot = typingUsers.ToArray();
        var now = DateTime.UtcNow;

        // Separate active from stale based on the snapshot
        var active = new List<string>();
        var stale = new List<string>();

        foreach (var kvp in snapshot)
        {
            if ((now - kvp.Value).TotalMilliseconds > _limits.TypingTimeoutMs)
                stale.Add(kvp.Key);
            else
                active.Add(kvp.Key);
        }

        // Clean up stale entries
        foreach (var user in stale)
            typingUsers.TryRemove(user, out _);

        return active;
    }

    #endregion
}
