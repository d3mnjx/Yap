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
    public int MaxTextLength => _limits.MaxTextLength;

    public async Task<TextSendReceipt> SendTextAsync(User user, Guid channelId, Guid operationId, string? content, Guid? replyToMessageId = null, List<string>? images = null, List<string>? videos = null, List<GifAttachment>? gifs = null,
        string? mediaIdentity = null, Func<Task<(List<string>? Images, List<string>? Videos, List<GifAttachment>? Gifs)>>? resolveMedia = null)
    {
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
        using (await LockAcceptance($"operation:{user.Id}:{operationId}"))
        {
            var previous = await _store.GetTextReceiptAsync(user.Id, operationId);
            if (previous != null)
            {
                if (previous.ChannelId != channelId || previous.ContentHash != hash)
                    throw new ChatSendException(409, "operation_conflict", "This send ID was already used for different content.");
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
            var message = new ChatMessage(channelId, user.Id, user.Username, content, DateTime.UtcNow, images, replyToMessageId, videos, gifs) { OperationId = operationId, ReplyToMessageId = replyToMessageId };
            var receipt = new TextSendReceipt
            {
                UserId = user.Id,
                OperationId = operationId,
                ChannelId = channelId,
                MessageId = message.Id,
                ContentHash = hash,
                AcceptedAt = message.Timestamp
            };
            await AcceptMessageAsync(channel, message, receipt);
            return receipt;
        }
    }

    private async Task AcceptMessageAsync(Channel channel, ChatMessage message, TextSendReceipt receipt, bool countUnread = true)
    {
        async Task Store(IReadOnlyList<Guid> recipients)
        {
            try
            {
                await _store.PersistTextAcceptanceAsync(message, receipt, recipients);
            }
            catch (Microsoft.EntityFrameworkCore.DbUpdateException error) when (error.InnerException is Microsoft.Data.Sqlite.SqliteException { SqliteExtendedErrorCode: 1555 or 2067 })
            {
                // Competing same-account retries share a gate. A remaining PK collision
                // is conflicting intent, not a temporary error to retry forever.
                throw new ChatSendException(409, "operation_conflict", "This send ID was already used.");
            }
            // The message must be visible before its arrival checkpoint can be observed.
            lock (GetChannelLock(channel.Id))
                if (_channelMessages.TryGetValue(channel.Id, out var messages))
                {
                    messages.Add(message);
                    if (!countUnread)
                        messages.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));
                }
        }
        List<Guid> recipients = [];
        if (countUnread)
            recipients = await IncrementUnreadCountsAsync(channel.Id, message.UserId, Store);
        else
            await Store([]);
        // Acceptance is authoritative. Notification failures cannot turn it into a retry.
        try
        {
            if (countUnread)
                await PublishMessageAsync(channel, message, recipients);
            else
            {
                // Historical admin fixtures appear in streams without firing arrival push.
                _changes.Touch(channel.Id, message.Id, history: false);
                NotifySubscribers(OnMessageReceived, message);
            }
        }
        catch (Exception error) { _logger.LogError(error, "Post-commit notification failed for {MessageId}", message.Id); }
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
                _changes.Touch(channel.Id);
                OnChannelCreated?.Invoke(channel);
            }
            return channel;
        }
    }
}
