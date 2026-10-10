using Yap.Models;

namespace Yap.Services;

public sealed class MemoryChatStore : IChatStore
{
    private readonly object gate = new();
    private readonly Dictionary<(Guid UserId, Guid OperationId), TextSendReceipt> receipts = new();
    // References are the accepted live objects, not a second copy of message state.
    private readonly Dictionary<Guid, ChatMessage> messages = new();

    public Task<TextSendReceipt?> GetTextReceiptAsync(Guid userId, Guid operationId)
    {
        lock (gate) return Task.FromResult(receipts.GetValueOrDefault((userId, operationId)));
    }
    public Task<ChatMessage?> GetAcceptedMessageAsync(Guid messageId)
    {
        lock (gate) return Task.FromResult(messages.GetValueOrDefault(messageId));
    }
    public Task PersistTextAcceptanceAsync(ChatMessage message, TextSendReceipt receipt, IReadOnlyList<Guid>? recipients = null)
    {
        lock (gate)
        {
            if (messages.ContainsKey(message.Id) || receipts.ContainsKey((receipt.UserId, receipt.OperationId)))
                throw new ChatSendException(409, "operation_conflict", "Operation ID already accepted.");
            receipts.Add((receipt.UserId, receipt.OperationId), receipt);
            messages.Add(message.Id, message);
        }
        // ChatService publishes checkpoints and the message before emitting any events.
        return Task.CompletedTask;
    }
    public Task PersistMutationAsync(TextSendReceipt receipt, ChatMutation mutation)
    {
        lock (gate)
        {
            if (!receipts.TryAdd((receipt.UserId, receipt.OperationId), receipt))
                throw new ChatSendException(409, "operation_conflict", "Operation ID already accepted.");
            if (mutation.Kind == "delete") messages.Remove(receipt.MessageId);
        }
        // ChatService applies the validated mutation to the live object after acceptance.
        return Task.CompletedTask;
    }
    public Task PersistReadStateAsync(ChannelReadState state) => Task.CompletedTask;
    public Task DeleteChannelMessagesAsync(Guid channelId)
    {
        lock (gate)
            foreach (var id in messages.Where(p => p.Value.ChannelId == channelId).Select(p => p.Key).ToArray())
                messages.Remove(id);
        return Task.CompletedTask;
    }
    public Task PruneReceiptsAsync(DateTime before)
    {
        lock (gate)
            foreach (var key in receipts.Where(p => p.Value.AcceptedAt < before).Select(p => p.Key).ToArray())
                receipts.Remove(key);
        return Task.CompletedTask;
    }
}
