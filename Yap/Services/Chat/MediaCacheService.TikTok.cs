using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Yap.Models;
using Yap.Models.Chat;

namespace Yap.Services.Chat;

/// <summary>
/// TikTok photo posts ("photo mode" slideshows). TikTok plays them as a slideshow over a
/// soundtrack, but there is no video stream anywhere: yt-dlp offers only the mp3. To keep
/// people inside the chat we rebuild that slideshow ourselves — slides from the page data,
/// soundtrack from yt-dlp, ffmpeg glues them into an ordinary H.264 mp4.
/// </summary>
public partial class MediaCacheService
{
    // TikTok caps photo posts at 35 slides; anything above that is not a real post.
    private const int MaxSlides = 35;
    private const long MaxSlideBytes = 20 * 1024 * 1024;

    // Slide timing mirrors how TikTok paces photo mode: a few seconds per slide, the sound
    // looping underneath. One slide gets the whole sound (capped) so a meme cut isn't chopped.
    private const double MinSecondsPerSlide = 3;
    private const double MaxSecondsPerSlide = 10;

    // Output canvas: 720 wide like the video path's height cap; height follows the first slide's
    // aspect so a square post stays square and a portrait post stays portrait.
    private const int CanvasWidth = 720;
    private const int MinCanvasHeight = 406;
    private const int MaxCanvasHeight = 1280;

