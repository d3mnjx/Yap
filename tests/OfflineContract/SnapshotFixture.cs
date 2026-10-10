using Yap.Models;
using Yap.Offline;

static class SnapshotFixture
{
    // A test inspection view, not an additional server/client wire protocol.
    public static ReaderSnapshot FullView(this OfflineSnapshotService snapshots, User user)
    {
        var conversations = snapshots.Channels(user).Select(c => snapshots.Conversation(user, c.Id)).OfType<ReaderConversation>().ToArray();
        return snapshots.Header(user) with
        {
            Sequence = snapshots.Stamp(),
            Conversations = conversations,
            Revision = string.Join(";", conversations.Select(c => $"{c.Id}:{c.ContentVersion}"))
        };
    }
}
