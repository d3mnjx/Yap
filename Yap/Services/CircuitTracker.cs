using System.Collections.Concurrent;

namespace Yap.Services;

/// <summary>
/// Singleton service that tracks circuit lifecycle and per-circuit latency telemetry for diagnostics.
/// Latency data comes from the retained Blazor pages' RTT probe (ChatLayout + chat.js)
/// and slow inbound-event timing (ChatCircuitHandler).
/// </summary>
public class CircuitTracker
{
    private readonly ConcurrentDictionary<string, CircuitInfo> _circuits = new();
    private readonly ConcurrentQueue<CircuitInfo> _recentlyClosed = new();
    private const int RecentlyClosedCap = 50;
    private int _totalCreated = 0;

    // Telemetry lives in init-only extras so the original positional construction stays untouched.
    public record CircuitInfo(string CircuitId, DateTime CreatedAt, bool IsConnected, DateTime? DisconnectedAt)
    {
        public string? Username { get; init; }
        public string? ClientIp { get; init; }
        public bool? IsWebSocket { get; init; }          // false = SSE/long-polling fallback — prime per-client latency suspect
        public double? LastRttMs { get; init; }
        public double? AvgRttMs { get; init; }           // EWMA — smooths jitter without keeping a sample list
        public double? MaxRttMs { get; init; }
        public int RttSamples { get; init; }
        public DateTime? RttUpdatedAt { get; init; }
        public int SlowEventCount { get; init; }         // inbound events over ChatCircuitHandler's slow threshold
        public double? MaxEventMs { get; init; }
        public DateTime? LastSlowEventAt { get; init; }
        public DateTime? ClosedAt { get; init; }         // set when the circuit moves into the recently-closed ring
    }

    public void OnCircuitOpened(string circuitId)
    {
        Interlocked.Increment(ref _totalCreated);
        _circuits[circuitId] = new CircuitInfo(circuitId, DateTime.UtcNow, true, null);
    }

    public void OnConnectionUp(string circuitId) =>
        Update(circuitId, info => info with { IsConnected = true, DisconnectedAt = null });

    public void OnConnectionDown(string circuitId) =>
        Update(circuitId, info => info with { IsConnected = false, DisconnectedAt = DateTime.UtcNow });

    public void OnCircuitClosed(string circuitId)
    {
        if (!_circuits.TryRemove(circuitId, out var info))
            return;

        // Keep a bounded trail of closed circuits so telemetry survives sign-outs and evictions
        // long enough for an admin to inspect after the fact. In-memory only — gone on restart.
        // Unlabeled circuits (pre-auth pages, never-hydrated sessions) are noise for diagnostics.
        if (info.Username is null)
            return;

        _recentlyClosed.Enqueue(info with { IsConnected = false, ClosedAt = DateTime.UtcNow });
        while (_recentlyClosed.Count > RecentlyClosedCap && _recentlyClosed.TryDequeue(out _)) { }
    }

    /// <summary>
    /// Attaches user identity + transport to a circuit. Null args leave existing values untouched —
    /// the username may not be hydrated yet at circuit-open, and transport is unknowable outside
    /// a request context (e.g. on some reconnect callbacks).
    /// </summary>
    public void SetUser(string circuitId, string? username, string? clientIp, bool? isWebSocket) =>
        Update(circuitId, info => info with
        {
            Username = username ?? info.Username,
            ClientIp = clientIp ?? info.ClientIp,
            IsWebSocket = isWebSocket ?? info.IsWebSocket
        });

    public void ReportRtt(string circuitId, double rttMs) =>
        Update(circuitId, info => info with
        {
            LastRttMs = rttMs,
            AvgRttMs = info.AvgRttMs is double avg ? 0.75 * avg + 0.25 * rttMs : rttMs,
            MaxRttMs = Math.Max(info.MaxRttMs ?? 0, rttMs),
            RttSamples = info.RttSamples + 1,
            RttUpdatedAt = DateTime.UtcNow
        });

    public void ReportSlowEvent(string circuitId, double elapsedMs) =>
        Update(circuitId, info => info with
        {
            SlowEventCount = info.SlowEventCount + 1,
            MaxEventMs = Math.Max(info.MaxEventMs ?? 0, elapsedMs),
            LastSlowEventAt = DateTime.UtcNow
        });

    // Read-modify-write without a lock: all frequent writers for one circuit run on that circuit's
    // own dispatcher (sequential), so the classic lost-update race can't bite in practice — and a
    // dropped telemetry sample would be harmless anyway.
    private void Update(string circuitId, Func<CircuitInfo, CircuitInfo> mutate)
    {
        if (_circuits.TryGetValue(circuitId, out var info))
            _circuits[circuitId] = mutate(info);
    }

    public (int Active, int Disconnected, int TotalCreated) GetStats()
    {
        var active = _circuits.Values.Count(c => c.IsConnected);
        var disconnected = _circuits.Values.Count(c => !c.IsConnected);
        return (active, disconnected, _totalCreated);
    }

    public List<CircuitInfo> GetAllCircuits() => _circuits.Values.ToList();

    public List<CircuitInfo> GetRecentlyClosed() => _recentlyClosed.Reverse().ToList(); // newest first

    /// <summary>Connection state of one circuit — null when unknown/closed.</summary>
    public bool? IsCircuitConnected(string circuitId) =>
        _circuits.TryGetValue(circuitId, out var info) ? info.IsConnected : null;
}
