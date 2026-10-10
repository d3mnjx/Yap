using System.Collections.Concurrent;

namespace Yap.Services;

public enum OfflineChangeKind
{
    Content, Unread, Profile, Preferences, People, Media, Gif, Favorites, Settings
}
public record OfflineChange(OfflineChangeKind Kind, Guid Id, Guid? RelatedId = null, string? Url = null,
    long Before = 0, long After = 0, long Sequence = 0);

/// <summary>One publication entry point. Call after committed state is visible to projection.</summary>
public sealed class OfflineChangeSignal(ILogger<OfflineChangeSignal> logger)
{
    private readonly ConcurrentDictionary<Guid, object> gates = new();
    private readonly ConcurrentDictionary<Guid, long> contentVersions = new();
    private readonly ConcurrentDictionary<Guid, long> historyVersions = new();
    private long sequence;
    public string Epoch { get; } = Guid.NewGuid().ToString("N");
    public long Stamp() => Interlocked.Increment(ref sequence);
    public long HistoryVersion(Guid id) => historyVersions.GetValueOrDefault(id);
    public long ContentVersion(Guid id) => contentVersions.GetValueOrDefault(id);
    internal object ChannelLock(Guid id) => gates.GetOrAdd(id, _ => new());
    public event Action<OfflineChange>? Changed;

    public void Touch(Guid channelId, Guid? messageId = null, bool history = true)
    {
        // Capture, counters and projection share this conversation's lock, never a global gate.
        lock (ChannelLock(channelId))
        {
            var before = ContentVersion(channelId);
            contentVersions[channelId] = before + 1;
            if (history)
                historyVersions.AddOrUpdate(channelId, 1, (_, value) => value + 1);
            Publish(new(OfflineChangeKind.Content, channelId, messageId, Before: before, After: before + 1, Sequence: Stamp()));
        }
    }

    // Account/global changes do not advance message revisions or expose private channel IDs.
    public void Touch(OfflineChangeKind kind, Guid id = default, Guid? relatedId = null, string? url = null)
        => Publish(new(kind, id, relatedId, url, Sequence: Stamp()));

    private void Publish(OfflineChange change)
    {
        if (Changed == null)
            return;
        foreach (Action<OfflineChange> subscriber in Changed.GetInvocationList())
            try
            {
                subscriber(change);
            }
            catch (Exception error) { logger.LogError(error, "Chat change publication failed for {Kind} {Id}", change.Kind, change.Id); }
    }
}
