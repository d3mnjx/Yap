using System.Collections.Concurrent;
using Yap.Models;
using Yap.Services;
using Yap.Services.Gifs;

namespace Yap.Offline;

/// <summary>Process-local revision counters and ordered channel events; recovery uses windows, not a durable log.</summary>
public sealed class OfflineChangeSignal : IDisposable
{
    private readonly ChatService chat;
    private readonly GifService gifs;
    private readonly ConcurrentDictionary<Guid, long> contentVersions = new();
    private readonly ConcurrentDictionary<Guid, long> historyVersions = new();
    private long sequence;
    public string Epoch { get; } = Guid.NewGuid().ToString("N");
    public long Stamp() => Interlocked.Increment(ref sequence);
    public long HistoryVersion(Guid id) => historyVersions.GetValueOrDefault(id);
    public long ContentVersion(Guid id) => contentVersions.GetValueOrDefault(id);
    public event Action<Guid, Guid?, bool, long, long, long>? Changed;
    public OfflineChangeSignal(ChatService chat, GifService gifs)
    {
        this.chat = chat;
        this.gifs = gifs;
        chat.OnMessageReceived += Arrived;
        chat.OnMessageUpdated += Message;
        chat.OnReactionChanged += Message;
        chat.OnMessageDeleted += Deleted;
        chat.OnChannelCreated += Channel;
        chat.OnChannelUpdated += Channel;
        chat.OnChannelDeleted += Removed;
        chat.OnLinkPreviewReady += Enriched;
        chat.OnMediaCacheReady += Enriched;
        gifs.OnGifEntryUpdated += GifChanged;
        gifs.OnGifLibraryChanged += GifLibraryChanged;
    }
    private void Change(Guid id, Guid? message, bool history, bool removed = false)
    {
        // Window capture and event projection share only this conversation's lock.
        lock (chat.GetChannelLock(id))
        {
            var before = ContentVersion(id);
            contentVersions[id] = before + 1;
            if (history)
                historyVersions.AddOrUpdate(id, 1, (_, value) => value + 1);
            Changed?.Invoke(id, message, removed, before, before + 1, Stamp());
        }
    }
    public void Refresh(Guid id) => Change(id, null, true);
    private void Arrived(ChatMessage m) => Change(m.ChannelId, m.Id, false);
    private void Message(ChatMessage m) => Change(m.ChannelId, m.Id, true);
    private void Deleted(Guid message, Guid channel) => Change(channel, message, true, true);
    private void Channel(Channel channel) => Change(channel.Id, null, true);
    private void Removed(Guid channel) => Change(channel, null, true, true);
    private void Enriched(Guid message)
    {
        foreach (var channel in chat.GetRooms().Concat(chat.GetAllDMChannels()))
            if (chat.GetMessageById(channel.Id, message) is { } found)
            {
                Message(found);
                break;
            }
    }
    private void GifLibraryChanged(GifEntry entry) => GifChanged(entry.Id);
    private void GifChanged(Guid id)
    {
        foreach (var channel in chat.GetRooms().Concat(chat.GetAllDMChannels()))
            foreach (var message in chat.GetMessages(channel.Id, int.MaxValue).Where(m => m.GifAttachments.Any(g => g.GifEntryId == id)))
                Message(message);
    }
    public void Dispose()
    {
        chat.OnMessageReceived -= Arrived;
        chat.OnMessageUpdated -= Message;
        chat.OnReactionChanged -= Message;
        chat.OnMessageDeleted -= Deleted;
        chat.OnChannelCreated -= Channel;
        chat.OnChannelUpdated -= Channel;
        chat.OnChannelDeleted -= Removed;
        chat.OnLinkPreviewReady -= Enriched;
        chat.OnMediaCacheReady -= Enriched;
        gifs.OnGifEntryUpdated -= GifChanged;
        gifs.OnGifLibraryChanged -= GifLibraryChanged;
    }
}
