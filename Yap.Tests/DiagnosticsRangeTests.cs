using Microsoft.Extensions.Logging.Abstractions;
using Yap.Models.Admin;
using Yap.Services.Admin;
using Yap.Services.Chat;
using Yap.Services.Persistence;
using Yap.Services.Presence;

namespace Yap.Tests;

/// <summary>The ranges of the Diagnostics charts: the minute buckets of the load samples (AD-24) and the merged 30 s snapshots (AD-28).</summary>
public class DiagnosticsRangeTests(YapFactory app) : IClassFixture<YapFactory>
{
    private static readonly DateTime Start = new(2026, 11, 7, 10, 0, 0, DateTimeKind.Utc);
    private static readonly LoadSample Zero = new(default, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null);

    private static LoadSample Second(int offset, double cpu) => Zero with { At = Start.AddSeconds(offset), CpuPercent = cpu, CpuPeakPercent = cpu };

    // Built here and never started, so only the samples a test records are in it, not the host's live ones.
    private LoadMetrics NewLoad() => new(app.Service<LoadCounters>(), app.Service<ChatService>(), app.Service<PresenceService>(), app.Service<PersistenceWriter>());

    private LoadMetrics TwoMinutesWithASpike()
    {
        var load = NewLoad();
        for (var i = 0; i < 120; i++) load.Record(Second(i, i == 30 ? 100 : 10));   // two clock minutes, one 100 % second in the first
        load.Record(Second(120, 20));                                                 // the third minute starts, which closes the second
        return load;
    }

    [Fact(DisplayName = "AD-24: a closed clock minute becomes one bucket that keeps the CPU spike")]
    public void Minute_bucket_keeps_the_spike()
    {
        var day = TwoMinutesWithASpike().Last(86_400, 60);

        Assert.Equal(3, day.Count);                       // two closed minutes, then the minute in progress
        Assert.Equal((11.5, 100d), (day[0].CpuPercent, day[0].CpuPeakPercent));   // (59 * 10 + 100) / 60, and the spike
        Assert.Equal(Start.AddSeconds(59), day[0].At);    // a bucket carries the time of its last sample
        Assert.Equal((10d, 10d), (day[1].CpuPercent, day[1].CpuPeakPercent));
        Assert.Equal(Start.AddSeconds(120), day[2].At);
    }

    [Fact(DisplayName = "AD-24: a week merges the minutes and keeps the peak; an hour still reads the 1 s samples")]
    public void Long_range_merges_minutes()
    {
        var load = TwoMinutesWithASpike();

        var week = load.Last(604_800, 120);               // two minutes a point
        Assert.Equal(2, week.Count);
        Assert.Equal(100, week[0].CpuPeakPercent);

        var minute = load.Last(60, 1);
        Assert.Equal(60, minute.Count);
        Assert.Equal(Start.AddSeconds(120), minute[^1].At);
    }

    [Fact(DisplayName = "AD-28: the 30 s snapshots of a range merge into points with the highest counts and the last message total")]
    public void Snapshots_merge_to_peaks()
    {
        var collector = new DiagnosticsCollectorService(app.Service<ChatService>(), app.Service<PresenceService>(), NullLogger<DiagnosticsCollectorService>.Instance);
        for (var i = 0; i < 10; i++)
        {
            var busy = i == 3;   // one snapshot with a short visit
            collector.Record(new DiagnosticsSnapshot(Start.AddSeconds(30 * i), UserSessions: busy ? 9 : 1, UniqueUsers: busy ? 5 : 1, Channels: 0, RoomChannels: 0,
                DmChannels: 0, TotalMessages: 100 + i, ActiveConnections: busy ? 7 : 1, DisconnectedConnections: 0, TotalConnections: 0, TotalEventSubscribers: 0));
        }

        var series = collector.GetSeries(300, 150);       // the last 10 snapshots, five a point
        Assert.Equal(2, series.Count);
        Assert.Equal((5, 9, 7, 104), (series[0].UniqueUsers, series[0].UserSessions, series[0].ActiveConnections, series[0].TotalMessages));
        Assert.Equal((1, 109), (series[1].UniqueUsers, series[1].TotalMessages));
        Assert.Equal(4, collector.GetSeries(120, 1).Count);   // a range takes only its own snapshots
    }
}
