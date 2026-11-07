using System.Diagnostics;
using Yap.Services.Chat;
using Yap.Services.Persistence;
using Yap.Services.Presence;

namespace Yap.Services.Admin;

/// <summary>One second of the server under load, or a bucket of seconds: the process, the runtime, the hub and the queues.</summary>
public sealed record LoadSample(
    DateTime At,
    double CpuPercent,          // of all cores: 100 means every core busy
    double CpuPeakPercent,      // the busiest second: CpuPercent in a 1 s sample, the maximum in a bucket, so an average keeps its spikes
    long WorkingSetMB,
    long HeapMB,
    int Gen0, int Gen1, int Gen2,   // collections since start
    double GcPauseMs,           // GC pause time inside this second
    int ThreadPoolThreads,
    long ThreadPoolQueue,       // work items waiting for a thread: the thread-pool starvation signal
    int Connections,            // hub connections the presence service tracks as connected
    int MessagesPerSec,
    int HubSendsPerSec,         // SendCoreAsync calls, not recipients
    int RequestsPerSec,
    double RequestP95Ms,
    long RequestMaxMs,
    int WriterDepth,            // database writes queued and not yet on disk
    double SweepMs,             // the last presence sweep
    double? MachineLoad1,       // /proc/loadavg, Linux only
    long? MachineMemAvailableMB // /proc/meminfo, Linux only
);

/// <summary>
/// Samples <see cref="LoadCounters"/> and the runtime once a second. It keeps the last hour of 1 s samples and the
/// last 7 days as 1 min buckets, both in memory only, so a restart starts both again. The admin page and the
/// load-test orchestrator read it through GET /api/admin/load. It exists for stress tests: the 30 s diagnostics
/// snapshots are too coarse to see a knee in the curve. The minute buckets let the admin page show a day or a week.
/// </summary>
public sealed class LoadMetrics(LoadCounters counters, ChatService chat, PresenceService presence, PersistenceWriter writer) : BackgroundService
{
    public const int Capacity = 3600;          // 1 h at 1 s; about 200 bytes a sample, so under 1 MB
    public const int MinuteCapacity = 10_080;  // 7 days at 1 min, about 2 MB
    private readonly Queue<LoadSample> _samples = new(Capacity);
    private readonly Queue<LoadSample> _minutes = new(MinuteCapacity);
    private readonly List<LoadSample> _minute = new(60);   // the 1 s samples of the clock minute in progress
    private readonly Lock _gate = new();
    private readonly Process _process = Process.GetCurrentProcess();

    public IReadOnlyList<LoadSample> Last(int seconds)
    {
        lock (_gate) return _samples.TakeLast(Math.Clamp(seconds, 1, Capacity)).ToList();
    }

    /// <summary>
    /// The last <paramref name="seconds"/>, up to 7 days, as buckets of <paramref name="step"/> seconds, so a long
    /// range comes back as a few hundred points. A range up to an hour reads the 1 s samples. A longer range reads
    /// the minute buckets, rounds the step up to whole minutes and ends with the minute in progress.
    /// </summary>
    public IReadOnlyList<LoadSample> Last(int seconds, int step)
    {
        step = Math.Max(1, step);
        if (seconds <= Capacity) return Buckets(Last(seconds), step);
        List<LoadSample> minutes;
        lock (_gate)
        {
            minutes = _minutes.TakeLast((Math.Min(seconds, MinuteCapacity * 60) + 59) / 60).ToList();
            // Without it the chart would end up to a minute in the past, and stay empty for the first minute after a start.
            if (_minute.Count > 0) minutes.Add(Bucket([.. _minute]));
        }
        return Buckets(minutes, (step + 59) / 60);
    }

    private static IReadOnlyList<LoadSample> Buckets(IReadOnlyList<LoadSample> samples, int size) =>
        size <= 1 ? samples : samples.Chunk(size).Select(Bucket).ToList();

    /// <summary>Stores one sample in the 1 s ring. When the sample starts a new clock minute, the minute before becomes one bucket of the minute ring.</summary>
    internal void Record(LoadSample sample)
    {
        lock (_gate)
        {
            Push(_samples, sample, Capacity);
            // The clock decides where a minute ends, not a count of 60: PeriodicTimer drops the ticks a busy loop
            // missed, so under load 60 samples can cover more than a minute.
            if (_minute.Count > 0 && MinuteOf(_minute[0].At) != MinuteOf(sample.At))
            {
                Push(_minutes, Bucket([.. _minute]), MinuteCapacity);
                _minute.Clear();
            }
            _minute.Add(sample);
        }
    }

    private static long MinuteOf(DateTime at) => at.Ticks / TimeSpan.TicksPerMinute;