    [GeneratedRegex(@"Unsupported URL:\s*https?://(?:www\.)?tiktok\.com/@(?<user>[\w.-]+)/photo/(?<id>\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex UnsupportedPhotoUrlRegex();

    // The page embeds its state as one JSON blob; this is the same tag yt-dlp's extractor reads.
    [GeneratedRegex(@"<script id=""__UNIVERSAL_DATA_FOR_REHYDRATION__"" type=""application/json"">(.*?)</script>", RegexOptions.Singleline)]
    private static partial Regex UniversalDataRegex();

    private static bool TryGetTikTokPhotoVideoUrl(string ytDlpOutput, out string videoUrl)
    {
        var m = UnsupportedPhotoUrlRegex().Match(ytDlpOutput);
        videoUrl = m.Success ? $"https://www.tiktok.com/@{m.Groups["user"].Value}/video/{m.Groups["id"].Value}" : "";
        return m.Success;
    }

    private async Task<MediaCacheEntry?> DownloadTikTokSlideshowAsync(string url, string videoUrl, string hash, MediaMetadata metadata, Stopwatch sw)
    {
        var workDir = Path.Combine(Path.GetTempPath(), $"yap-slideshow-{hash}");
        try
        {
            Directory.CreateDirectory(workDir);

            var slideUrls = await FetchSlideUrlsAsync(videoUrl, workDir);
            if (slideUrls.Count == 0)
            {
                _logger.LogWarning("TikTok photo post {Url}: no slides found in page data", url);
                return null;
            }

            var slides = await DownloadSlidesAsync(slideUrls, workDir);
            if (slides.Count == 0)
            {
                _logger.LogWarning("TikTok photo post {Url}: none of {Count} slides downloaded", url, slideUrls.Count);
                return null;
            }

            // The soundtrack is optional: a silent slideshow still beats a dead link.
            var audioPath = await DownloadSoundtrackAsync(videoUrl, workDir);

            var outputPath = Path.Combine(CacheDirectory, $"{hash}.mp4");
            var totalSeconds = await RenderSlideshowAsync(slides, audioPath, metadata.Duration, outputPath);
            if (totalSeconds == null)
            {
                TryDeleteFile(outputPath);
                _logger.LogWarning("TikTok photo post {Url}: ffmpeg failed to render the slideshow", url);
                return null;
            }

            var fileSize = new FileInfo(outputPath).Length;
            var (w, h, poster) = await DescribeVideoAsync(hash, outputPath);

            _logger.LogInformation("Cached TikTok slideshow: {Url} -> {File} ({Slides} slides, {SizeKB}KB, {Duration}s, {Audio}, {Dims}, {ElapsedMs}ms)",
                url, Path.GetFileName(outputPath), slides.Count, fileSize / 1024, (int)totalSeconds.Value,
                audioPath != null ? "with sound" : "silent", w > 0 ? $"{w}x{h}" : "-", sw.ElapsedMilliseconds);

            return new MediaCacheEntry($"/media-cache/{hash}.mp4", CachedMediaType.Video, (int)totalSeconds.Value, w, h, metadata.Title, metadata.Thumbnail, poster);
        }
        finally
        {
            try { Directory.Delete(workDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Gets the slide image URLs. yt-dlp is the only client here that gets past TikTok's
    /// browser-fingerprint challenge (curl_cffi impersonation, see the Dockerfile), so we let it
    /// fetch the page and keep the raw HTML with --write-pages, then read the slides out of the
    /// same rehydration JSON the extractor itself parses. --write-pages ignores -o/-P and dumps
    /// into the working directory, hence the dedicated work dir.
    /// </summary>
    private async Task<List<string>> FetchSlideUrlsAsync(string videoUrl, string workDir)
    {
        var (exitCode, output) = await RunYtDlpAsync(
            ["--write-pages", "--skip-download", "--no-playlist", "--", videoUrl], MetadataTimeoutMs, workDir);
        if (exitCode != 0)
        {
            _logger.LogWarning("yt-dlp page fetch failed for {Url} (exit {Code}): {Err}", videoUrl, exitCode, TruncateLog(output));
            return [];
        }

        // A challenged fetch leaves two dumps (challenge page, then the real one); scan them all.
        foreach (var dump in Directory.GetFiles(workDir, "*.dump"))
        {
            var html = await File.ReadAllTextAsync(dump);
            var m = UniversalDataRegex().Match(html);
            if (!m.Success) continue;

            try
            {
                using var doc = JsonDocument.Parse(m.Groups[1].Value);
                if (!doc.RootElement.TryGetProperty("__DEFAULT_SCOPE__", out var scope)
                    || !scope.TryGetProperty("webapp.video-detail", out var detail)
                    || !detail.TryGetProperty("itemInfo", out var itemInfo)
                    || !itemInfo.TryGetProperty("itemStruct", out var item)
                    || !item.TryGetProperty("imagePost", out var imagePost)
                    || !imagePost.TryGetProperty("images", out var images))
                    continue;

                var urls = new List<string>();
                foreach (var image in images.EnumerateArray())
                {
                    if (image.TryGetProperty("imageURL", out var imageUrl)
                        && imageUrl.TryGetProperty("urlList", out var urlList)
                        && urlList.GetArrayLength() > 0
                        && urlList[0].GetString() is { Length: > 0 } first)
                        urls.Add(first);
                    if (urls.Count >= MaxSlides) break;
                }
                return urls;
            }
            catch (JsonException ex)
            {
                _logger.LogDebug(ex, "Rehydration JSON in {Dump} did not parse", Path.GetFileName(dump));
            }
        }
        return [];
    }

    private async Task<List<string>> DownloadSlidesAsync(List<string> slideUrls, string workDir)
    {
        var client = _httpClientFactory.CreateClient("MediaFetch");
        var paths = new List<string>();
        for (var i = 0; i < slideUrls.Count; i++)
        {
            var slideUrl = slideUrls[i];
            try
            {
                // The URLs come from TikTok's own page data, but they are still remote input:
                // keep the usual no-private-address rule the link scraper applies.
                if (!Uri.TryCreate(slideUrl, UriKind.Absolute, out var uri)
                    || uri.Scheme != Uri.UriSchemeHttps
                    || !await NetworkSecurityHelper.IsPublicHostAsync(uri.Host))
                {
                    _logger.LogDebug("Skipping slide {Index}: rejected URL {Url}", i, slideUrl);
                    continue;
                }

                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                request.Headers.Referrer = new Uri("https://www.tiktok.com/");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogDebug("Slide {Index} returned {Status}", i, (int)response.StatusCode);
                    continue;
                }
                if (response.Content.Headers.ContentLength > MaxSlideBytes)
                    continue;

                var ext = response.Content.Headers.ContentType?.MediaType switch
                {
                    "image/png" => ".png",
                    "image/webp" => ".webp",
                    _ => ".jpg"
                };
                var path = Path.Combine(workDir, $"slide{i:00}{ext}");
                await using (var file = File.Create(path))
                    await response.Content.CopyToAsync(file);
                paths.Add(path);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
            {
                _logger.LogDebug(ex, "Slide {Index} download failed", i);
            }
        }
        return paths;
    }

    private async Task<string?> DownloadSoundtrackAsync(string videoUrl, string workDir)
    {
        var (exitCode, stderr) = await RunYtDlpAsync(
            ["--no-playlist", "-x", "--audio-format", "mp3", "-o", Path.Combine(workDir, "audio.%(ext)s"), "--", videoUrl], DownloadTimeoutMs);
        if (exitCode != 0)
        {
            _logger.LogDebug("Soundtrack download failed for {Url}: {Err}", videoUrl, TruncateLog(stderr));
            return null;
        }
        return Directory.GetFiles(workDir, "audio.*").FirstOrDefault();
    }

    /// <summary>
    /// Renders slides + optional soundtrack into an H.264 mp4. Every slide is scaled into a shared
    /// canvas (letterboxed, never cropped) so mixed-size slides concat cleanly. Returns the video
    /// length in seconds, or null on failure.
    /// </summary>
    private async Task<double?> RenderSlideshowAsync(List<string> slides, string? audioPath, double audioSeconds, string outputPath)
    {
        var secondsPerSlide = audioPath != null && audioSeconds > 0
            ? Math.Clamp(audioSeconds / slides.Count, MinSecondsPerSlide, MaxSecondsPerSlide)
            : MinSecondsPerSlide;
        var total = secondsPerSlide * slides.Count;

        var canvasHeight = MinCanvasHeight;
        if (await ProbeVideoDimensionsAsync(slides[0]) is var (fw, fh))
            canvasHeight = Math.Clamp((int)Math.Round(fh * (double)CanvasWidth / fw / 2) * 2, MinCanvasHeight, MaxCanvasHeight);

        var inputs = new System.Text.StringBuilder();
        var filters = new System.Text.StringBuilder();
        var perSlide = secondsPerSlide.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        for (var i = 0; i < slides.Count; i++)
        {
            inputs.Append($"-loop 1 -framerate 24 -t {perSlide} -i \"{slides[i]}\" ");
            filters.Append($"[{i}:v]scale={CanvasWidth}:{canvasHeight}:force_original_aspect_ratio=decrease,")
                   .Append($"pad={CanvasWidth}:{canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v{i}];");
        }
        for (var i = 0; i < slides.Count; i++) filters.Append($"[v{i}]");
        filters.Append($"concat=n={slides.Count}:v=1:a=0[v]");

        // The soundtrack loops for the whole slideshow; -t on the output is the clean cut-off
        // (-shortest and an endlessly looped input do not always agree on where to stop).
        var audioInput = audioPath != null ? $"-stream_loop -1 -i \"{audioPath}\" " : "";
        var audioMap = audioPath != null ? $"-map {slides.Count}:a -c:a aac " : "";
        var totalArg = total.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);

        var exitCode = await RunProcessAsync("ffmpeg",
            $"{inputs}{audioInput}-filter_complex \"{filters}\" -map \"[v]\" {audioMap}" +
            $"-c:v libx264 -crf 23 -preset fast -r 24 -t {totalArg} -movflags +faststart -y \"{outputPath}\"",
            DownloadTimeoutMs);

        return exitCode == 0 && File.Exists(outputPath) ? total : null;
    }
}
