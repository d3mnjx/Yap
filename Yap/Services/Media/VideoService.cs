using Yap.Services.Gifs;

namespace Yap.Services.Media;

/// <summary>
/// FFmpeg wrapper for video processing: poster extraction and compression.
/// Mirrors ImageService pattern — singleton, fire-and-forget background work.
/// The ffmpeg probe and the process runner are the ones of <see cref="GifFfmpegHelper"/>, as in VoiceService.
/// </summary>
public class VideoService(ILogger<VideoService> logger, GifFfmpegHelper ffmpeg)
{
    /// <summary>Whether FFmpeg is available on this system. The helper's constructor runs the probe, and the
    /// helper is a constructor parameter here, so the value is set before a VideoService exists.</summary>
    public static bool IsAvailable => GifFfmpegHelper.IsAvailable;

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".mov", ".avi", ".mkv"
    };

    // Small videos don't need compression
    private const long CompressionThreshold = 8 * 1024 * 1024; // 8 MB

    /// <summary>
    /// Checks if a file extension is a supported video type.
    /// </summary>
    public static bool IsVideoFile(string extension) => VideoExtensions.Contains(extension);

    /// <summary>
    /// URL convention: /uploads/{guid}.mov → /uploads/{guid}_poster.webp
    /// </summary>
    public static string GetPosterUrl(string originalUrl)
    {
        var lastDot = originalUrl.LastIndexOf('.');
        if (lastDot < 0) return originalUrl;
        return $"{originalUrl[..lastDot]}_poster.webp";
    }

    /// <summary>
    /// URL convention: /uploads/{guid}.mov → /uploads/{guid}.mp4
    /// </summary>
    public static string GetCompressedUrl(string originalUrl)
    {
        var lastDot = originalUrl.LastIndexOf('.');
        if (lastDot < 0) return originalUrl;
        return $"{originalUrl[..lastDot]}.mp4";
    }

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
                logger.LogDebug("Poster generated: {PosterPath}", posterPath);
                return posterPath;
            }

            logger.LogWarning("Failed to generate poster for {VideoPath}", videoPath);
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error generating poster for {VideoPath}", videoPath);
            return null;
        }
    }

    /// <summary>
    /// Compresses video to MP4 H.264 (background, slow).
    /// Returns the compressed file path and duration in ms, or (null, 0) on failure.
    /// Deletes the original file after successful compression. A failure leaves the original as it was
    /// and no .mp4 beside it.
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
                logger.LogDebug("Video {VideoPath} is small MP4 ({Size}KB), skipping compression", videoPath, fileSize / 1024);
                return (videoPath, 0);
            }

            // ffmpeg never writes to the final name, also not for a .mov, where that name is free. A run that fails
            // or that the time limit stops leaves half a file, and at the final name that half looks like a finished
            // video to every check for the file (TusEndpoints, VideoPosterBackfill).
            var outputPath = Path.Combine(directory, $"{filename}_compressed.mp4");
            var isInPlace = string.Equals(videoPath, compressedPath, StringComparison.OrdinalIgnoreCase);

            var args = $"-i \"{videoPath}\" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart -vf \"scale='min(1280,iw)':-2\" -y \"{outputPath}\"";
            var exitCode = await RunFfmpegAsync(args, timeoutMs: 600_000); // 10 min timeout; the client's wait is above it (WORK_MS, upload.js)

            if (exitCode == 0 && File.Exists(outputPath))
            {
                // For an .mp4 upload the move replaces the original. This changes the bytes at a public URL that
                // browsers keep for a year (Program.cs), so the caller must not give the URL to anyone before
                // this method returns (TusEndpoints).
                File.Move(outputPath, compressedPath, overwrite: true);
                if (!isInPlace)
                {
                    // Delete original (different extension, e.g., .mov)
                    GifFfmpegHelper.TryDelete(videoPath);
                }

                sw.Stop();
                logger.LogInformation("Video compressed: {CompressedPath} ({OriginalSize}KB → {NewSize}KB) in {Duration}ms",
                    compressedPath,
                    fileSize / 1024,
                    new FileInfo(compressedPath).Length / 1024,
                    sw.ElapsedMilliseconds);
                return (compressedPath, sw.ElapsedMilliseconds);
            }

            // Cleanup temp file on failure
            GifFfmpegHelper.TryDelete(outputPath);

            logger.LogWarning("Failed to compress video {VideoPath} (exit code: {ExitCode})", videoPath, exitCode);
            return (null, 0);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error compressing video {VideoPath}", videoPath);
            return (null, 0);
        }
    }

    // The exit code, or -1 when the time limit stopped ffmpeg. Not through the helper's LimitedAsync: that limit of
    // two at a time is for the GIF previews and the voice messages, and a video compression holds a place for minutes.
    private async Task<int> RunFfmpegAsync(string args, int timeoutMs = 30_000) =>
        (await ffmpeg.RunProcessAsync("ffmpeg", args, timeoutMs, CancellationToken.None)).ExitCode;
}