    private static void Push(Queue<LoadSample> ring, LoadSample sample, int capacity)
    {
        if (ring.Count == capacity) ring.Dequeue();
        ring.Enqueue(sample);
    }

    /// <summary>
    /// One point for a run of samples, or of minute buckets: it averages the gauges and rates, keeps the busiest CPU
    /// second, the worst request and the last GC counts, and carries the time of its last sample. A bucket of
    /// minute buckets keeps the true peaks. Its averages are close to the true ones, because the minutes are of
    /// equal length except the first one after a start and the one in progress.
    /// </summary>
    private static LoadSample Bucket(LoadSample[] chunk)
    {
        var last = chunk[^1];
        double Avg(Func<LoadSample, double> of) => Math.Round(chunk.Average(of), 1);
        double? AvgOrNull(Func<LoadSample, double?> of)   // a sample without the value is left out, not counted as zero
        {
            var present = chunk.Select(of).OfType<double>().ToList();
            return present.Count == 0 ? null : Math.Round(present.Average(), 1);
        }
        return last with
        {
            CpuPercent = Avg(s => s.CpuPercent),
            CpuPeakPercent = chunk.Max(s => s.CpuPeakPercent),
            WorkingSetMB = (long)Avg(s => s.WorkingSetMB),
            HeapMB = (long)Avg(s => s.HeapMB),
            GcPauseMs = Avg(s => s.GcPauseMs),
            ThreadPoolThreads = (int)Avg(s => s.ThreadPoolThreads),
            ThreadPoolQueue = (long)Avg(s => s.ThreadPoolQueue),
            Connections = (int)Avg(s => s.Connections),
            MessagesPerSec = (int)Math.Round(chunk.Average(s => s.MessagesPerSec)),
            HubSendsPerSec = (int)Math.Round(chunk.Average(s => s.HubSendsPerSec)),
            RequestsPerSec = (int)Math.Round(chunk.Average(s => s.RequestsPerSec)),
            RequestP95Ms = chunk.Max(s => s.RequestP95Ms),
            RequestMaxMs = chunk.Max(s => s.RequestMaxMs),
            WriterDepth = (int)Avg(s => s.WriterDepth),
            SweepMs = Avg(s => s.SweepMs),
            MachineLoad1 = AvgOrNull(s => s.MachineLoad1),
            MachineMemAvailableMB = (long?)AvgOrNull(s => s.MachineMemAvailableMB),
        };
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Action<Models.Chat.ChatMessage> onMessage = _ => counters.Message();
        chat.OnMessageReceived += onMessage;
        var lastCpu = _process.TotalProcessorTime;
        var lastPause = GC.GetTotalPauseDuration();
        var lastAt = DateTime.UtcNow;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = DateTime.UtcNow;
                _process.Refresh();
                var cpu = _process.TotalProcessorTime;
                var pause = GC.GetTotalPauseDuration();
                var elapsed = (now - lastAt).TotalSeconds;
                var cpuPercent = elapsed > 0 ? (cpu - lastCpu).TotalSeconds / elapsed / Environment.ProcessorCount * 100 : 0;
                var (messages, sends, requests, p95, max) = counters.Drain();
                var (connected, _, _) = presence.Stats();
                var (load, mem) = Machine();

                var cpuRounded = Math.Round(cpuPercent, 1);
                var sample = new LoadSample(now, cpuRounded, cpuRounded, _process.WorkingSet64 >> 20, GC.GetTotalMemory(false) >> 20,
                    GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2), Math.Round((pause - lastPause).TotalMilliseconds, 1),
                    ThreadPool.ThreadCount, ThreadPool.PendingWorkItemCount, connected, messages, sends, requests, p95, max,
                    writer.Depth, counters.LastSweepMs, load, mem);
                Record(sample);
                (lastCpu, lastPause, lastAt) = (cpu, pause, now);
            }
        }
        catch (OperationCanceledException) { }
        finally { chat.OnMessageReceived -= onMessage; }
    }

    // The host's view, so a run can tell "the app is slow" from "the box is out of memory". Both files are
    // cheap to read; a failure (not Linux, a locked-down container) just leaves the two fields empty.
    private static (double? Load1, long? MemAvailableMB) Machine()
    {
        if (!OperatingSystem.IsLinux()) return (null, null);
        try
        {
            var load = double.Parse(File.ReadAllText("/proc/loadavg").Split(' ')[0], System.Globalization.CultureInfo.InvariantCulture);
            var memLine = File.ReadLines("/proc/meminfo").FirstOrDefault(l => l.StartsWith("MemAvailable:"));
            long? mem = memLine is null ? null : long.Parse(memLine.Split(' ', StringSplitOptions.RemoveEmptyEntries)[1]) >> 10;
            return (load, mem);
        }
        catch { return (null, null); }
    }
}
