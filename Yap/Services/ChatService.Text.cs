using System.Security.Cryptography;
using System.Text;
using Yap.Models;

namespace Yap.Services;

public sealed class ChatSendException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public partial class ChatService
{
    public bool DurableSendingEnabled => _persistence.IsEnabled;
    public const int MaxTextLength = 4000;

    public async Task<TextSendReceipt> SendTextAsync(User user, Guid channelId, Guid operationId, string? content, Guid? replyToMessageId = null, List<string>? images = null, List<string>? videos = null, List<GifAttachment>? gifs = null,
        string? mediaIdentity = null, Func<Task<(List<string>? Images, List<string>? Videos, List<GifAttachment>? Gifs)>>? resolveMedia = null)
    {
        if (!_persistence.IsEnabled)
            throw new ChatSendException(503, "persistence_required", "Sending requires server persistence to be enabled.");
        content ??= "";
        var hasMedia = mediaIdentity != null || (images?.Count ?? 0) + (videos?.Count ?? 0) + (gifs?.Count ?? 0) > 0;
        if (operationId == Guid.Empty || (!hasMedia && string.IsNullOrWhiteSpace(content)) || content.Length > MaxTextLength)
            throw new ChatSendException(400, "invalid_message", $"Enter between 1 and {MaxTextLength} characters.");
        // Receipt hashes are persistent protocol data. Preserve the existing field names,
        // order and raw-text case so a retry after an upgrade matches its saved receipt.
        string receiptPayload;
        if (mediaIdentity != null)
            receiptPayload = System.Text.Json.JsonSerializer.Serialize(new
            {
                content,
                replyToMessageId,
                mediaIdentity
            });
        else if (hasMedia)
            receiptPayload = System.Text.Json.JsonSerializer.Serialize(new
            {
                content,
                replyToMessageId,
                images,
                videos,
                gifs
            });
        else if (replyToMessageId != null)
            receiptPayload = System.Text.Json.JsonSerializer.Serialize(new
            {
                content,
                replyToMessageId
            });
        else
            receiptPayload = content;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(receiptPayload)));
        using (await LockAcceptance("message:" + operationId))
        {
            var previous = await _persistence.GetTextReceiptAsync(user.Id, operationId);
            if (previous != null)
            {
                if (previous.ChannelId != channelId || previous.ContentHash != hash)
                    throw new ChatSendException(409, "operation_conflict", "This send ID was already used for different content.");
                // Repair the process-local view after an ambiguous database commit, without repeating
                // notifications. A deleted row stays deleted; the receipt alone never recreates it.
                if (GetMessageById(channelId, previous.MessageId) == null)
                {
                    var persisted = await _persistence.GetAcceptedMessageAsync(previous.MessageId);
                    if (persisted != null)
                        lock (GetChannelLock(channelId))
                            if (_channelMessages.TryGetValue(channelId, out var messages) && !messages.Any(m => m.Id == persisted.Id))
                                messages.Add(persisted);
                }
                return previous; // Return even after a delete or a later permission change; never resend.
            }
            var channel = GetChannel(channelId);
            if (channel == null || !channel.CanAccess(user.Id))
                throw new ChatSendException(404, "conversation_unavailable", "This conversation is no longer available.");
            if (!channel.CanWrite(user.Id, IsAdmin(user.Id)))
                throw new ChatSendException(403, "read_only", "You no longer have permission to send in this conversation.");
            if (replyToMessageId is { } replyId && GetMessageById(channelId, replyId) is { } target && !CanReadMessage(user, target))
                throw new ChatSendException(404, "message_unavailable", "The reply target is unavailable.");
            // Resolve uploads/GIFs only for a new acceptance. A deleted file or GIF must not
            // make a previously accepted operation fail its replay or repeat provider side effects.
            if (resolveMedia != null)
                (images, videos, gifs) = await resolveMedia();
            var message = new ChatMessage(channelId, user.Id, user.Username, content, DateTime.UtcNow, images, replyToMessageId, videos, gifs) { Id = operationId, OperationId = operationId, ReplyToMessageId = replyToMessageId };
            var receipt = new TextSendReceipt
            {
                UserId = user.Id,
                OperationId = operationId,
                ChannelId = channelId,
                MessageId = message.Id,
                ContentHash = hash,
                AcceptedAt = message.Timestamp
            };
            List<Guid> affectedUserIds;
            try
            {
                affectedUserIds = await IncrementUnreadCountsAsync(channelId, user.Id,
                    async recipients =>
                    {
                        await _persistence.PersistTextAcceptanceAsync(message, receipt, recipients);
                        // Publish the row before its checkpoint becomes observable. A window
                        // must never acknowledge an arrival that is still absent from memory.
                        lock (GetChannelLock(channelId))
                            if (_channelMessages.TryGetValue(channelId, out var messages))
                                messages.Add(message);
                    });
            }
            catch (Microsoft.EntityFrameworkCore.DbUpdateException error) when (error.InnerException is Microsoft.Data.Sqlite.SqliteException { SqliteExtendedErrorCode: 1555 or 2067 })
            {
                var accepted = await _persistence.GetTextReceiptAsync(user.Id, operationId);
                if (accepted == null || accepted.ChannelId != channelId || accepted.ContentHash != hash)
                    throw new ChatSendException(409, "operation_conflict", "This send ID was already used for different content.");
                return accepted;
            }
            // Persistence is now authoritative. A notification failure cannot turn acceptance into failure.
            try
            {
                await PublishMessageAsync(channel, message, affectedUserIds);
            }
            catch (Exception ex) { _logger.LogError(ex, "Post-commit notification failed for {MessageId}", message.Id); }
            return receipt;
        }
    }

    public async Task<Channel> OpenDirectMessageAsync(User user, string username)
    {
        var other = _userService.GetByUsername(username);
        if (other == null || other.Id == user.Id)
            throw new ChatSendException(404, "user_unavailable", "That direct message is unavailable.");
        var pair = new[] { user.Id, other.Id }.Order().ToArray();
        using (await LockAcceptance($"dm:{pair[0]}:{pair[1]}"))
        {
            var existing = GetDMChannels(user.Username).FirstOrDefault(c => c.IsDMBetween(user.Id, other.Id));
            var channel = existing ?? Channel.CreateDM(user.Id, user.Username, other.Id, other.Username);
            // Await persistence before advertising a new conversation or allowing its first send.
            await _persistence.PersistChannelAsync(channel, throwOnFailure: true);
            if (existing == null)
            {
                _channels[channel.Id] = channel;
                _channelMessages[channel.Id] = new();
                _channelTypingUsers[channel.Id] = new();
                OnChannelCreated?.Invoke(channel);
            }
            return channel;
        }
    }
}
