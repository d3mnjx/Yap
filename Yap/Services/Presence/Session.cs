using System.Text.Json;

namespace Yap.Services.Presence;

/// <summary>What other people see (PR-01, PR-05). "Offline" is no connection, or a chosen Invisible.</summary>
public enum EffectiveStatus { Online, Away, Offline }

/// <summary>Why an effective status changed. The client draws a lobby line for Join and Leave only
/// (MR-73), never for Change, so an invisible toggle makes no line (PR-05).</summary>
public enum PresenceChange { Join, Leave, Change }

/// <summary>
/// One hub connection of one person. Sessions are created when a connection opens and removed by the
/// presence sweep after the grace period of the spec. A person has one session per open tab.
/// </summary>
public sealed class Session
{
    public required string ConnectionId { get; init; }
    public required Guid UserId { get; init; }
    public required string Username { get; init; }

    /// <summary>A random id the client keeps in local storage. Tabs on one device share it, so Settings can
    /// list one row per device (AU-19).</summary>
    public required string DeviceId { get; init; }

    public bool IsMobile { get; init; }                  // from the User-Agent at connect (PR-25)
    public string Browser { get; init; } = "";           // the family from the User-Agent: Chrome, Safari, ... (AD-41)
    public string Os { get; init; } = "";                // iOS, Android, Windows, ... (AD-41)
    public bool Pwa { get; init; }                       // the hub URL said pwa=1: the installed app, not a tab (AD-41)
    public string? ClientIp { get; init; }
    public string? ClientIpv4 { get; set; }              // from the opt-in IPv4 beacon; display only, never an auth input
    public string Transport { get; init; } = "";         // WebSockets, ServerSentEvents or LongPolling (AD-26)
    public DateTime ConnectedAt { get; init; } = DateTime.UtcNow;

    /// <summary>The bot's session: always online, never swept, never listed as a device (PR-09).</summary>
    public bool Permanent { get; init; }

    // Two stamps for two ways to disconnect, because the spec treats them differently: a closed tab is
    // offline after 30 s with no away phase (PR-14), a lost connection is away after 30 s and offline
    // after 5 min (PR-15, PR-16). SignalR tells the two apart.
    public DateTime? ClosedAt { get; set; }
    public DateTime? DroppedAt { get; set; }
    public bool Connected => ClosedAt is null && DroppedAt is null;

    // From the heartbeat (every 10 s visible, 60 s hidden).
    public bool Visible { get; set; } = true;
    public DateTime LastInputAt { get; set; } = DateTime.UtcNow;
    public DateTime LastHeartbeatAt { get; set; } = DateTime.UtcNow;

    /// <summary>The conversation this connection has open. For the diagnostics table and for typing.</summary>
    public Guid? Viewing { get; set; }

    public LatencyStats Latency { get; } = new();

    /// <summary>The boot report of the page load that opened this connection, when the client sent one (AD-41).</summary>
    public LoadReport? Load { get; set; }

    /// <summary>Closes the connection from outside the hub. Captured from HubCallerContext at connect, used
    /// by "sign out all other devices" (AU-20).</summary>
    public Action? Abort { get; init; }
}

/// <summary>
/// The waits the diagnostics table shows (AD-26). The client measures six of them: Send from the tap to its
/// own message rendered, Open from the tap on a conversation and Start from the page load to the server's rows
/// on screen, Older from the scroll to the older rows in place, Reconnect from the loss of the connection to
/// the room back in sync, and Jump from the tap on a pin or a quote to the window on screen (TL-41). Rtt is the client's own heartbeat round trip. Post is the server's time inside a
/// message send, the one request that does not go over the hub.
/// </summary>
public enum Wait { Rtt, Send, Post, Open, Older, Start, Reconnect, Jump }

/// <summary>One wait reported by the client: its name as the client spells it, and the milliseconds.</summary>
public sealed record WaitSample(string Name, int Ms);

