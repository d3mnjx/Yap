using System.Collections.Concurrent;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Answers "should this channel notify this user right now?" for every notification sink:
/// sidebar badges, the app-wide unread total, the tab title and sound, and web push.
/// </summary>
/// <remarks>
/// Muting is a display-and-delivery filter, not a counting filter. Unread counts keep
/// incrementing for muted channels so the sidebar can still show the small dot, and so
/// unmuting reveals a true count instead of starting from zero.
///
/// Deliberately does NOT depend on ChatService: ChatService is the caller (push decisions,
/// unread totals), and a mutual dependency would not resolve. Callers therefore pass
/// <c>isDirectMessage</c>, which they always know from the channel they already hold.
/// </remarks>
public class NotificationSettingsService
{
    public event Action<Guid, Guid>? OnChanged;
    private readonly UserService _userService;
    private readonly ChatPersistenceService _persistence;
    private readonly ILogger<NotificationSettingsService> _logger;

    // (userId, channelId) -> muted. Only channels the user explicitly flipped appear here.
    private readonly ConcurrentDictionary<(Guid UserId, Guid ChannelId), bool> _overrides = new();

    private readonly OfflineChangeSignal _changes;

    public NotificationSettingsService(
        UserService userService,
        ChatPersistenceService persistence,
        ILogger<NotificationSettingsService> logger, OfflineChangeSignal changes)
    {
        _userService = userService;
        _persistence = persistence;
        _logger = logger;
        _changes = changes;
    }

    /// <summary>
    /// Loads the per-channel overrides from the database. Called once at startup.
    /// </summary>
    public async Task InitializeAsync()
    {
        var settings = await _persistence.LoadChannelNotificationSettingsAsync();
        foreach (var s in settings)
            _overrides[(s.UserId, s.ChannelId)] = s.Muted;

        _logger.LogInformation("Loaded {Count} channel notification overrides", settings.Count);
    }

    #region Evaluation

    /// <summary>
    /// Whether the user muted the whole server. An elapsed timed mute reads as unmuted.
    /// </summary>
    public bool IsServerMuted(User user)
    {
        if (!user.NotifServerMuted) return false;

        // A timed mute expires on its own. The stored flag is left alone here (this runs on hot
        // read paths and must not write); ClearExpiredServerMuteAsync tidies it when the user
        // next opens the settings.
        return user.NotifServerMuteUntil is not { } until || until > DateTime.UtcNow;
    }

    /// <summary>
    /// Whether a channel notifies this user. True means: no badge, no unread total, no push,
    /// no sound. The unread dot still appears.
    /// </summary>
    public bool IsMuted(User user, Guid channelId, bool isDirectMessage)
    {
        if (IsServerMuted(user)) return true;

        var mode = isDirectMessage ? user.NotifDmMode : user.NotifRoomMode;
        return mode switch
        {
            NotificationMode.AllowAll => false,
            NotificationMode.MuteAll => true,
            _ => _overrides.TryGetValue((user.Id, channelId), out var muted)
                    ? muted
                    : DefaultForUntouchedChannel(user, isDirectMessage)
        };
    }

    /// <inheritdoc cref="IsMuted(User, Guid, bool)"/>
    public bool IsMuted(Guid userId, Guid channelId, bool isDirectMessage)
    {
        var user = _userService.GetById(userId);
        return user != null && IsMuted(user, channelId, isDirectMessage);
    }

    /// <summary>
    /// The fallback for a channel the user has no override row for, in Individual mode.
    /// DMs follow the user's "New DMs" choice; a room nobody opted into stays muted.
    /// </summary>
    private static bool DefaultForUntouchedChannel(User user, bool isDirectMessage) =>
        isDirectMessage ? user.NotifNewDmsMuted : true;

    /// <summary>
    /// The stored override for one channel, ignoring server mute and the class mode. This is what
    /// the per-channel toggles in Settings show, so they keep their positions while the user flips
    /// between Individual and the blanket modes.
    /// </summary>
    public bool IsChannelMutedIndividually(User user, Guid channelId, bool isDirectMessage) =>
        _overrides.TryGetValue((user.Id, channelId), out var muted)
            ? muted
            : DefaultForUntouchedChannel(user, isDirectMessage);

    #endregion

    #region Mutations

    /// <summary>
    /// Sets one channel's override for one user.
    /// </summary>
    public async Task SetChannelMutedAsync(Guid userId, Guid channelId, bool muted)
    {
        _overrides[(userId, channelId)] = muted;
        await _persistence.PersistChannelNotificationSettingAsync(new ChannelNotificationSetting
        {
            UserId = userId,
            ChannelId = channelId,
            Muted = muted
        });
        _changes.Touch(OfflineChangeKind.Unread, userId, channelId);
        OnChanged?.Invoke(userId, channelId);
    }

    /// <summary>
    /// Turns a server mute that has run out back into a plain "allowed" state, so the settings UI
    /// and the stored row agree. Returns true when something changed.
    /// </summary>
    public async Task<bool> ClearExpiredServerMuteAsync(User user)
    {
        if (!user.NotifServerMuted) return false;
        if (user.NotifServerMuteUntil is not { } until || until > DateTime.UtcNow) return false;

        await _userService.SetServerMuteAsync(user.Id, muted: false, until: null);
        _logger.LogDebug("Cleared expired server mute for {Username}", user.Username);
        return true;
    }

    /// <summary>
    /// Drops the overrides for a deleted channel, so a recycled channel id cannot inherit them.
    /// </summary>
    public void ClearOverridesForChannel(Guid channelId)
    {
        foreach (var key in _overrides.Keys.Where(k => k.ChannelId == channelId).ToList())
            _overrides.TryRemove(key, out _);
    }

    #endregion
}
