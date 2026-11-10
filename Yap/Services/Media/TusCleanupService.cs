using tusdotnet.Stores;

namespace Yap.Services.Media;

/// <summary>
/// Removes the unfinished tus uploads that passed their expiry (a day after the last chunk, TusEndpoints). The
/// store only marks them; without a sweep an abandoned upload keeps its disk for ever, and a person can fill the
/// volume by starting uploads and never finishing them. Also removes the result files of finished uploads after a
/// day: the uploader's client reads its result within seconds and keeps it, and nothing else reads the file.
/// </summary>
public sealed class TusCleanupService(UploadPaths paths, ILogger<TusCleanupService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        do
        {
            try
            {
                Directory.CreateDirectory(paths.TusResults);   // creates tus-temp above it too
                // The store needs the ids' own provider: with its default it does not accept the ids, and the sweep fails.
                var removed = await new TusDiskStore(paths.TusTemp, false, TusDiskBufferSize.Default, new UploadIds(Guid.Empty)).RemoveExpiredFilesAsync(stoppingToken);
                if (removed > 0) log.LogInformation("Removed {Count} expired upload(s)", removed);
                foreach (var result in Directory.EnumerateFiles(paths.TusResults))
                    if (File.GetLastWriteTimeUtc(result) < DateTime.UtcNow.AddDays(-1)) File.Delete(result);
            }
            catch (OperationCanceledException) { return; }
            catch (Exception e) { log.LogWarning(e, "The sweep of expired uploads failed"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
