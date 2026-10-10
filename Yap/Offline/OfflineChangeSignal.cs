using Yap.Models;
using Yap.Services;

namespace Yap.Offline;

/// <summary>
/// Coalesces chat changes into shared stream wake-ups and content versions, avoiding per-browser
/// service subscriptions and private message broadcasts.
/// </summary>
public sealed class OfflineChangeSignal : IDisposable
{
    private readonly ChatService chat;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, long> contentVersions = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, long> historyVersions = new();
    public long HistoryVersion(Guid channelId) => historyVersions.GetValueOrDefault(channelId);
    public long ContentVersion(Guid channelId) => contentVersions.GetValueOrDefault(channelId);
    private void ContentChanged(Guid channelId, bool historyChanged = true)
    {
        // Arrivals cannot change older pages. Edits, deletions and permission changes can.
        if (historyChanged)
            historyVersions.AddOrUpdate(channelId, 1, (_, version) => version + 1);
        contentVersions.AddOrUpdate(channelId, 1, (_, version) => version + 1);
        Pulse();
    }
    private readonly object gate = new();
    private TaskCompletionSource changed = NewSignal();
    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task Next
    {
        get
        {
            lock (gate)
                return changed.Task;
        }
    }
    public OfflineChangeSignal(ChatService chat)
    {
        this.chat = chat;
        chat.OnMessageReceived += Arrived;
        chat.OnMessageUpdated += Message;
        chat.OnReactionChanged += Message;
        chat.OnMessageDeleted += Deleted;
        chat.OnChannelCreated += Channel;
        chat.OnChannelUpdated += Channel;
        chat.OnChannelDeleted += Id;
        chat.OnUsersListChanged += Pulse;
        chat.OnUnreadChanged += Unread;
    }
    private void Unread(Guid _, Guid __) => Pulse();
    private void Arrived(ChatMessage message) => ContentChanged(message.ChannelId, false);
    private void Message(ChatMessage message) => ContentChanged(message.ChannelId);
    private void Channel(Channel channel) => ContentChanged(channel.Id);
    private void Deleted(Guid _, Guid channelId) => ContentChanged(channelId);
    private void Id(Guid _) => Pulse();
    private void Pulse()
    {
        lock (gate)
        {
            var previous = changed;
            changed = NewSignal();
            previous.TrySetResult();
        }
    }
    public void Dispose()
    {
        chat.OnMessageReceived -= Arrived;
        chat.OnMessageUpdated -= Message;
        chat.OnReactionChanged -= Message;
        chat.OnMessageDeleted -= Deleted;
        chat.OnChannelCreated -= Channel;
        chat.OnChannelUpdated -= Channel;
        chat.OnChannelDeleted -= Id;
        chat.OnUsersListChanged -= Pulse;
        chat.OnUnreadChanged -= Unread;
    }
}
