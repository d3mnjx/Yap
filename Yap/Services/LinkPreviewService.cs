using System.Buffers;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Yap.Models;

namespace Yap.Services;

public partial class LinkPreviewService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LinkPreviewService> _logger;

    // Successful cards survive refresh expiry and process restarts.
    private readonly ConcurrentDictionary<string, LinkPreview> _cache = new();

    // Dedup in-flight requests
    private readonly Dictionary<string, HashSet<Guid>> _inFlight = new();
    private readonly string _cacheDirectory;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);
    // Hard cap on how much of a page we read while looking for the end of <head>. YouTube's
    // head alone is ~715KB (a 256KB cap silently dropped its og:title/og:image), so the cap
    // must sit well above that; 2MB still bounds a hostile endless stream.
    private const int MaxResponseBytes = 2 * 1024 * 1024;
    private const string HeadEndTag = "</head>";

    /// <summary>
    /// Callback invoked when a preview fetch completes. Parameters: (messageId, url, preview).
    /// </summary>
    public Action<Guid, string, LinkPreview>? OnPreviewFetched { get; set; }

    private readonly OfflineChangeSignal _changes;

    public LinkPreviewService(IHttpClientFactory httpClientFactory, ILogger<LinkPreviewService> logger, IWebHostEnvironment env, OfflineChangeSignal changes)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _changes = changes;
        _cacheDirectory = Path.Combine(env.ContentRootPath, "Data", "link-previews");
    }

    /// <summary>
    /// Extracts URLs from plain text. Handles balanced parentheses (Wikipedia) and strips trailing punctuation.
    /// </summary>
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

    private string CachePath(string url) => Path.Combine(_cacheDirectory,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))) + ".json");

    /// <summary>Returns the last known card, including stale successful results.</summary>
    public LinkPreview? GetCachedPreview(string url)
    {
        if (_cache.TryGetValue(url, out var preview)) return preview;
        try
        {
            var path = CachePath(url);
            if (File.Exists(path))
            {
                preview = JsonSerializer.Deserialize<LinkPreview>(File.ReadAllText(path));
                if (preview?.Url == url && preview.HasContent)
                    return _cache.GetOrAdd(url, preview);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger.LogWarning(ex, "Could not read stored link preview");
        }
        return null;
    }

    public LinkPreview GetOrCreatePreview(string url) => GetCachedPreview(url)
        ?? _cache.GetOrAdd(url, key => new LinkPreview { Url = key, FetchedAt = DateTime.UtcNow });

    /// <summary>Projection may request recovery, but must never synchronously publish an event.</summary>
    public LinkPreview? GetPreview(Guid messageId, string url)
    {
        var preview = GetCachedPreview(url);
        if (preview == null || DateTime.UtcNow - preview.FetchedAt >= CacheTtl)
            QueueFetch(messageId, url);
        return preview;
    }

    public void QueueFetch(Guid messageId, string url)
    {
        var cached = GetCachedPreview(url);
        if (cached != null && DateTime.UtcNow - cached.FetchedAt < CacheTtl) return;
        lock (_inFlight)
        {
            // Another fetch may have completed between the cache read and this lock.
            if (_cache.TryGetValue(url, out var current) && DateTime.UtcNow - current.FetchedAt < CacheTtl) return;
            if (_inFlight.TryGetValue(url, out var waiting))
            {
                waiting.Add(messageId);
                return;
            }
            _inFlight[url] = [messageId];
        }
        _ = Task.Run(async () =>
        {
            LinkPreview preview;
            try { preview = await FetchPreviewAsync(url); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to fetch link preview for {Url}", url);
                preview = new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow };
            }
            // A provider outage must not remove a previously rendered card. Retry after
            // the normal TTL, while keeping the successful copy available on disk too.
            if (!preview.HasContent && cached?.HasContent == true)
                preview = cached;
            preview.FetchedAt = DateTime.UtcNow;
            _cache[url] = preview;
            if (preview.HasContent)
            {
                try
                {
                    Directory.CreateDirectory(_cacheDirectory);
                    var path = CachePath(url);
                    await File.WriteAllTextAsync(path + ".tmp", JsonSerializer.Serialize(preview));
                    File.Move(path + ".tmp", path, true);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _logger.LogWarning(ex, "Could not store link preview");
                }
            }
            Guid[] messages;
            lock (_inFlight)
            {
                messages = _inFlight[url].ToArray();
                _inFlight.Remove(url);
            }
            // Every waiting message needs its own targeted delta, including duplicate URLs
            // in different conversations. Never hold the fetch lock while publishing.
            _changes.Touch(OfflineChangeKind.Media, url: url);
            foreach (var id in messages)
                OnPreviewFetched?.Invoke(id, url, preview);
        });
    }

    private async Task<LinkPreview> FetchPreviewAsync(string url)
    {
        // SSRF prevention: resolve hostname and block private IPs
        var uri = new Uri(url);
        if (!await IsPublicHostAsync(uri.Host))
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

    private static async Task<bool> IsPublicHostAsync(string host)
    {
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(host);
            foreach (var addr in addresses)
            {
                if (IsPrivateAddress(addr))
                    return false;
            }
            return addresses.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return true;

        // Map IPv6-mapped IPv4 to IPv4
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            return bytes[0] switch
            {
                10 => true,                                      // 10.0.0.0/8
                172 => bytes[1] >= 16 && bytes[1] <= 31,        // 172.16.0.0/12
                192 => bytes[1] == 168,                          // 192.168.0.0/16
                169 => bytes[1] == 254,                          // 169.254.0.0/16 (link-local)
                127 => true,                                     // 127.0.0.0/8
                0 => true,                                       // 0.0.0.0/8
                _ => false
            };
        }

        // IPv6 link-local, unique-local
        if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal)
            return true;

        // IPv6 unique local (fc00::/7)
        var ipv6Bytes = address.GetAddressBytes();
        if ((ipv6Bytes[0] & 0xFE) == 0xFC)
            return true;

        return false;
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
