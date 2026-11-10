using System.Diagnostics;
using System.Globalization;

namespace Yap.Services.Gifs;

/// <summary>
/// ffprobe + ffmpeg subprocess wrappers tailored for the GIF pipeline.
/// Mirrors the patterns in MediaCacheService: timeouts, async process management,
/// SemaphoreSlim(2) concurrency, metadata stripping (-map_metadata -1), audio stripping (-an).
/// </summary>
public class GifFfmpegHelper
{
    private readonly ILogger<GifFfmpegHelper> _logger;
    private readonly SemaphoreSlim _transcodeSemaphore = new(2);

    private const int ProbeTimeoutMs = 10_000;
    private const int TranscodeTimeoutMs = 120_000;

    /// <summary>Whether ffmpeg+ffprobe are available on this system.</summary>
    public static bool IsAvailable { get; private set; }

    public GifFfmpegHelper(ILogger<GifFfmpegHelper> logger)
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
                _logger.LogWarning("ffmpeg not found — GIF transcoding will be unavailable");
                return;
            }
            // Drain both pipes asynchronously so a large `-version` banner can't fill the OS pipe
            // buffer and deadlock WaitForExit (the classic redirect-without-read hang).
            process.OutputDataReceived += static (_, _) => { };
            process.ErrorDataReceived += static (_, _) => { };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            var exited = process.WaitForExit(3000);
            if (!exited) { try { process.Kill(entireProcessTree: true); } catch { } }
            IsAvailable = exited && process.ExitCode == 0;
            if (IsAvailable) _logger.LogInformation("ffmpeg detected for GIF pipeline");
            else _logger.LogWarning("ffmpeg not found — GIF transcoding will be unavailable");
        }
        catch
        {
            IsAvailable = false;
            _logger.LogWarning("ffmpeg not found — GIF transcoding will be unavailable");
        }
    }

    /// <summary>
    /// Probes a media file with ffprobe. Returns null on failure.
    /// </summary>
    public async Task<MediaProbeResult?> ProbeAsync(string filePath, CancellationToken ct = default)
    {
        if (!IsAvailable || !File.Exists(filePath)) return null;

        // We request both video and audio stream info plus format duration in one ffprobe call.
        var args = $"-v error -show_entries " +
                   $"stream=codec_type,codec_name,width,height:format=duration " +
                   $"-of default=noprint_wrappers=1 \"{filePath}\"";

        var (exitCode, stdout, _) = await RunProcessAsync("ffprobe", args, ProbeTimeoutMs, ct);
        if (exitCode != 0) return null;

        string? videoCodec = null;
        int width = 0, height = 0;
        bool hasAudio = false;
        double duration = 0;
        // ffprobe with multiple stream entries emits a flat key=value list per stream.
        // We rely on stream ordering: each stream block starts with codec_type=.
        string? currentStreamType = null;
        foreach (var raw in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var line = raw.Trim();
            var eq = line.IndexOf('=');
            if (eq < 0) continue;
            var key = line[..eq];
            var value = line[(eq + 1)..];

            switch (key)
            {
                case "codec_type":
                    currentStreamType = value;
                    if (value == "audio") hasAudio = true;
                    break;
                case "codec_name":
                    if (currentStreamType == "video" && videoCodec == null) videoCodec = value;
                    break;
                case "width":
                    if (currentStreamType == "video" && width == 0) int.TryParse(value, out width);
                    break;
                case "height":
                    if (currentStreamType == "video" && height == 0) int.TryParse(value, out height);
                    break;
                case "duration":
                    double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out duration);
                    break;
            }
        }

        return new MediaProbeResult(videoCodec, width, height, hasAudio, duration);
    }

    /// <summary>
    /// Transcodes a source media file into an animated WebP. Animated WebP plays in an
    /// &lt;img&gt; tag (no autoplay policy to work around) and is ~2× smaller than
    /// the equivalent GIF for the same content. Caps at 15fps and max-width 480px.
    /// </summary>
    public Task<bool> TranscodeToAnimatedWebpAsync(string srcPath, string dstPath, CancellationToken ct = default)
        => TranscodeToWebpCoreAsync(srcPath, dstPath, fps: 15, maxWidth: 480, quality: 75, ct);

    /// <summary>
    /// Cuts the small picker/management-grid preview: 12fps, max-width 320px, q60 — measured
    /// 6–57× lighter than the full files it stands in for, at ~0.5s per file. Works from any
    /// source ffmpeg can decode; animated-WebP inputs decode only on ffmpeg ≥ 9.0 (no 7.x/8.x
    /// release has the decoder) — older builds fail cleanly here (non-zero exit) and the caller
    /// treats that as "no preview".
    /// </summary>
    public Task<bool> TranscodeToPreviewWebpAsync(string srcPath, string dstPath, CancellationToken ct = default)
        => TranscodeToWebpCoreAsync(srcPath, dstPath, fps: 12, maxWidth: 320, quality: 60, ct);

    private Task<bool> TranscodeToWebpCoreAsync(string srcPath, string dstPath, int fps, int maxWidth, int quality, CancellationToken ct)
    {
        if (!IsAvailable) return Task.FromResult(false);
        return LimitedAsync(async () =>
        {
            // -map 0:n              → the stream with the animation, only for a file with more than one (AnimationStreamAsync)
            // -vcodec libwebp + multi-frame input → animated webp.
            // -loop 0               → infinite loop
            // -lossless 0 -q:v n -compression_level 4 → balanced quality/size
            // -an                   → strip audio
            // -fps_mode passthrough → preserve frame timing (successor of the deprecated -vsync 0)
            // -map_metadata -1      → strip metadata
            // -hide_banner -nostats → stderr carries only warnings/errors, so failure logs show the cause
            var map = await AnimationStreamAsync(srcPath, ct) is { } stream ? $"-map 0:{stream} " : "";
            var args = $"-hide_banner -nostats -y -i \"{srcPath}\" {map}" +
                       $"-vf \"fps={fps},scale='min({maxWidth},iw)':-1:flags=lanczos\" " +
                       $"-vcodec libwebp -loop 0 -lossless 0 -q:v {quality} -compression_level 4 " +
                       $"-an -fps_mode passthrough -map_metadata -1 \"{dstPath}\"";

            var (exit, _, stderr) = await RunProcessAsync("ffmpeg", args, TranscodeTimeoutMs, ct);
            if (exit != 0)
            {
                _logger.LogWarning("ffmpeg webp transcode failed for {Src} (exit={Exit}): {Stderr}", srcPath, exit, TruncateTail(stderr));
                TryDelete(dstPath);
                return false;
            }
            return File.Exists(dstPath) && new FileInfo(dstPath).Length > 0;
        }, ct);
    }

    /// <summary>
    /// The index of the video stream with the most frames, for a file that holds more than one video stream.
    /// Null for every other file, and ffmpeg then makes its own choice. An animated AVIF holds its still picture
    /// as stream 0 and the animation as stream 1, both with the same size: ffmpeg takes the first, and the
    /// result was one frame (measured with ffmpeg 8.0.1). The cover picture of an MP4 is a stream of one frame too.
    /// </summary>
    private async Task<int?> AnimationStreamAsync(string filePath, CancellationToken ct)
    {
        var args = $"-v error -select_streams v -show_entries stream=index,nb_frames -of csv=p=0 \"{filePath}\"";
        var (exitCode, stdout, _) = await RunProcessAsync("ffprobe", args, ProbeTimeoutMs, ct);
        if (exitCode != 0) return null;

        // One line per video stream: "index,frames". A container that does not count its frames (WebM, GIF)
        // gives "N/A", and such a line does not take part.
        var streams = new List<(int Index, long Frames)>();
        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = line.Split(',');
            if (fields.Length >= 2 && int.TryParse(fields[0], out var index) && long.TryParse(fields[1], out var frames))
                streams.Add((index, frames));
        }
        return streams.Count > 1 ? streams.MaxBy(s => s.Frames).Index : null;
    }

    /// <summary>Runs one ffmpeg pass inside the limit of two at a time. The GIF previews and the voice messages
    /// (VoiceService) share it: a burst of either must not start more encoders than the box has cores.</summary>
    internal async Task<T> LimitedAsync<T>(Func<Task<T>> transcode, CancellationToken ct)
    {
        await _transcodeSemaphore.WaitAsync(ct);
        try { return await transcode(); }
        finally { _transcodeSemaphore.Release(); }
    }

    // Internal, not private: VoiceService runs its one ffmpeg pass through here instead of a fourth process runner.
    internal async Task<(int ExitCode, string Stdout, string Stderr)> RunProcessAsync(
        string fileName, string args, int timeoutMs, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(fileName, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi);
        if (process == null) return (-1, "", "Failed to start process");

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeoutMs);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
            return (process.ExitCode, await stdoutTask, await stderrTask);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            if (ct.IsCancellationRequested) throw;
            _logger.LogWarning("{Cmd} timed out after {TimeoutMs}ms", fileName, timeoutMs);
            return (-1, "", "Timeout");
        }
    }

    // Internal, not private: VoiceService shares the two helpers below instead of carrying copies.
    internal static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    // ffmpeg puts the actionable error at the END of stderr — the head is banner/config/input-dump
    // noise (a full banner alone once ate the whole 400-char budget and hid a prod failure's cause).
    internal static string TruncateTail(string s, int max = 600)
        => s.Length <= max ? s : "…" + s[^max..];
}

public record MediaProbeResult(
    string? VideoCodec,
    int Width,
    int Height,
    bool HasAudio,
    double DurationSeconds
);
