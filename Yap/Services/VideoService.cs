using System.Diagnostics;

namespace Yap.Services;

/// <summary>
/// FFmpeg wrapper for video processing: poster extraction and compression.
/// Mirrors ImageService pattern — singleton, fire-and-forget background work.
/// </summary>
public class VideoService
{
    private readonly ILogger<VideoService> _logger;

    /// <summary>Whether FFmpeg is available on this system.</summary>
    public static bool IsAvailable { get; private set; }

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".mov", ".avi", ".mkv"
    };

    // Small videos don't need compression
    private const long CompressionThreshold = 8 * 1024 * 1024; // 8 MB

    public VideoService(ILogger<VideoService> logger)
    {
        _logger = logger;
        DetectFfmpeg();
    }

    private void DetectFfmpeg()
    {
        try
        {
            var psi = new ProcessStartInfo("ffmpeg", "-version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(psi);
            if (process == null)
            {
                IsAvailable = false;
                _logger.LogWarning("FFmpeg not found — video processing will be unavailable");
                return;
            }
            // Drain both pipes so a large `-version` banner can't fill the OS pipe buffer and
            // deadlock WaitForExit (the redirect-without-read hang).
            process.OutputDataReceived += static (_, _) => { };
            process.ErrorDataReceived += static (_, _) => { };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            var exited = process.WaitForExit(3000);
            if (!exited) { try { process.Kill(entireProcessTree: true); } catch { } }
            IsAvailable = exited && process.ExitCode == 0;

            if (IsAvailable)
                _logger.LogInformation("FFmpeg detected and available");
            else
                _logger.LogWarning("FFmpeg not found — video processing will be unavailable");
        }
        catch
        {
            IsAvailable = false;
            _logger.LogWarning("FFmpeg not found — video processing will be unavailable");
        }
    }

    /// <summary>
    /// Checks if a file extension is a supported video type.
    /// </summary>
    public static bool IsVideoFile(string extension) => VideoExtensions.Contains(extension);

    /// <summary>
    /// Extracts a poster frame from the video (~1s, blocking).
    /// Returns the poster file path, or null on failure.
    /// </summary>
    public async Task<string?> GeneratePosterAsync(string videoPath)
    {
        if (!IsAvailable) return null;

        try
        {
            var directory = Path.GetDirectoryName(videoPath)!;
            var filename = Path.GetFileNameWithoutExtension(videoPath);
            var posterPath = Path.Combine(directory, $"{filename}_poster.webp");

            // Extract frame at 1 second (falls back to 0s for very short videos)
            var args = $"-i \"{videoPath}\" -ss 00:00:01 -frames:v 1 -vf \"scale=800:-2\" -y \"{posterPath}\"";
            var exitCode = await RunFfmpegAsync(args);

            // If 1s seek failed (video shorter than 1s), try at 0s
            if (exitCode != 0 || !File.Exists(posterPath))
            {
                args = $"-i \"{videoPath}\" -ss 00:00:00 -frames:v 1 -vf \"scale=800:-2\" -y \"{posterPath}\"";
                exitCode = await RunFfmpegAsync(args);
            }

            if (exitCode == 0 && File.Exists(posterPath))
            {
                _logger.LogDebug("Poster generated: {PosterPath}", posterPath);
                return posterPath;
            }

            _logger.LogWarning("Failed to generate poster for {VideoPath}", videoPath);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating poster for {VideoPath}", videoPath);
            return null;
        }
    }

    /// <summary>
    /// Compresses video to MP4 H.264 (background, slow).
    /// Returns the compressed file path and duration in ms, or (null, 0) on failure.
    /// Deletes the original file after successful compression.
    /// </summary>
    public async Task<(string? Path, long DurationMs)> CompressVideoAsync(string videoPath)
    {
        if (!IsAvailable) return (null, 0);

        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var directory = Path.GetDirectoryName(videoPath)!;
            var filename = Path.GetFileNameWithoutExtension(videoPath);
            var compressedPath = Path.Combine(directory, $"{filename}.mp4");
            var extension = Path.GetExtension(videoPath).ToLowerInvariant();

            // If already a small MP4, skip compression
            var fileSize = new FileInfo(videoPath).Length;
            if (extension == ".mp4" && fileSize <= CompressionThreshold)
            {
                _logger.LogDebug("Video {VideoPath} is small MP4 ({Size}KB), skipping compression", videoPath, fileSize / 1024);
                return (videoPath, 0);
            }

            // If input is already .mp4, compress to a temp file then replace
            var outputPath = compressedPath;
            var isInPlace = string.Equals(videoPath, compressedPath, StringComparison.OrdinalIgnoreCase);
            if (isInPlace)
            {
                outputPath = Path.Combine(directory, $"{filename}_compressed.mp4");
            }

            var args = $"-i \"{videoPath}\" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart -vf \"scale='min(1280,iw)':-2\" -y \"{outputPath}\"";
            var exitCode = await RunFfmpegAsync(args, timeoutMs: 600_000); // 10 min timeout

            if (exitCode == 0 && File.Exists(outputPath))
            {
                if (isInPlace)
                {
                    // Replace original with compressed
                    try { File.Delete(videoPath); } catch { }
                    File.Move(outputPath, compressedPath);
                }
                else
                {
                    // Delete original (different extension, e.g., .mov)
                    try { File.Delete(videoPath); } catch { }
                }

                sw.Stop();
                _logger.LogInformation("Video compressed: {CompressedPath} ({OriginalSize}KB → {NewSize}KB) in {Duration}ms",
                    compressedPath,
                    fileSize / 1024,
                    new FileInfo(compressedPath).Length / 1024,
                    sw.ElapsedMilliseconds);
                return (compressedPath, sw.ElapsedMilliseconds);
            }

            // Cleanup temp file on failure
            if (isInPlace && File.Exists(outputPath))
                try { File.Delete(outputPath); } catch { }

            _logger.LogWarning("Failed to compress video {VideoPath} (exit code: {ExitCode})", videoPath, exitCode);
            return (null, 0);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error compressing video {VideoPath}", videoPath);
            return (null, 0);
        }
    }

    private static async Task<int> RunFfmpegAsync(string args, int timeoutMs = 30_000)
    {
        var psi = new ProcessStartInfo("ffmpeg", args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi)!;

        // Drain stdout/stderr to prevent pipe buffer deadlocks
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();

        using var cts = new CancellationTokenSource(timeoutMs);
        try
        {
            await process.WaitForExitAsync(cts.Token);
            await Task.WhenAll(stdoutTask, stderrTask);
            return process.ExitCode;
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return -1;
        }
    }
}
