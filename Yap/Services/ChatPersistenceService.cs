using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Yap.Configuration;
using Yap.Data;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Handles write-through persistence for chat data.
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

    #region Message Operations

    public async Task PersistNewMessageAsync(ChatMessage message)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            // Create a detached copy to avoid navigation property issues
            var newMessage = new ChatMessage(
                message.ChannelId,
                message.UserId,
                message.Username,
                message.Content,
                message.Timestamp,
                message.ImageUrls.ToList(),
                message.ReplyToMessageId,
                message.VideoUrls.ToList(),
                message.GifAttachments.ToList()
            )
            {
                Id = message.Id,
                OperationId = message.OperationId,
                IsEdited = message.IsEdited
            };

            db.Messages.Add(newMessage);
            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist new message {MessageId}", message.Id);
            // Legacy server/bot messages remain best-effort; callers still publish in memory.
        }
    }

    public async Task<TextSendReceipt?> GetTextReceiptAsync(Guid userId, Guid operationId)
    {
        await using var db = await _dbFactory!.CreateDbContextAsync();
        return await db.TextSendReceipts.AsNoTracking().SingleOrDefaultAsync(r => r.UserId == userId && r.OperationId == operationId);
    }

    public async Task<ChatMessage?> GetAcceptedMessageAsync(Guid messageId)
    {
        await using var db = await _dbFactory!.CreateDbContextAsync();
        return await db.Messages.AsNoTracking().Include(m => m.Reactions).SingleOrDefaultAsync(m => m.Id == messageId);
    }

    public async Task PersistTextAcceptanceAsync(ChatMessage message, TextSendReceipt receipt, IReadOnlyList<Guid>? recipients = null)
    {
        if (!IsEnabled) throw new InvalidOperationException("Durable sends require persistence.");
        await using var db = await _dbFactory!.CreateDbContextAsync();
        await using var transaction = await db.Database.BeginTransactionAsync();
        db.Messages.Add(new ChatMessage(message.ChannelId, message.UserId, message.Username, message.Content, message.Timestamp, message.ImageUrls, message.ReplyToMessageId, message.VideoUrls, message.GifAttachments)
        { Id = message.Id, OperationId = message.OperationId, ReplyToMessageId = message.ReplyToMessageId });
        db.TextSendReceipts.Add(receipt);
        // A receipt promises both the message and recipient checkpoints. An unread write
        // failure must roll back acceptance so retry can safely complete all three.
        await db.SaveChangesAsync();
        await IncrementReadStatesAsync(db, message.ChannelId, recipients ?? []);
        await transaction.CommitAsync();
    }

    public async Task PersistMutationAsync(TextSendReceipt receipt, string kind, string? content, string? emoji, bool active, string username)
    {
        await using var db = await _dbFactory!.CreateDbContextAsync();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var message = await db.Messages.Include(m => m.Reactions).SingleOrDefaultAsync(m => m.Id == receipt.MessageId && m.ChannelId == receipt.ChannelId);
        if (message == null && kind != "delete")
            throw new ChatSendException(404, "message_unavailable", "This message was deleted or is no longer available.");
        if (message != null)
        {
            if (kind != "reaction" && message.UserId != receipt.UserId)
                throw new ChatSendException(403, "not_owner", "You can only change your own messages.");
            if (kind == "edit")
            {
                if (message.HasMedia) throw new ChatSendException(400, "media_message", "Media messages cannot be edited.");
                message.Content = content!; message.IsEdited = true;
            }
            else if (kind == "delete") db.Messages.Remove(message);
            else
            {
                var existing = message.Reactions.Where(r => r.UserId == receipt.UserId && r.Emoji == emoji).ToArray();
                if (!active) db.Reactions.RemoveRange(existing);
                else if (existing.Length == 0) message.Reactions.Add(new Reaction
                {
                    MessageId = message.Id,
                    UserId = receipt.UserId,
                    Username = username,
                    Emoji = emoji!
                });
            }
        }
        // Mutation and receipt must commit together: a retry must not undo a newer accepted edit.
        db.TextSendReceipts.Add(receipt);
        await db.SaveChangesAsync(); await transaction.CommitAsync();
    }

    public async Task PersistMessagesInBulkAsync(IReadOnlyList<ChatMessage> messages)
    {
        if (!IsEnabled || messages.Count == 0) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            var detached = messages.Select(m => new ChatMessage(
                m.ChannelId, m.UserId, m.Username, m.Content, m.Timestamp, m.ImageUrls.ToList(),
                m.ReplyToMessageId, m.VideoUrls.ToList(), m.GifAttachments.ToList())
            {
                Id = m.Id,
                IsEdited = m.IsEdited
            });

            db.Messages.AddRange(detached);
            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to bulk persist {Count} messages", messages.Count);
        }
    }

    public async Task PersistMessageEditAsync(Guid messageId, string newContent)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            await db.Messages
                .Where(m => m.Id == messageId)
                .ExecuteUpdateAsync(m => m
                    .SetProperty(x => x.Content, newContent)
                    .SetProperty(x => x.IsEdited, true));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist message edit {MessageId}", messageId);
        }
    }

    public async Task DeleteMessageAsync(Guid messageId)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            await db.Messages.Where(m => m.Id == messageId).ExecuteDeleteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete message {MessageId}", messageId);
        }
    }

    #endregion

    #region Reaction Operations

    public async Task AddReactionAsync(Guid messageId, Guid userId, string username, string emoji)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            // Check if reaction already exists
            var exists = await db.Reactions.AnyAsync(r =>
                r.MessageId == messageId &&
                r.Emoji == emoji &&
                r.UserId == userId);

            if (!exists)
            {
                db.Reactions.Add(new Reaction
                {
                    MessageId = messageId,
                    UserId = userId,
                    Username = username,
                    Emoji = emoji
                });
                await db.SaveChangesAsync();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to add reaction to message {MessageId}", messageId);
        }
    }

    public async Task RemoveReactionAsync(Guid messageId, Guid userId, string emoji)
    {
        if (!IsEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            await db.Reactions
                .Where(r => r.MessageId == messageId && r.Emoji == emoji && r.UserId == userId)
                .ExecuteDeleteAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove reaction from message {MessageId}", messageId);
        }
    }

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

    #region Read State Operations

    // json_each uses one parameter for any recipient count (no SQLite variable-limit cliff).
    // The read-state gate in ChatService spans this transaction and memory publication.
    public async Task IncrementReadStatesAsync(Guid channelId, IReadOnlyList<Guid> recipients)
    {
        if (!IsEnabled || recipients.Count == 0) return;
        await using var db = await _dbFactory!.CreateDbContextAsync();
        await using var transaction = await db.Database.BeginTransactionAsync();
        await IncrementReadStatesAsync(db, channelId, recipients);
        await transaction.CommitAsync();
    }

    private static async Task IncrementReadStatesAsync(ChatDbContext db, Guid channelId, IReadOnlyList<Guid> recipients)
    {
        if (recipients.Count == 0) return;
        var channel = channelId.ToString().ToUpperInvariant();
        var ids = System.Text.Json.JsonSerializer.Serialize(recipients.Select(id => id.ToString().ToUpperInvariant()));
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT OR IGNORE INTO ChannelReadStates (UserId, ChannelId, LastReadAt, UnreadCount, ReceivedCount, ReadThrough) SELECT value, {channel}, {DateTime.MinValue}, 0, 0, 0 FROM json_each({ids})");
        await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE ChannelReadStates SET UnreadCount = UnreadCount + 1, ReceivedCount = ReceivedCount + 1 WHERE ChannelId = {channel} AND UserId IN (SELECT value FROM json_each({ids}))");
    }

    public Task PersistReadStateAsync(ChannelReadState state) => PersistReadStatesAsync([state]);

    public async Task PersistReadStatesAsync(IEnumerable<ChannelReadState> states)
    {
        if (!IsEnabled) return;
        await using var db = await _dbFactory!.CreateDbContextAsync();
        foreach (var state in states)
        {
            var existing = await db.ChannelReadStates.FindAsync(state.UserId, state.ChannelId);
            if (existing == null) { existing = new ChannelReadState { UserId = state.UserId, ChannelId = state.ChannelId }; db.ChannelReadStates.Add(existing); }
            existing.LastReadAt = state.LastReadAt;
            existing.UnreadCount = state.UnreadCount;
            existing.ReceivedCount = state.ReceivedCount;
            existing.ReadThrough = state.ReadThrough;
        }
        await db.SaveChangesAsync();
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
