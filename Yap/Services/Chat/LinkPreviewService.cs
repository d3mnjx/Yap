using System.Buffers;
using System.Collections.Concurrent;
using System.Net;
using System.Text.RegularExpressions;
using Yap.Models;
using Yap.Models.Chat;
using Yap.Services.Media;

namespace Yap.Services.Chat;

public partial class LinkPreviewService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LinkPreviewService> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly ImageService _images;

    // Cache: URL -> LinkPreview. Never expires; a copy of each good card is on disk (LinkPreviewService.Store.cs).
    private readonly ConcurrentDictionary<string, LinkPreview> _cache = new();

    // Dedup in-flight requests
    private readonly ConcurrentDictionary<string, byte> _inFlight = new();

    // A good card is a snapshot of the page when the link was first seen, as in most chat apps: it never expires and
    // the page is never read again. Do not bring back an expiry: the row then went out without its card, the client's
    // "unchanged" check (ui/timeline.js) failed against its stored copy, and the row redrew twice, once without the
    // card and once when the refetch landed. A refresh timer would also scrape every viewed link again for a title
    // that rarely changes.
    // A card without content (a failed scrape, a media-only card) is retried after an hour: the site may be back.
    private static readonly TimeSpan RetryAfter = TimeSpan.FromHours(1);
    // Hard cap on how much of a page we read while looking for the end of <head>. YouTube's
    // head alone is ~715KB (a 256KB cap silently dropped its og:title/og:image), so the cap
    // must sit well above that; 2MB still bounds a hostile endless stream.
    private const int MaxResponseBytes = 2 * 1024 * 1024;
    private const string HeadEndTag = "</head>";

    /// <summary>
    /// Callback invoked when a preview fetch completes. Parameters: (messageId, url, preview).
    /// </summary>
    public Action<Guid, string, LinkPreview>? OnPreviewFetched { get; set; }

    public LinkPreviewService(IHttpClientFactory httpClientFactory, ILogger<LinkPreviewService> logger, IWebHostEnvironment env,
        ImageService images)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _env = env;
        _images = images;
        Directory.CreateDirectory(CardDirectory);
        Directory.CreateDirectory(PictureDirectory);
    }

    /// <summary>
    /// Extracts URLs from plain text. Handles balanced parentheses (Wikipedia) and strips trailing punctuation.
    /// </summary>
    /// <summary>At most this many cards per message, in text order (MR-19): the queue and the mapper agree on it.</summary>
    public const int MaxLinksPerMessage = 5;

    public static List<string> ExtractUrls(string text)
    {
        if (string.IsNullOrEmpty(text))
            return [];

        var matches = UrlRegex().Matches(text);
        var urls = new List<string>();

        foreach (Match match in matches)
        {
            var url = match.Value;

            // Strip trailing punctuation that's likely not part of the URL
            url = StripTrailingPunctuation(url);

            // Only allow http/https schemes (or no scheme = assume https)
            if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                urls.Add(url);
            }
            else if (!url.Contains("://"))
            {
                // Bare domain like example.com/path — prepend https
                urls.Add("https://" + url);
            }
            // Skip javascript:, ftp:, etc.
        }

        return urls;
    }

    /// <summary>
    /// The card of a URL, whatever its age (<see cref="NeedsFetch"/> says whether to fetch the page). A restart empties
    /// the memory, so a miss reads the card file; GetOrAdd lets a fetch that stored a card meanwhile win.
    /// </summary>
    public LinkPreview? GetCachedPreview(string url)
    {
        if (_cache.TryGetValue(url, out var preview)) return preview;
        return LoadCard(url) is { } stored ? _cache.GetOrAdd(url, stored) : null;
    }

    /// <summary>Whether to fetch the page: there is no card yet, or a card without content is due for its retry.
    /// A good card is never fetched again.</summary>
    public static bool NeedsFetch(LinkPreview? card) =>
        card is null || (!card.HasContent && DateTime.UtcNow - card.FetchedAt >= RetryAfter);

    /// <summary>
    /// Gets existing preview or creates a minimal one (for media cache to attach to
    /// when OG scrape failed or hasn't completed). Goes through GetCachedPreview, so an empty card never hides
    /// the card on disk.
    /// </summary>
    public LinkPreview GetOrCreatePreview(string url) =>
        GetCachedPreview(url) ?? _cache.GetOrAdd(url, _ => new LinkPreview { Url = url, FetchedAt = DateTime.UtcNow });

    /// <summary>
    /// A cached media file completes the preview of its URL, then the card becomes a player (MR-23). Used when a
    /// download finishes and when a page of history meets a file that is already on disk from before a restart.
    /// </summary>
    public LinkPreview AttachMedia(string url, MediaCacheEntry entry)
    {
        var preview = GetOrCreatePreview(url);
        preview.CachedMediaUrl = entry.LocalUrl;
        preview.CachedPosterUrl = entry.PosterUrl;
        preview.MediaType = entry.MediaType;
        preview.MediaDurationSeconds = entry.DurationSeconds;
        if (entry.Width > 0 && entry.Height > 0)
        {
            preview.MediaWidth = entry.Width;
            preview.MediaHeight = entry.Height;
        }
        // yt-dlp's title and thumbnail fill in when the page scrape got none (YouTube serves bots a consent page).
        if (string.IsNullOrEmpty(preview.Title)) preview.Title = entry.Title;
        if (string.IsNullOrEmpty(preview.ImageUrl)) preview.ImageUrl = entry.Thumbnail;
        if (!string.IsNullOrEmpty(preview.Title) || !string.IsNullOrEmpty(preview.ImageUrl) || !string.IsNullOrEmpty(preview.CachedMediaUrl))
            preview.Failed = false;
        return preview;
    }

    /// <summary>
    /// Fire-and-forget background fetch. Invokes OnPreviewFetched when done.
    /// </summary>
    public void QueueFetch(Guid messageId, string url)
    {
        // Already a card that needs no fetch?
        if (GetCachedPreview(url) is { } cached && !NeedsFetch(cached))
        {
            OnPreviewFetched?.Invoke(messageId, url, cached);
            return;
        }

        // Already in flight?
        if (!_inFlight.TryAdd(url, 0))
            return;

        _ = Task.Run(async () =>
        {
            try
            {
                LinkPreview fresh;
                try
                {
                    fresh = await FetchPreviewAsync(url);
                    // The picture is copied before the card is published, so the first "previews" event already
                    // carries the local URL; a swap later would be a second event and a second redraw.
                    if (fresh.HasContent && fresh.ImageUrl is { } image) fresh.ImageUrl = await LocalPictureAsync(url, image);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to fetch link preview for {Url}", url);
                    fresh = new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow };
                }
                Store(messageId, url, fresh);
            }
            finally
            {
                _inFlight.TryRemove(url, out _);
            }
        });
    }

    private void Store(Guid messageId, string url, LinkPreview fresh)
    {
        _cache[url] = fresh;
        // A failed card stays in memory only, is retried after RetryAfter, and sends no event: the row shows no card
        // for it either way.
        if (!fresh.HasContent) return;
        SaveCard(fresh);
        OnPreviewFetched?.Invoke(messageId, url, fresh);
    }

    private async Task<LinkPreview> FetchPreviewAsync(string url)
    {
        // SSRF prevention: resolve hostname and block private IPs
        var uri = new Uri(url);
        if (!await NetworkSecurityHelper.IsPublicHostAsync(uri.Host))
        {
            _logger.LogDebug("Blocked SSRF attempt to private host: {Host}", uri.Host);
            return new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow };
        }

        var client = _httpClientFactory.CreateClient("LinkPreview");

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("Accept", "text/html");

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

        if (!response.IsSuccessStatusCode)
            return new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow };

        // Only process HTML responses
        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (contentType != null && !contentType.Contains("html", StringComparison.OrdinalIgnoreCase))
            return new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow };

        var stream = await response.Content.ReadAsStreamAsync();
        var html = await ReadHeadAsync(stream);

        return ParseOpenGraph(url, html);
    }

    /// <summary>
    /// Reads the response until the closing head tag (OpenGraph tags live in the head),
    /// end of stream, or the hard cap. Stopping at the head keeps ordinary pages cheap
    /// while still reaching the tags on pages with a very large head.
    /// </summary>
    private static async Task<string> ReadHeadAsync(Stream stream)
    {
        using var collected = new MemoryStream();
        var chunk = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            while (collected.Length < MaxResponseBytes)
            {
                var want = (int)Math.Min(chunk.Length, MaxResponseBytes - collected.Length);
                var read = await stream.ReadAsync(chunk.AsMemory(0, want));
                if (read == 0) break;
                collected.Write(chunk, 0, read);

                // Look for the tag in the new bytes plus a small overlap, so a tag split
                // across two reads is still found. Latin1 maps bytes 1:1, so the ASCII tag
                // is found regardless of surrounding UTF-8 sequences.
                var tailStart = (int)Math.Max(0, collected.Length - read - HeadEndTag.Length);
                var tail = System.Text.Encoding.Latin1.GetString(collected.GetBuffer(), tailStart, (int)collected.Length - tailStart);
                if (tail.Contains(HeadEndTag, StringComparison.OrdinalIgnoreCase))
                    break;
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(chunk);
        }

        return System.Text.Encoding.UTF8.GetString(collected.GetBuffer(), 0, (int)collected.Length);
    }

    private static LinkPreview ParseOpenGraph(string url, string html)
    {
        var preview = new LinkPreview
        {
            Url = url,
            FetchedAt = DateTime.UtcNow
        };

        // Parse og:title
        preview.Title = ExtractMetaContent(html, "og:title");

        // Parse og:description
        preview.Description = ExtractMetaContent(html, "og:description");

        // Parse og:image
        preview.ImageUrl = ExtractMetaContent(html, "og:image");

        // Parse og:site_name
        preview.SiteName = ExtractMetaContent(html, "og:site_name");

        // Fallback: <title> tag if no og:title
        if (string.IsNullOrEmpty(preview.Title))
        {
            var titleMatch = TitleTagRegex().Match(html);
            if (titleMatch.Success)
            {
                var title = WebUtility.HtmlDecode(titleMatch.Groups[1].Value.Trim());
                // TikTok photo posts ship no og: tags and a site-wide placeholder <title>. Taking
                // it would block the real post text that yt-dlp's metadata backfills later.
                if (!string.Equals(title, "TikTok - Make Your Day", StringComparison.OrdinalIgnoreCase))
                    preview.Title = title;
            }
        }

        // Fallback: meta description if no og:description
        if (string.IsNullOrEmpty(preview.Description))
        {
            preview.Description = ExtractMetaContent(html, "description", isOg: false);
        }

        // Truncate description
        if (preview.Description?.Length > 300)
            preview.Description = preview.Description[..300] + "...";

        // Mark as failed if we got nothing useful
        if (!preview.HasContent)
            preview.Failed = true;

        return preview;
    }

    private static string? ExtractMetaContent(string html, string property, bool isOg = true)
    {
        // Match both property="og:X" and name="description" variants
        var attr = isOg ? "property" : "name";
        var q = "[\"']";    // character class matching " or '
        var nq = "[^\"']*"; // character class matching anything except " or '

        // Pattern: <meta ... property="og:X" ... content="value" ...>
        var pattern = $@"<meta[^>]+{attr}\s*=\s*{q}{Regex.Escape(property)}{q}[^>]+content\s*=\s*{q}({nq}){q}";
        var match = Regex.Match(html, pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (match.Success)
            return WebUtility.HtmlDecode(match.Groups[1].Value.Trim());

        // Try reversed attribute order: <meta ... content="value" ... property="og:X" ...>
        var reversePattern = $@"<meta[^>]+content\s*=\s*{q}({nq}){q}[^>]+{attr}\s*=\s*{q}{Regex.Escape(property)}{q}";
        match = Regex.Match(html, reversePattern, RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (match.Success)
            return WebUtility.HtmlDecode(match.Groups[1].Value.Trim());

        return null;
    }

    private static string StripTrailingPunctuation(string url)
    {
        // Handle balanced parentheses (Wikipedia URLs like https://en.wikipedia.org/wiki/Foo_(bar))
        var openParens = url.Count(c => c == '(');
        var closeParens = url.Count(c => c == ')');

        // If more closing parens than opening, strip the excess trailing ones
        while (closeParens > openParens && url.EndsWith(')'))
        {
            url = url[..^1];
            closeParens--;
        }

        // Strip trailing punctuation that's not part of URLs
        while (url.Length > 0 && ".,:;!?".Contains(url[^1]))
        {
            url = url[..^1];
        }

        return url;
    }

    // URL regex: matches http(s)://... or www. or domain.tld/path patterns
    [GeneratedRegex(
        @"(?:https?://|www\.)[^\s<>""'\]\)]*[^\s<>""'\]\).,;:!?\-]|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|app|co|me|info|edu|gov)\b(?:/[^\s<>""']*)?",
        RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex UrlRegex();

    [GeneratedRegex(@"<title[^>]*>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TitleTagRegex();
}
