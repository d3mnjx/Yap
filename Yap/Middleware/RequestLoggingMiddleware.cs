using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using Yap.Helpers;
using Yap.Models;
using Yap.Services;

namespace Yap.Middleware;

/// <summary>
/// Logs HTTP requests to daily CSV files with buffered writes.
/// Filters out static files, framework paths, and uploaded images.
/// </summary>
public class RequestLoggingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly RequestLogQueue _logQueue;
    private readonly UserActionLogService _actionLog;

    private static readonly string[] SkipPrefixes = ["/_framework", "/_blazor", "/uploads"];
    private static readonly string[] SkipExtensions = [".js", ".css", ".webp", ".png", ".jpg", ".jpeg", ".gif", ".webmanifest", ".mp4", ".webm", ".mov", ".avi", ".mkv"];

    public RequestLoggingMiddleware(RequestDelegate next, RequestLogQueue logQueue, UserActionLogService actionLog)
    {
        _next = next;
        _logQueue = logQueue;
        _actionLog = actionLog;
    }

    /// <summary>
    /// Bearer credentials travel in a few URLs. Strip them before the URL reaches any sink
    /// (the CSV file and the action-log DB both get the full URL).
    /// </summary>
    private static string RedactCredentials(string path, QueryString query)
    {
        if (path.StartsWith("/invite/", StringComparison.OrdinalIgnoreCase))
            return "/invite/REDACTED" + query;
        if (!query.HasValue)
            return path;
        if (path.Equals("/pwa-launch", StringComparison.OrdinalIgnoreCase))
            return path + "?lt=REDACTED";
        if (path.Equals("/auth/refresh-token", StringComparison.OrdinalIgnoreCase))
            return path + "?token=REDACTED";
        return path + query;
    }

    /// <summary>
    /// The Referer is the previous page's full URL, so every request the invite page makes
    /// (the POST, fonts, the redirect target) would carry the code in it.
    /// </summary>
    private static string RedactReferer(string referer)
    {
        if (referer.Length == 0 || !Uri.TryCreate(referer, UriKind.Absolute, out var uri))
            return referer;

        var redacted = RedactCredentials(uri.AbsolutePath, new QueryString(uri.Query));
        return redacted == uri.PathAndQuery
            ? referer
            : uri.GetLeftPart(UriPartial.Authority) + redacted;
    }

    public async Task InvokeAsync(HttpContext context, UserStateService userState)
    {
        var path = context.Request.Path.Value ?? "";

        if (ShouldSkip(path))
        {
            await _next(context);
            return;
        }

        var stopwatch = Stopwatch.StartNew();

        try
        {
            await _next(context);
        }
        finally
        {
            stopwatch.Stop();

            var clientIp = IpHelper.GetClientIp(context) ?? "unknown";

            var loggedUrl = RedactCredentials(path, context.Request.QueryString);

            var entry = new RequestLogEntry
            {
                Timestamp = DateTime.UtcNow,
                Method = context.Request.Method,
                Path = loggedUrl,
                StatusCode = context.Response.StatusCode,
                DurationMs = stopwatch.ElapsedMilliseconds,
                ClientIp = clientIp,
                UserAgent = context.Request.Headers.UserAgent.ToString(),
                Referer = RedactReferer(context.Request.Headers.Referer.ToString()),
                Protocol = context.Request.Protocol,
                ConnectionId = context.Connection.Id
            };

            _logQueue.Enqueue(entry);

            // Also log to database (UserStateService populated by AuthMiddleware upstream)
            _actionLog.Log(
                userState.UserId?.ToString(),
                UserActionLog.KnownActions.HTTP_REQUEST,
                url: loggedUrl,
                ip: clientIp,
                userAgent: context.Request.Headers.UserAgent.ToString());
        }
    }

    private static bool ShouldSkip(string path)
    {
        foreach (var prefix in SkipPrefixes)
        {
            if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        foreach (var ext in SkipExtensions)
        {
            if (path.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

}

/// <summary>
/// Log entry record for a single HTTP request.
/// </summary>
public record RequestLogEntry
{
    public DateTime Timestamp { get; init; }
    public string Method { get; init; } = "";
    public string Path { get; init; } = "";
    public int StatusCode { get; init; }
    public long DurationMs { get; init; }
    public string ClientIp { get; init; } = "";
    public string UserAgent { get; init; } = "";
    public string Referer { get; init; } = "";
    public string Protocol { get; init; } = "";
    public string ConnectionId { get; init; } = "";
}

/// <summary>
/// Thread-safe queue for buffering log entries.
/// Middleware writes here, background writer reads from here.
/// </summary>
public class RequestLogQueue
{
    private readonly ConcurrentQueue<RequestLogEntry> _queue = new();

    public void Enqueue(RequestLogEntry entry) => _queue.Enqueue(entry);

    public bool TryDequeue(out RequestLogEntry? entry) => _queue.TryDequeue(out entry);

    public bool IsEmpty => _queue.IsEmpty;
}

/// <summary>
/// Background service that periodically flushes the log queue to CSV files.
/// One file per day: Data/RequestLogs/yyyy-MM-dd.csv
/// </summary>
public class RequestLogWriter : IHostedService, IDisposable
{
    private readonly RequestLogQueue _queue;
    private readonly string _logDirectory;
    private Timer? _flushTimer;
    private readonly object _writeLock = new();

    private const string CsvHeader = "Timestamp,Method,Path,StatusCode,DurationMs,ClientIP,UserAgent,Referer,Protocol,ConnectionId";

    public RequestLogWriter(RequestLogQueue queue, IWebHostEnvironment env)
    {
        _queue = queue;
        _logDirectory = Path.Combine(env.ContentRootPath, "Data", "RequestLogs");
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_logDirectory);
        CleanupOldLogs();
        _flushTimer = new Timer(FlushCallback, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
        return Task.CompletedTask;
    }

    private void CleanupOldLogs()
    {
        var cutoff = DateTime.UtcNow.AddMonths(-1);
        var deleted = 0;

        foreach (var file in Directory.GetFiles(_logDirectory, "*.csv"))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            if (DateOnly.TryParseExact(name, "yyyy-MM-dd", out var date) && date < DateOnly.FromDateTime(cutoff))
            {
                try { File.Delete(file); deleted++; } catch { }
            }
        }

        if (deleted > 0)
            Console.WriteLine($"[RequestLog] Cleaned up {deleted} log files older than 1 month");
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _flushTimer?.Change(Timeout.Infinite, 0);
        Flush(); // Final flush on shutdown
        return Task.CompletedTask;
    }

    private void FlushCallback(object? state) => Flush();

    private void Flush()
    {
        if (_queue.IsEmpty) return;

        // Drain the queue
        var entries = new List<RequestLogEntry>();
        while (_queue.TryDequeue(out var entry))
        {
            if (entry != null) entries.Add(entry);
        }

        if (entries.Count == 0) return;

        // Group by date (in case entries span midnight)
        var byDate = entries.GroupBy(e => e.Timestamp.Date);

        lock (_writeLock)
        {
            foreach (var group in byDate)
            {
                var fileName = $"{group.Key:yyyy-MM-dd}.csv";
                var filePath = Path.Combine(_logDirectory, fileName);

                var isNewFile = !File.Exists(filePath);

                var sb = new StringBuilder();

                if (isNewFile)
                {
                    sb.AppendLine(CsvHeader);
                }

                foreach (var entry in group)
                {
                    sb.AppendLine(FormatCsvLine(entry));
                }

                File.AppendAllText(filePath, sb.ToString());
            }
        }

        Console.WriteLine($"[RequestLog] Flushed {entries.Count} entries to disk");
    }

    private static string FormatCsvLine(RequestLogEntry entry)
    {
        return string.Join(",",
            entry.Timestamp.ToString("yyyy-MM-dd HH:mm:ss.fff"),
            EscapeCsv(entry.Method),
            EscapeCsv(entry.Path),
            entry.StatusCode,
            entry.DurationMs,
            EscapeCsv(entry.ClientIp),
            EscapeCsv(entry.UserAgent),
            EscapeCsv(entry.Referer),
            EscapeCsv(entry.Protocol),
            EscapeCsv(entry.ConnectionId)
        );
    }

    private static string EscapeCsv(string value)
    {
        if (string.IsNullOrEmpty(value))
            return "";

        if (value.Contains(',') || value.Contains('"') || value.Contains('\n') || value.Contains('\r'))
        {
            return $"\"{value.Replace("\"", "\"\"")}\"";
        }

        return value;
    }

    public void Dispose()
    {
        _flushTimer?.Dispose();
    }
}
