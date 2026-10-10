using System.Collections.Concurrent;
using System.Threading.Channels;
using Yap.Models;
using Yap.Services;
using Yap.Services.Gifs;

namespace Yap.Offline;

/// <summary>Projects each message event once and routes it only to authorized connection queues.</summary>
public sealed class OfflineFanout : IDisposable
{
    private readonly ILogger<OfflineFanout> logger;
    private readonly ChatService chat;
    private readonly GifService gifs;
    private readonly UserService users;
    private readonly OfflineSnapshotService snapshots;
    private readonly OfflineChangeSignal changes;
    private readonly NotificationSettingsService notifications;
    private readonly ConcurrentDictionary<Guid, Subscription> connections = new();
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Subscription>> accounts = new();
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Subscription>> channels = new();
    public OfflineFanout(ChatService chat, UserService users, OfflineSnapshotService snapshots, OfflineChangeSignal changes, NotificationSettingsService notifications, GifService gifs, ILogger<OfflineFanout> logger)
    {
        this.logger = logger;
        this.chat = chat;
        this.users = users;
        this.snapshots = snapshots;
        this.changes = changes;
        this.notifications = notifications;
        this.gifs = gifs;
        changes.Changed += Changed;
    }

    public Subscription Subscribe(User user, IReadOnlyDictionary<Guid, string> known, int capacity = 128)
    {
        var subscription = new Subscription(this, user, capacity);
        connections[subscription.Id] = subscription;
        accounts.GetOrAdd(user.Id, _ => new())[subscription.Id] = subscription;
        subscription.Enqueue(new(ChatProtocol.Number, user.Id, changes.Epoch, changes.Stamp(), snapshots.Header(user), [], [], []));
        Refresh(subscription, known);
        return subscription;
    }

