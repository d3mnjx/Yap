using Yap.Models;

namespace Yap.Services;

// Acceptance has the same boundary in both modes: store first, publish memory second.
// SQLite survives restart; the memory backend shares the lifetime of the chat itself.
public interface IChatStore
{
    Task<TextSendReceipt?> GetTextReceiptAsync(Guid userId, Guid operationId);
    Task<ChatMessage?> GetAcceptedMessageAsync(Guid messageId);
    Task PersistTextAcceptanceAsync(ChatMessage message, TextSendReceipt receipt, IReadOnlyList<Guid>? recipients = null);
    Task PersistMutationAsync(TextSendReceipt receipt, ChatMutation mutation);
    Task PersistReadStateAsync(ChannelReadState state);
    Task DeleteChannelMessagesAsync(Guid channelId);
    Task PruneReceiptsAsync(DateTime before);
}
