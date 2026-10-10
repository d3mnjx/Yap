namespace Yap.Services;

// A day of retry deduplication in either backend; deletion never removes a fresh receipt.
public sealed class ChatReceiptCleanup(IChatStore store, ILogger<ChatReceiptCleanup> logger) : BackgroundService
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(1);
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await store.PruneReceiptsAsync(DateTime.UtcNow - Retention); }
            catch (Exception error) { logger.LogError(error, "Could not prune expired chat receipts"); }
            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }
}
