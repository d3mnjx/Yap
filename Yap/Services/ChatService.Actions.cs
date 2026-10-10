using System.Security.Cryptography;
using System.Text.Json;
using Yap.Models;

namespace Yap.Services;

public partial class ChatService
{
    public bool CanReadMessage(User user, ChatMessage message)
    {
        var channel = GetChannel(message.ChannelId);
        if (channel == null || !channel.CanAccess(user.Id))
            return false;
        if (IsAdmin(user.Id))
            return true;
        var cutoff = channel.GetHistoryCutoff();
        return (!cutoff.HasValue || message.Timestamp >= cutoff) && (!channel.SinceJoined || message.Timestamp >= user.CreatedAt);
    }

    public async Task<TextSendReceipt> MutateMessageAsync(User user, Guid channelId, Guid messageId,
        Guid operationId, string kind, string? content, string? emoji, bool active)
    {
        if (operationId == Guid.Empty || kind is not ("edit" or "delete" or "reaction"))
            throw new ChatSendException(400, "invalid_operation", "Invalid message operation.");
        if (kind == "edit" && (string.IsNullOrWhiteSpace(content) || content.Length > MaxTextLength))
            throw new ChatSendException(400, "invalid_message", $"Enter between 1 and {MaxTextLength} characters.");
        if (kind == "reaction" && (string.IsNullOrWhiteSpace(emoji) || emoji.Length > 100 || emoji.Any(char.IsControl)))
            throw new ChatSendException(400, "invalid_reaction", "Invalid reaction.");
        var hash = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            kind,
            messageId,
            content,
            emoji,
            active
        })));
        using (await LockAcceptance($"operation:{user.Id}:{operationId}"))
        {
            // Old cached sends may have a different server ID; resolve the sender's own receipt.
            var originalSend = await _store.GetTextReceiptAsync(user.Id, messageId);
            if (originalSend?.ChannelId == channelId)
                messageId = originalSend.MessageId;
            using var messageLock = await LockAcceptance("message:" + messageId);
            var receipt = await _store.GetTextReceiptAsync(user.Id, operationId);
            if (receipt != null && (receipt.ChannelId != channelId || receipt.ContentHash != hash))
                throw new ChatSendException(409, "operation_conflict", "Operation ID already used for another change.");
            if (receipt != null)
                return receipt; // Never apply an old payload over newer accepted state.
            ChatMessage? target;
            var mutation = new ChatMutation(kind, content, emoji, active, user.Id, user.Username);
            var channel = GetChannel(channelId);
            if (channel == null || !channel.CanAccess(user.Id))
                throw new ChatSendException(404, "conversation_unavailable", "Conversation unavailable.");
            if (!channel.CanWrite(user.Id, IsAdmin(user.Id)))
                throw new ChatSendException(403, "read_only", "You cannot change messages in this conversation.");
            target = GetMessageById(channelId, messageId);
            if (target == null && kind != "delete")
                throw new ChatSendException(404, "message_unavailable", "Message unavailable.");
            if (target != null && kind != "reaction" && target.UserId != user.Id)
                throw new ChatSendException(403, "not_owner", "You can only change your own messages.");
            if (kind == "edit" && target!.HasMedia)
                throw new ChatSendException(400, "media_message", "Media messages cannot be edited.");
            if (target != null && !CanReadMessage(user, target))
                throw new ChatSendException(404, "message_unavailable", "Message unavailable.");
            receipt = new TextSendReceipt
            {
                UserId = user.Id,
                OperationId = operationId,
                ChannelId = channelId,
                MessageId = messageId,
                ContentHash = hash,
                AcceptedAt = DateTime.UtcNow
            };
            await _store.PersistMutationAsync(receipt, mutation);
            lock (GetChannelLock(channelId))
            {
                if (_channelMessages.TryGetValue(channelId, out var messages) && target != null)
                {
                    if (kind == "delete")
                        messages.Remove(target);
                    else
                        mutation.Apply(target);
                }
            }
            // Publish only after the accepted mutation is visible on the existing object.
            _changes.Touch(channelId, messageId);
            if (kind is "edit" or "delete")
                foreach (var reply in GetMessages(channelId, int.MaxValue).Where(m => m.ReplyToMessageId == messageId))
                    _changes.Touch(channelId, reply.Id);
            if (kind == "delete")
            {
                if (target != null)
                    RunNotification(() => _gifService.DecrementReferences(target.GifAttachments));
                if (OnMessageDeleted is { } handlers)
                    foreach (Action<Guid, Guid> handler in handlers.GetInvocationList())
                        RunNotification(() => handler(messageId, channelId));
            }
            else if (kind == "reaction")
                NotifySubscribers(OnReactionChanged, target!);
            else
                NotifySubscribers(OnMessageUpdated, target!);
            return receipt;
        }
    }
}
