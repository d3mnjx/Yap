using Yap.Models;
using Yap.Models.Admin;
using Yap.Services.Chat;
using Yap.Services.Presence;

namespace Yap.Services.Admin;

/// <summary>
/// Captures diagnostics snapshots every 30 seconds into a circular buffer (max 7 days), in memory only, so a
/// restart starts it again.
/// </summary>
public class DiagnosticsCollectorService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private const int MaxEntries = 20160; // 7 days at 30s intervals

    private readonly ChatService _chatService;
    private readonly PresenceService _presence;
    private readonly ILogger<DiagnosticsCollectorService> _logger;

    private readonly LinkedList<DiagnosticsSnapshot> _snapshots = new();
    private readonly object _lock = new();

    public DiagnosticsCollectorService(
        ChatService chatService,
        PresenceService presence,
        ILogger<DiagnosticsCollectorService> logger)
    {
        _chatService = chatService;
        _presence = presence;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Capture initial snapshot immediately
        CaptureSnapshot();

        using var timer = new PeriodicTimer(Interval);

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                CaptureSnapshot();
            }
        }
        catch (OperationCanceledException) { }
    }

    private void CaptureSnapshot()
    {
        try
        {
            var diag = _chatService.GetDiagnostics();
            var (active, disconnected, totalCreated) = _presence.Stats();

            var snapshot = new DiagnosticsSnapshot(
                Timestamp: DateTime.UtcNow,
                UserSessions: diag.UserSessions,
                UniqueUsers: diag.UniqueUsers,
                Channels: diag.Channels,
                RoomChannels: diag.RoomChannels,
                DmChannels: diag.DmChannels,
                TotalMessages: diag.TotalMessages,
                ActiveConnections: active,
                DisconnectedConnections: disconnected,
                TotalConnections: totalCreated,
                TotalEventSubscribers: diag.TotalEventSubscribers);

            Record(snapshot);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to capture diagnostics snapshot");
        }
    }

    internal void Record(DiagnosticsSnapshot snapshot)
    {
        lock (_lock)
        {
            _snapshots.AddLast(snapshot);
            while (_snapshots.Count > MaxEntries)
                _snapshots.RemoveFirst();
        }
    }

    /// <summary>
    /// The snapshots of the last <paramref name="seconds"/> in chronological order, as buckets of
    /// <paramref name="step"/> seconds rounded up to whole snapshots, so a week comes back as a few hundred points.
    /// </summary>
    public List<DiagnosticsSnapshot> GetSeries(int seconds, int step)
    {
        var interval = (int)Interval.TotalSeconds;
        var count = Math.Clamp((seconds + interval - 1) / interval, 1, MaxEntries);
        var size = (Math.Max(step, 1) + interval - 1) / interval;
        List<DiagnosticsSnapshot> last;
        lock (_lock) last = _snapshots.TakeLast(count).ToList();
        return size <= 1 ? last : last.Chunk(size).Select(Bucket).ToList();
    }

    // A bucket keeps the highest user, session and connection counts, so a short visit still shows on a week's
    // chart; an average would flatten it. The message total and the rest come from the last snapshot.
    private static DiagnosticsSnapshot Bucket(DiagnosticsSnapshot[] chunk) => chunk[^1] with
    {
        UserSessions = chunk.Max(s => s.UserSessions),
        UniqueUsers = chunk.Max(s => s.UniqueUsers),
        ActiveConnections = chunk.Max(s => s.ActiveConnections),
        DisconnectedConnections = chunk.Max(s => s.DisconnectedConnections),
    };

    /// <summary>
    /// Returns the most recent snapshot, or null if none captured yet.
    /// </summary>
    public DiagnosticsSnapshot? GetLatest()
    {
        lock (_lock)
        {
            return _snapshots.Last?.Value;
        }
    }
}
