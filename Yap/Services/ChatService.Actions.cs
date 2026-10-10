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
        if (!DurableSendingEnabled)
            throw new ChatSendException(503, "persistence_required", "Changes require server persistence.");
        if (operationId == Guid.Empty || kind is not ("edit" or "delete" or "reaction"))
            throw new ChatSendException(400, "invalid_operation", "Invalid message operation.");
        if (kind == "edit" && (string.IsNullOrWhiteSpace(content) || content.Length > MaxTextLength))
            throw new ChatSendException(400, "invalid_message", "Enter between 1 and 4000 characters.");
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
        await textSendGate.WaitAsync();
        try
        {
            // Old cached sends may have a different server ID; resolve the sender's own receipt.
            var originalSend = await _persistence.GetTextReceiptAsync(user.Id, messageId);
            if (originalSend?.ChannelId == channelId)
                messageId = originalSend.MessageId;
            var receipt = await _persistence.GetTextReceiptAsync(user.Id, operationId);
            if (receipt != null && (receipt.ChannelId != channelId || receipt.ContentHash != hash))
                throw new ChatSendException(409, "operation_conflict", "Operation ID already used for another change.");
            if (receipt == null)
            {
                var channel = GetChannel(channelId);
                if (channel == null || !channel.CanAccess(user.Id))
                    throw new ChatSendException(404, "conversation_unavailable", "Conversation unavailable.");
                if (!channel.CanWrite(user.Id, IsAdmin(user.Id)))
                    throw new ChatSendException(403, "read_only", "You cannot change messages in this conversation.");
                var target = GetMessageById(channelId, messageId);
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
                await _persistence.PersistMutationAsync(receipt, kind, content, emoji, active, user.Username);
            }
            // Reload current DB state even on duplicate acceptance. Never replay old payload over a newer edit.
            var persisted = await _persistence.GetAcceptedMessageAsync(messageId);
            ChatMessage? removed = null;
            lock (GetChannelLock(channelId))
            {
                if (_channelMessages.TryGetValue(channelId, out var messages))
                {
                    var index = messages.FindIndex(m => m.Id == messageId);
                    if (index >= 0)
                    {
                        removed = messages[index];
                        if (persisted == null)
                            messages.RemoveAt(index);
                        else
                            messages[index] = persisted;
                    }
                }
            }
            if (persisted == null)
            {
                if (removed != null)
                    _gifService.DecrementReferences(removed.GifAttachments);
                OnMessageDeleted?.Invoke(messageId, channelId);
            }
            else if (kind == "reaction")
                OnReactionChanged?.Invoke(persisted);
            else
                OnMessageUpdated?.Invoke(persisted);
            return receipt;
        }
        finally { textSendGate.Release(); }
    }
}
