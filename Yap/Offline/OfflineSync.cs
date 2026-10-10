using System.Security.Cryptography;
using System.Text.Json;
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

/// <summary>
/// Compares authorized projections to send only changed records. Recovery replaces a bounded
/// conversation window; it does not depend on a durable event log or missed transport packets.
/// </summary>
public sealed class OfflineSync(OfflineSnapshotService snapshots)
{
    public static string Revision<T>(T value) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
    private static string WindowRevision(ReaderConversation value) => Revision(new { value.ContentVersion, value.HistoryLimited, value.Messages });
    private static ReaderSnapshot Header(ReaderSnapshot value) => value with { Conversations = [], Sequence = 0, Revision = "" };
    private static ReaderConversation Metadata(ReaderConversation value) => value with { Messages = [] };
    private static ReaderUser[] Authors(IEnumerable<ReaderMessage> messages) => messages.Select(m => m.Author).DistinctBy(u => u.Id).ToArray();
    private static ConversationUpdate Window(ReaderConversation value) => new(value.Id, Metadata(value),
        value.Messages.Select(SyncMessage.From).ToArray(), [], value.Messages.Select(m => m.Id).ToArray(), null, WindowRevision(value));

    public ChatUpdate Bootstrap(User user, string? path, Guid? channelId = null, string? epoch = null, string? revision = null, Guid? knownUser = null)
    {
        var snapshot = snapshots.Snapshot(user);
        var selected = snapshot.Conversations.FirstOrDefault(c => c.Id == channelId || Uri.UnescapeDataString(c.Path).Equals(Uri.UnescapeDataString(path ?? "").TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
            ?? snapshot.Conversations.FirstOrDefault(c => c.IsDefault);
        var unchanged = knownUser == user.Id && epoch == snapshot.ServerEpoch && selected != null && revision == WindowRevision(selected);
        var conversations = snapshot.Conversations.Select(c => c.Id == selected?.Id && !unchanged
            ? Window(c)
            : new ConversationUpdate(c.Id, Metadata(c), [], [], null, null, WindowRevision(c), true)).ToArray();
        return new(2, user.Id, snapshot.ServerEpoch, snapshot.Sequence, Header(snapshot), conversations, [],
            Authors(unchanged ? [] : selected?.Messages ?? []), Revision(Header(snapshot)), true);
    }

    public ChatUpdate Conversation(User user, Guid id, Guid? messageId = null, bool full = false)
    {
        var capture = snapshots.Capture(user, id, messageId);
        if (capture.Conversation == null)
            return new(2, user.Id, capture.Epoch, capture.Sequence, null, [], [id], []);
        var conversation = capture.Conversation;
        var messages = full ? conversation.Messages : capture.Message is { } message ? new[] { message } : [];
        var update = full ? Window(conversation) : new ConversationUpdate(id, Metadata(conversation),
            messages.Select(SyncMessage.From).ToArray(), messageId.HasValue && capture.Message == null ? [messageId.Value] : [],
            null, null, WindowRevision(conversation));
        return new(2, user.Id, capture.Epoch, capture.Sequence, null, [update], [], Authors(messages));
    }

    public ChatUpdate? Changes(ReaderSnapshot current, ReaderSnapshot? previous,
        IReadOnlyDictionary<Guid, string>? known = null, string? knownState = null)
    {
        var header = Header(current);
        var headerRevision = Revision(header);
        var headerChanged = headerRevision != (previous == null ? knownState : Revision(Header(previous)));
        var old = previous?.Conversations.ToDictionary(c => c.Id) ?? [];
        var updates = new List<ConversationUpdate>();
        var authors = new List<ReaderMessage>();
        foreach (var conversation in current.Conversations)
        {
            var revision = WindowRevision(conversation);
            old.TryGetValue(conversation.Id, out var before);
            var beforeRevision = before == null ? known?.GetValueOrDefault(conversation.Id) : WindowRevision(before);
            if (before != null && revision == beforeRevision && Revision(Metadata(conversation)) == Revision(Metadata(before)))
                continue;
            if (before == null)
            {
                // Missing or stale windows are filled by the cancellable HTTP background queue.
                // Future arrivals still stream immediately, including in inactive conversations.
                var arrived = previous == null ? [] : conversation.Messages.TakeLast(1).ToArray();
                authors.AddRange(arrived);
                updates.Add(new(conversation.Id, Metadata(conversation), arrived.Select(SyncMessage.From).ToArray(), [], null, null, revision, true));
                continue;
            }
            var priorMessages = before.Messages.ToDictionary(m => m.Id);
            var messages = conversation.Messages.Where(m => !priorMessages.TryGetValue(m.Id, out var prior)
                || Revision(m) != Revision(prior)).ToArray();
            var removed = before.Messages.Select(m => m.Id).Except(conversation.Messages.Select(m => m.Id)).ToArray();
            authors.AddRange(messages);
            updates.Add(new(conversation.Id, Metadata(conversation), messages.Select(SyncMessage.From).ToArray(),
                removed, null, beforeRevision, revision));
        }
        var removedConversations = (previous == null ? known?.Keys ?? [] : old.Keys).Except(current.Conversations.Select(c => c.Id)).ToArray();
        if (!headerChanged && updates.Count == 0 && removedConversations.Length == 0)
            return null;
        return new(2, current.User.Id, current.ServerEpoch, current.Sequence, headerChanged ? header : null,
            updates.ToArray(), removedConversations, Authors(authors), headerChanged ? headerRevision : null);
    }
}
