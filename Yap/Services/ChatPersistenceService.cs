using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Yap.Configuration;
using Yap.Data;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Handles optional persistence for channel configuration, preferences and startup snapshots.
/// Message, mutation and checkpoint acceptance belongs to IChatStore.
/// When disabled, all methods are no-ops.
/// </summary>
public class ChatPersistenceService
{
    private readonly IDbContextFactory<ChatDbContext>? _dbFactory;
    private readonly ILogger<ChatPersistenceService> _logger;

    public bool IsEnabled { get; }

    public ChatPersistenceService(
        IServiceProvider serviceProvider,
        IOptions<PersistenceSettings> settings,
        ILogger<ChatPersistenceService> logger)
    {
        _logger = logger;
        IsEnabled = settings.Value.Enabled;

        if (IsEnabled)
        {
            _dbFactory = serviceProvider.GetService<IDbContextFactory<ChatDbContext>>();
            if (_dbFactory == null)
            {
                _logger.LogWarning("Persistence is enabled but DbContextFactory is not registered");
                IsEnabled = false;
            }
            else
            {
                _logger.LogInformation("Chat persistence enabled with {Provider}", settings.Value.Provider);
            }
        }
    }

    #region Channel Operations

    public async Task PersistChannelAsync(Channel channel, bool throwOnFailure = false)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            var existing = await db.Channels.FindAsync(channel.Id);
            if (existing != null)
            {
                db.Entry(existing).CurrentValues.SetValues(channel);
            }
            else
            {
                db.Channels.Add(channel);
            }

            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist channel {ChannelId}", channel.Id);
            if (throwOnFailure) throw;
        }
    }

    public async Task DeleteChannelAsync(Guid channelId)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            // Notification overrides have no FK to Channel (see ChatDbContext), so nothing
            // cascades them away — delete them here or a recycled id inherits stale mutes.
            await db.ChannelNotificationSettings.Where(s => s.ChannelId == channelId).ExecuteDeleteAsync();
            await db.Channels.Where(c => c.Id == channelId).ExecuteDeleteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete channel {ChannelId}", channelId);
        }
    }

    #endregion

    #region Reaction Operations

    /// <summary>
    /// The emojis this user reacts with most, straight from reaction history.
    /// Deliberately reactions-only — what you react with and what you type into messages
    /// are different habits, so typed emojis never influence the quick-reaction bar.
    /// Ties break toward the most recently used emoji (higher row id = newer reaction).
    /// </summary>
    public async Task<List<string>> GetTopReactionEmojisAsync(Guid userId, int count)
    {
        if (!IsEnabled) return new();

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            return await db.Reactions
                .Where(r => r.UserId == userId)
                .GroupBy(r => r.Emoji)
                .OrderByDescending(g => g.Count())
                .ThenByDescending(g => g.Max(r => r.Id))
                .Take(count)
                .Select(g => g.Key)
                .ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load top reaction emojis for user {UserId}", userId);
            return new();
        }
    }

    #endregion

    #region Notification Settings Operations

    /// <summary>
    /// Writes one user's mute override for one channel.
    /// </summary>
    public async Task PersistChannelNotificationSettingAsync(ChannelNotificationSetting setting)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            var existing = await db.ChannelNotificationSettings.FindAsync(setting.UserId, setting.ChannelId);
            if (existing != null)
            {
                existing.Muted = setting.Muted;
            }
            else
            {
                db.ChannelNotificationSettings.Add(new ChannelNotificationSetting
                {
                    UserId = setting.UserId,
                    ChannelId = setting.ChannelId,
                    Muted = setting.Muted
                });
            }

            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist notification setting for user {UserId} channel {ChannelId}",
                setting.UserId, setting.ChannelId);
        }
    }

    /// <summary>
    /// Loads every per-channel mute override. Called once at startup.
    /// </summary>
    public async Task<List<ChannelNotificationSetting>> LoadChannelNotificationSettingsAsync()
    {
        if (!IsEnabled) return new();

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            return await db.ChannelNotificationSettings.AsNoTracking().ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load channel notification settings");
            return new();
        }
    }

    #endregion

    #region Push Subscription Operations

    public async Task SavePushSubscriptionAsync(PushSubscription subscription)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            var existing = await db.PushSubscriptions.FindAsync(subscription.Endpoint);
            if (existing != null)
            {
                existing.Username = subscription.Username;
                existing.P256dh = subscription.P256dh;
                existing.Auth = subscription.Auth;
            }
            else
            {
                db.PushSubscriptions.Add(subscription);
            }

            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save push subscription");
        }
    }

    public async Task RemovePushSubscriptionAsync(string endpoint)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            await db.PushSubscriptions.Where(p => p.Endpoint == endpoint).ExecuteDeleteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove push subscription");
        }
    }

    public async Task RemovePushSubscriptionsByUsernameAsync(string username)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            await db.PushSubscriptions.Where(p => p.Username == username).ExecuteDeleteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove push subscriptions for user {Username}", username);
        }
    }

    public async Task<List<PushSubscription>> GetAllPushSubscriptionsAsync()
    {
        if (!IsEnabled) return new List<PushSubscription>();

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            return await db.PushSubscriptions.AsNoTracking().ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get all push subscriptions");
            return new List<PushSubscription>();
        }
    }

    #endregion

    #region Snapshot Loading

    /// <summary>
    /// Loads all channels, messages, and read states from the database.
    /// Returns null if persistence is disabled.
    /// </summary>
    public async Task<ChatSnapshot?> LoadSnapshotAsync()
    {
        if (!IsEnabled) return null;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            var channels = await db.Channels
                .AsNoTracking()
                .ToListAsync();

            var messages = await db.Messages
                .Include(m => m.Reactions)
                .AsNoTracking()
                .ToListAsync();

            var readStates = await db.ChannelReadStates
                .AsNoTracking()
                .ToListAsync();

            var messagesByChannel = messages
                .GroupBy(m => m.ChannelId)
                .ToDictionary(
                    g => g.Key,
                    g => g.OrderBy(m => m.Timestamp).ToList()
                );

            _logger.LogInformation(
                "Loaded {ChannelCount} channels, {MessageCount} messages, {ReadStateCount} read states from database",
                channels.Count, messages.Count, readStates.Count);

            return new ChatSnapshot(channels, messagesByChannel, readStates);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load chat snapshot from database");
            return null;
        }
    }

    #endregion
}

/// <summary>
/// Represents a snapshot of chat data loaded from the database.
/// </summary>
public record ChatSnapshot(
    List<Channel> Channels,
    Dictionary<Guid, List<ChatMessage>> MessagesByChannel,
    List<ChannelReadState> ReadStates
);