    private void Refresh(Subscription subscription, IReadOnlyDictionary<Guid, string>? known = null)
    {
        var allowed = snapshots.Channels(subscription.User).Select(c => c.Id).ToHashSet();
        foreach (var id in subscription.Channels.Keys.Union(known?.Keys ?? []).Except(allowed).ToArray())
        {
            subscription.Channels.TryRemove(id, out _);
            if (channels.TryGetValue(id, out var members))
                members.TryRemove(subscription.Id, out _);
            subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, changes.Stamp(), null, [], [id], []));
        }
        foreach (var id in allowed)
        {
            lock (chat.GetChannelLock(id))
            {
                if (subscription.Channels.TryAdd(id, long.TryParse(known?.GetValueOrDefault(id), out var knownRevision) ? knownRevision : -1))
                    channels.GetOrAdd(id, _ => new())[subscription.Id] = subscription;
                var metadata = snapshots.Metadata(subscription.User, id);
                if (metadata == null)
                    continue;
                var revision = OfflineSync.Revision(metadata);
                subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, changes.Stamp(), null,
                    [new(id, metadata, [], [], null, null, revision, known?.GetValueOrDefault(id) != revision)], [], []));
            }
        }
    }

    private void Changed(OfflineChange change)
    {
        switch (change.Kind)
        {
            case OfflineChangeKind.Content:
                Changed(change.Id, change.RelatedId, change.Before, change.After, change.Sequence);
                break;
            case OfflineChangeKind.Unread:
                Unread(change.Id, change.RelatedId!.Value);
                break;
            case OfflineChangeKind.Profile:
                Profile(change.Id, true);
                break;
            case OfflineChangeKind.Preferences:
                Profile(change.Id, false);
                break;
            case OfflineChangeKind.People:
                People();
                break;
            case OfflineChangeKind.Favorites:
                Favorites(change.Id);
                break;
            case OfflineChangeKind.Media:
            case OfflineChangeKind.Gif:
                foreach (var channel in chat.GetRooms().Concat(chat.GetAllDMChannels()))
                    foreach (var message in chat.GetMessages(channel.Id, int.MaxValue).Where(m => change.Kind == OfflineChangeKind.Gif
                        ? m.GifAttachments.Any(g => g.GifEntryId == change.Id)
                        : change.Url != null && LinkPreviewService.ExtractUrls(m.Content).Contains(change.Url)))
                        changes.Touch(channel.Id, message.Id);
                break;
            case OfflineChangeKind.Settings:
                foreach (var channel in chat.GetRooms().Concat(chat.GetAllDMChannels()))
                    changes.Touch(channel.Id);
                break;
        }
    }

    private void Changed(Guid id, Guid? messageId, long before, long after, long sequence)
    {
        // Called inside the channel lock. Re-read current memory: a delayed legacy event must
        // never project its stale object over a more recently accepted edit or deletion.
        if (messageId == null)
        {
            foreach (var subscription in connections.Values)
            {
                try
                {
                    var metadata = snapshots.Metadata(subscription.User, id);
                    if (metadata == null)
                    {
                        if (!subscription.Channels.TryRemove(id, out _))
                            continue;
                        if (channels.TryGetValue(id, out var old))
                            old.TryRemove(subscription.Id, out _);
                        subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, sequence, null, [], [id], []));
                    }
                    else
                    {
                        subscription.Channels.TryAdd(id, -1);
                        channels.GetOrAdd(id, _ => new())[subscription.Id] = subscription;
                        subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, sequence, null,
                            [new(id, metadata, [], [], null, null, OfflineSync.Revision(metadata), true)], [], []));
                    }

                }
                catch (Exception error)
                {
                    logger.LogError(error, "Chat fan-out failed for connection {ConnectionId}", subscription.Id);
                }
            }
            return;
        }
        if (!channels.TryGetValue(id, out var members) || members.IsEmpty)
            return;
        var message = chat.GetMessageById(id, messageId.Value);
        var projected = message == null ? null : snapshots.Message(message);
        foreach (var subscription in members.Values)
        {
            try
            {
                var user = subscription.User;
                var metadata = snapshots.Metadata(user, id);
                if (metadata == null)
                    continue;
                var visible = message != null && chat.CanReadMessage(user, message);
                var value = visible ? snapshots.ForViewer(projected!, message!, user) : null;
                // Deleted restricted history has no readable timestamp left. Invalidate without
                // exposing its id; the authorized window endpoint decides what can remain.
                var invalidate = !visible && metadata.HistoryLimited;
                subscription.Enqueue(new(ChatProtocol.Number, user.Id, changes.Epoch, sequence, null,
                    [new(id, metadata, value == null ? [] : [value],
                    message == null && !invalidate ? [messageId.Value] : [], null,
                    before.ToString(System.Globalization.CultureInfo.InvariantCulture), after.ToString(System.Globalization.CultureInfo.InvariantCulture), invalidate)],
                    [], value == null ? [] : [value.Author]));

            }
            catch (Exception error)
            {
                logger.LogError(error, "Chat fan-out failed for connection {ConnectionId}", subscription.Id);
            }
        }
    }

    private void Unread(Guid userId, Guid channelId)
    {
        if (!accounts.TryGetValue(userId, out var members))
            return;
        lock (chat.GetChannelLock(channelId))
        {
            foreach (var subscription in members.Values.Where(s => s.Channels.ContainsKey(channelId)))
            {
                var metadata = snapshots.Metadata(subscription.User, channelId);
                if (metadata != null)
                    subscription.Enqueue(new(ChatProtocol.Number, userId, changes.Epoch, changes.Stamp(), null,
                        [new(channelId, metadata, [], [], null, null, OfflineSync.Revision(metadata))], [], []));
            }
        }
    }

    private void Favorites(Guid userId)
    {
        if (!accounts.TryGetValue(userId, out var account))
            return;
        var user = users.GetById(userId);
        if (user == null)
            return;
        foreach (var id in account.Values.SelectMany(s => s.Channels.Keys).Distinct())
        {
            lock (chat.GetChannelLock(id))
            {
                var metadata = snapshots.Metadata(user, id);
                if (metadata == null)
                    continue;
                var messages = chat.GetMessagesPaginated(id, snapshots.RecentLimit, isAdmin: users.IsAdmin(userId), userId: userId)
                    .Messages.Where(m => m.GifAttachments.Count > 0).Select(m => snapshots.Message(m, userId)).ToArray();
                if (messages.Length == 0)
                    continue;
                var update = new ChatUpdate(ChatProtocol.Number, userId, changes.Epoch, changes.Stamp(), null,
                    [new(id, metadata, messages, [], null, null, OfflineSync.Revision(metadata))],
                    [], messages.Select(m => m.Author).DistinctBy(a => a.Id).ToArray());
                foreach (var subscription in account.Values.Where(s => s.Channels.ContainsKey(id)))
                    subscription.Enqueue(update);
            }
        }
    }

    private void Profile(Guid userId, bool publicProfile)
    {
        snapshots.InvalidateUser(userId);
        if (publicProfile)
        {
            People();
            // Profiles are embedded in cached message DTOs. A rare profile edit must also
            // invalidate those windows; this work never runs on the message arrival path.
            var user = users.GetById(userId);
            var authored = chat.GetRooms().Concat(user == null ? [] : chat.GetDMChannels(user.Username));
            var affected = authored.Where(c => chat.AnyMessage(c.Id, m => m.UserId == userId))
                .Select(c => c.Id).ToHashSet();
            // An uploader need never have posted in a room/DM that embeds their GIF.
            var uploaded = gifs.GetAllEntries().Where(g => g.UploadedByUserId == userId).Select(g => g.Id).ToHashSet();
            if (uploaded.Count > 0)
                foreach (var channel in chat.GetRooms().Concat(chat.GetAllDMChannels()))
                    if (chat.AnyMessage(channel.Id, m => m.GifAttachments.Any(g => uploaded.Contains(g.GifEntryId))))
                        affected.Add(channel.Id);
            foreach (var id in affected)
                changes.Touch(id);
        }
        else if (accounts.TryGetValue(userId, out var account))
        {
            var user = users.GetById(userId);
            if (user == null)
                return;
            var header = snapshots.Header(user);
            foreach (var subscription in account.Values)
                subscription.Enqueue(new(ChatProtocol.Number, userId, changes.Epoch, changes.Stamp(), header, [], [], []));
            foreach (var id in account.Values.SelectMany(s => s.Channels.Keys).Distinct())
                Unread(userId, id);
        }
    }
    private void People()
    {
        // Once per account, irrespective of the number of tabs. Never called by message/unread events.
        foreach (var group in connections.Values.GroupBy(s => s.User.Id))
        {
            var header = snapshots.Header(group.First().User);
            var sequence = changes.Stamp();
            foreach (var subscription in group)
                subscription.Enqueue(new(ChatProtocol.Number, group.Key, changes.Epoch, sequence, header, [], [], []));
        }
    }

    private async Task Digest(Subscription subscription)
    {
        await notifications.ClearExpiredServerMuteAsync(subscription.User);
        var allowed = snapshots.Channels(subscription.User).Select(c => c.Id).ToHashSet();
        foreach (var id in subscription.Channels.Keys.Except(allowed))
        {
            subscription.Channels.TryRemove(id, out _);
            if (channels.TryGetValue(id, out var members))
                members.TryRemove(subscription.Id, out _);
            subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, changes.Stamp(), null, [], [id], []));
        }
        foreach (var id in allowed)
        {
            lock (chat.GetChannelLock(id))
            {
                subscription.Channels.TryAdd(id, -1);
                channels.GetOrAdd(id, _ => new())[subscription.Id] = subscription;
                // Comparing counters avoids rebuilding full viewer metadata for unchanged
                // channels. Reconnect/overflow still supply authoritative invalidations.
                if (subscription.Channels[id] == changes.ContentVersion(id))
                    continue;
                var metadata = snapshots.Metadata(subscription.User, id);
                if (metadata != null)
                    subscription.Enqueue(new(ChatProtocol.Number, subscription.User.Id, changes.Epoch, changes.Stamp(), null,
                        [new(id, metadata, [], [], null, null, OfflineSync.Revision(metadata), true)], [], []));
            }
        }
    }

    private void Remove(Subscription subscription)
    {
        connections.TryRemove(subscription.Id, out _);
        if (accounts.TryGetValue(subscription.User.Id, out var account))
            account.TryRemove(subscription.Id, out _);
        foreach (var id in subscription.Channels.Keys)
            if (channels.TryGetValue(id, out var members))
                members.TryRemove(subscription.Id, out _);
    }

    public void Dispose()
    {
        changes.Changed -= Changed;
        foreach (var subscription in connections.Values)
            subscription.Dispose();
    }

    /// <summary>A bounded queue. Overflow drops records and recovers through authorized invalidations.</summary>
    public sealed class Subscription(OfflineFanout owner, User user, int capacity) : IDisposable
    {
        internal Guid Id { get; } = Guid.NewGuid();
        internal User User { get; } = user;
        internal ConcurrentDictionary<Guid, long> Channels { get; } = new();
        private readonly object gate = new();
        private readonly Queue<ChatUpdate> pending = new();
        private readonly Channel<bool> ready = System.Threading.Channels.Channel.CreateBounded<bool>(1);
        private bool overflow, disposed;
        public long Overflows
        {
            get; private set;
        }
        internal void Enqueue(ChatUpdate update)
        {
            lock (gate)
            {
                if (disposed)
                    return;
                if (!overflow && pending.Count >= capacity)
                {
                    pending.Clear();
                    overflow = true;
                    Overflows++;
                }
                if (!overflow)
                    pending.Enqueue(update);
                ready.Writer.TryWrite(true);
            }
        }
        public Task Digest() => owner.Digest(this);
        public async Task<ChatUpdate[]> Read(CancellationToken cancellationToken)
        {
            await ready.Reader.ReadAsync(cancellationToken);
            ChatUpdate[] batch;
            bool recover;
            lock (gate)
            {
                batch = pending.ToArray();
                pending.Clear();
                ready.Reader.TryRead(out _);
                recover = overflow;
                overflow = false;
            }
            if (recover)
            {
                // Do not hold the queue lock while taking channel locks: publishers take them
                // in the other order. New changes keep accumulating during this recovery.
                var resetSequence = owner.changes.Stamp();
                var updates = new List<ChatUpdate>();
                foreach (var channel in owner.snapshots.Channels(User))
                {
                    lock (owner.chat.GetChannelLock(channel.Id))
                    {
                        var metadata = owner.snapshots.Metadata(User, channel.Id);
                        if (metadata != null)
                            updates.Add(new(ChatProtocol.Number, User.Id, owner.changes.Epoch, owner.changes.Stamp(), null,
                            [new(channel.Id, metadata, [], [], null, null, OfflineSync.Revision(metadata), true)], [], []));
                    }
                }
                // Reset supplies the complete allowed set, including removals lost at overflow.
                var reset = new ChatUpdate(ChatProtocol.Number, User.Id, owner.changes.Epoch, resetSequence, owner.snapshots.Header(User),
                    updates.SelectMany(u => u.Conversations).ToArray(), [], [], Reset: true);
                return Sent([reset, .. updates]);
            }
            // Different conversations must keep different sequence stamps. Stamping an old
            // room record with a later DM sequence can overwrite a newer HTTP acknowledgement.
            // A channel's publishers serialize enqueue under its lock, so coalescing only that
            // channel preserves its revision chain and latest record authority.
            return Sent(batch.GroupBy(u => u.State != null ? "header" :
                    (u.Conversations.FirstOrDefault()?.Id ?? u.RemovedConversations.FirstOrDefault()).ToString())
                .Select(group => Merge(group.ToArray())).OrderBy(u => u.Sequence).ToArray());
        }
        private ChatUpdate[] Sent(ChatUpdate[] updates)
        {
            foreach (var patch in updates.SelectMany(u => u.Conversations))
                if ((patch.Invalidate || patch.BaseRevision != null || patch.Window != null) && long.TryParse(patch.Revision, out var revision))
                    // Do not recreate a channel removed while this batch was being read.
                    while (Channels.TryGetValue(patch.Id, out var previous) && previous < revision)
                        if (Channels.TryUpdate(patch.Id, revision, previous))
                            break;
            return updates;
        }

        private ChatUpdate Merge(ChatUpdate[] batch)
        {
            var patches = new Dictionary<Guid, ConversationUpdate>();
            var removed = new HashSet<Guid>();
            var authors = new Dictionary<Guid, ReaderUser>();
            ReaderSnapshot? header = null;
            foreach (var item in batch.OrderBy(u => u.Sequence))
            {
                header = item.State ?? header;
                foreach (var author in item.Authors)
                    authors[author.Id] = author;
                foreach (var id in item.RemovedConversations)
                {
                    patches.Remove(id);
                    removed.Add(id);
                }
                foreach (var patch in item.Conversations)
                {
                    removed.Remove(patch.Id);
                    if (!patches.TryGetValue(patch.Id, out var previous))
                    {
                        patches[patch.Id] = patch;
                        continue;
                    }
                    var messages = previous.Messages.ToDictionary(m => m.Id);
                    var deleted = previous.Removed.ToHashSet();
                    foreach (var id in patch.Removed)
                    {
                        messages.Remove(id);
                        deleted.Add(id);
                    }
                    foreach (var message in patch.Messages)
                    {
                        deleted.Remove(message.Id);
                        messages[message.Id] = message;
                    }
                    patches[patch.Id] = patch with
                    {
                        Messages = messages.Values.ToArray(),
                        Removed = deleted.ToArray(),
                        BaseRevision = previous.BaseRevision ?? patch.BaseRevision,
                        // A digest at the delta's base is already represented by the chain.
                        // Gaps and explicit later invalidations must still force a refill.
                        Invalidate = (patch.Invalidate && !(previous.BaseRevision != null && previous.Revision == patch.Revision))
                            || (previous.Invalidate && (previous.BaseRevision != null || patch.BaseRevision != previous.Revision))
                            || (previous.BaseRevision != null && patch.BaseRevision != null && previous.Revision != patch.BaseRevision)
                    };
                }
            }
            return new(ChatProtocol.Number, User.Id, owner.changes.Epoch, batch.Length == 0 ? owner.changes.Stamp() : batch.Max(u => u.Sequence),
                header, patches.Values.ToArray(), removed.ToArray(), authors.Values.ToArray());
        }
        public void Dispose()
        {
            lock (gate)
            {
                disposed = true;
                pending.Clear();
                ready.Writer.TryComplete();
            }
            owner.Remove(this);
        }
    }
}
