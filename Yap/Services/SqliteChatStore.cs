using Microsoft.EntityFrameworkCore;
using Yap.Data;
using Yap.Models;

namespace Yap.Services;

public sealed class SqliteChatStore(IDbContextFactory<ChatDbContext> dbFactory) : IChatStore
{
    // Copy persisted scalar/media fields once; navigation properties belong to the new context.
    private static ChatMessage DetachedMessage(ChatMessage message) => new(
        message.ChannelId, message.UserId, message.Username, message.Content, message.Timestamp,
        message.ImageUrls.ToList(), message.ReplyToMessageId, message.VideoUrls.ToList(), message.GifAttachments.ToList())
    {
        Id = message.Id,
        OperationId = message.OperationId,
        IsEdited = message.IsEdited
    };

    public async Task<TextSendReceipt?> GetTextReceiptAsync(Guid userId, Guid operationId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        return await db.TextSendReceipts.AsNoTracking().SingleOrDefaultAsync(r => r.UserId == userId && r.OperationId == operationId);
    }

    public async Task<ChatMessage?> GetAcceptedMessageAsync(Guid messageId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        return await db.Messages.AsNoTracking().Include(m => m.Reactions).SingleOrDefaultAsync(m => m.Id == messageId);
    }

    public async Task PersistTextAcceptanceAsync(ChatMessage message, TextSendReceipt receipt, IReadOnlyList<Guid>? recipients = null)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        await using var transaction = await db.Database.BeginTransactionAsync();
        db.Messages.Add(DetachedMessage(message));
        db.TextSendReceipts.Add(receipt);
        // A receipt promises both the message and recipient checkpoints. An unread write
        // failure must roll back acceptance so retry can safely complete all three.
        await db.SaveChangesAsync();
        await IncrementReadStatesAsync(db, message.ChannelId, recipients ?? []);
        await transaction.CommitAsync();
    }

    public async Task PersistMutationAsync(TextSendReceipt receipt, ChatMutation mutation)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var message = await db.Messages.Include(m => m.Reactions).SingleOrDefaultAsync(m => m.Id == receipt.MessageId && m.ChannelId == receipt.ChannelId);
        // Authorization and media rules have already run in ChatService under its acceptance gate.
        if (message != null)
        {
            if (mutation.Kind == "delete") db.Messages.Remove(message);
            else mutation.Apply(message);
        }
        else if (mutation.Kind != "delete")
            throw new ChatSendException(404, "message_unavailable", "Message unavailable.");
        db.TextSendReceipts.Add(receipt);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
    }

    public async Task DeleteChannelMessagesAsync(Guid channelId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        await db.Messages.Where(m => m.ChannelId == channelId).ExecuteDeleteAsync();
    }

    public async Task PruneReceiptsAsync(DateTime before)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        await db.TextSendReceipts.Where(r => r.AcceptedAt < before).ExecuteDeleteAsync();
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
        await using var db = await dbFactory.CreateDbContextAsync();
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

}
