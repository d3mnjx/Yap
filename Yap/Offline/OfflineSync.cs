using Yap.Models;
using Yap.Services;

namespace Yap.Offline;

/// <summary>A message on the wire; author profiles travel once per update, rather than once per message.</summary>
public record SyncMessage(Guid Id, Guid? OperationId, Guid AuthorId, string Content, DateTime Timestamp,
    bool IsEdited, Guid? ReplyToMessageId, ReaderImage[] Images, string[] Videos, int GifCount,
    ReaderReaction[] Reactions, object[]? Gifs, LinkPreview[]? Previews, ReaderReply? Reply)
{
    public static SyncMessage From(ReaderMessage message) => new(message.Id, message.OperationId, message.Author.Id,
        message.Content, message.Timestamp, message.IsEdited, message.ReplyToMessageId, message.Images,
        message.Videos, message.GifCount, message.Reactions, message.Gifs, message.Previews, message.Reply);
}

/// <summary>Changes to one conversation. Window is present only for a complete recent-window replacement.</summary>
public record ConversationUpdate(Guid Id, ReaderConversation State, SyncMessage[] Messages, Guid[] Removed,
    Guid[]? Window, string? BaseRevision, string Revision, bool Invalidate = false);

/// <summary>Account-bound incremental authority shared by HTTP results and the live stream.</summary>
public record ChatUpdate(int Protocol, Guid UserId, string ServerEpoch, long Sequence, ReaderSnapshot? State,
    ConversationUpdate[] Conversations, Guid[] RemovedConversations, ReaderUser[] Authors, string? StateRevision = null, bool Reset = false);

/// <summary>Builds on-demand windows and compact acknowledgements using channel content versions.</summary>
public sealed class OfflineSync(OfflineSnapshotService snapshots)
{
    public static string Revision(ReaderConversation value) => value.ContentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
    private static ReaderUser[] Authors(IEnumerable<ReaderMessage> messages) => messages.Select(m => m.Author).DistinctBy(u => u.Id).ToArray();
    public static ConversationUpdate Window(ReaderConversation value) => new(value.Id, value with
    {
        Messages = []
    },
        value.Messages.Select(SyncMessage.From).ToArray(), [], value.Messages.Select(m => m.Id).ToArray(), null, Revision(value));

    public ChatUpdate Bootstrap(User user, string? path, Guid? channelId = null, string? epoch = null, string? revision = null, Guid? knownUser = null)
    {
        var channels = snapshots.Channels(user);
        var metadata = channels.Select(c => snapshots.Metadata(user, c.Id)).OfType<ReaderConversation>().ToArray();
        var selected = metadata.FirstOrDefault(c => c.Id == channelId || Uri.UnescapeDataString(c.Path).Equals(Uri.UnescapeDataString(path ?? "").TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
            ?? metadata.FirstOrDefault(c => c.IsDefault);
        var unchanged = knownUser == user.Id && epoch == snapshots.Epoch && selected != null && revision == Revision(selected);
        var capture = selected != null && !unchanged ? snapshots.Capture(user, selected.Id, null, true) : default;
        var conversations = metadata.Select(c => c.Id == capture.Conversation?.Id
            ? Window(capture.Conversation)
            : new ConversationUpdate(c.Id, c, [], [], null, null, Revision(c), true)).ToArray();
        // Stamp before header construction; each channel window has its own consistent capture.
        var sequence = capture.Sequence != 0 ? capture.Sequence : snapshots.Stamp();
        return new(2, user.Id, snapshots.Epoch, sequence, snapshots.Header(user), conversations, [],
            Authors(capture.Conversation?.Messages ?? []), null, true);
    }

    public ChatUpdate Conversation(User user, Guid id, Guid? messageId = null, bool full = false)
    {
        var capture = snapshots.Capture(user, id, messageId, full);
        if (capture.Conversation == null)
            return new(2, user.Id, capture.Epoch, capture.Sequence, null, [], [id], []);
        var conversation = capture.Conversation;
        var messages = full ? conversation.Messages : capture.Message is { } message ? new[] { message } : [];
        var update = full ? Window(conversation) : new ConversationUpdate(id, conversation,
            messages.Select(SyncMessage.From).ToArray(), messageId.HasValue && capture.Message == null ? [messageId.Value] : [],
            null, null, Revision(conversation));
        return new(2, user.Id, capture.Epoch, capture.Sequence, null, [update], [], Authors(messages));
    }
}