/// <summary>
/// One page load as the client measured it (AD-41): six phases in ms from the navigation start, and what the network
/// did. A phase the load did not reach is null. Sent once per load, by the first conversation of the load, over the
/// connection that load opened; a reconnect is a new connection and carries no report. Build is the build stamp the
/// page ran and Worker the stamp that registered its service worker: a device left behind after a deploy shows as a
/// build older than the server's (an iPhone did that on 2026-10-30, and nothing here could show it). An old client
/// sends neither, so both are optional.
/// </summary>
public sealed record LoadReport(int? Html, int? Scripts, int? Bootstrap, int? Paint, int? Socket, int? Rows,
    string? Protocol, int Requests, int Cached, long Bytes, bool Hidden, string? Build = null, string? Worker = null)
{
    public DateTime At { get; init; } = DateTime.UtcNow;

    /// <summary>Client numbers are untrusted: a phase outside 0..10 min (the same bound as the waits) becomes null, the
    /// counts are clamped and the protocol and the stamps are cut to short tokens, so a forged report cannot poison the table.</summary>
    public LoadReport Clean() => this with
    {
        Html = Phase(Html), Scripts = Phase(Scripts), Bootstrap = Phase(Bootstrap), Paint = Phase(Paint), Socket = Phase(Socket), Rows = Phase(Rows),
        Protocol = Token(Protocol, 16), Build = Token(Build, 24), Worker = Token(Worker, 24),
        Requests = Math.Clamp(Requests, 0, 10_000), Cached = Math.Clamp(Cached, 0, 10_000), Bytes = Math.Clamp(Bytes, 0, 1L << 40),
    };

    private static int? Phase(int? ms) => ms is >= 0 and <= 600_000 ? ms : null;
    private static string? Token(string? s, int max) => s is { Length: > 0 } && s.Length <= max ? s : null;
}

/// <summary>
/// The numbers of one wait. Immutable and replaced whole on each sample, so the admin endpoint can read a
/// session outside the presence lock and never see a half-written stat. The average is exponentially weighted
/// (0.75 old, 0.25 new), so one good sample does not hide a bad streak.
/// </summary>
public sealed record Stat(double Last, double Avg, double Max, int Count, DateTime At)
{
    public static Stat First(double ms) => new(ms, ms, ms, 1, DateTime.UtcNow);
    public Stat Then(double ms) => new(ms, 0.75 * Avg + 0.25 * ms, Math.Max(Max, ms), Count + 1, DateTime.UtcNow);
}

/// <summary>
/// The waits of one connection, or of one person across all their connections, for the admin diagnostics table
/// (AD-26). Slow events are hub calls and message sends that took over <see cref="SlowMs"/> on the server. In
/// memory only; a restart clears everything.
/// </summary>
public sealed class LatencyStats
{
    public const double SlowMs = 100;   // the hub filter and the send filter share the threshold

    // Indexed by Wait. A plain array with whole-record writes keeps lock-free readers safe; a dictionary would not.
    private readonly Stat?[] _byWait = new Stat?[Enum.GetValues<Wait>().Length];

    public int SlowEventCount { get; private set; }
    public double? MaxEventMs { get; private set; }
    public DateTime? LastSlowEventAt { get; private set; }

    /// <summary>The waits with at least one sample, keyed by their camelCase name ("rtt", "send", ...) for the JSON.</summary>
    public Dictionary<string, Stat> Stats => Enum.GetValues<Wait>()
        .Where(w => _byWait[(int)w] is not null)
        .ToDictionary(w => JsonNamingPolicy.CamelCase.ConvertName(w.ToString()), w => _byWait[(int)w]!);

    public Stat? Of(Wait wait) => _byWait[(int)wait];

    public void Report(Wait wait, double ms) => _byWait[(int)wait] = _byWait[(int)wait] is { } stat ? stat.Then(ms) : Stat.First(ms);

    public void ReportSlowEvent(double ms)
    {
        SlowEventCount++;
        MaxEventMs = Math.Max(MaxEventMs ?? 0, ms);
        LastSlowEventAt = DateTime.UtcNow;
    }
}

/// <summary>One person's waits since the restart (AD-26). The username is the one their last report carried.</summary>
public sealed class UserLatency(string username)
{
    public string Username { get; set; } = username;
    public LatencyStats Stats { get; } = new();
}
