using System.Text.Json;

namespace Yap.Services.Gifs;

/// <summary>
/// Klipy GIF API v1 implementation of IGifSourceProvider.
/// Docs: https://docs.klipy.com/gifs-api
///
/// Klipy positions itself as a Tenor drop-in replacement after Tenor stopped accepting new
/// API clients in Jan 2026. The API surface mirrors Tenor's at the concept level but uses:
///   - API key in URL path (/api/v1/{key}/gifs/...) instead of ?key= query string
///   - rating=g|pg|pg-13|r instead of contentfilter=off|low|medium|high
///   - page=N (integer) instead of pos=opaque-cursor
///   - response wrapped in {"result":true,"data":{"data":[...],"has_next":...}}
/// Per-item media still uses Tenor-style format keys: mp4, webm, gif, tinymp4, tinygif.
/// </summary>
public class KlipyGifProvider : IGifSourceProvider
{
    private const string BaseUrl = "https://api.klipy.com/api/v1/";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly GifAdminSettingsService _adminSettings;
    private readonly ILogger<KlipyGifProvider> _logger;
    private readonly string _apiKey;
    private readonly string _customerId;
    private readonly string _locale;

    public string ProviderId => "klipy";
    public string DisplayName => "Klipy";
    public string AttributionImageUrl => "/images/klipy-attribution.svg";
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_apiKey);

    public KlipyGifProvider(IHttpClientFactory httpClientFactory, GifAdminSettingsService adminSettings,
        IConfiguration config, ILogger<KlipyGifProvider> logger)
    {
        _httpClientFactory = httpClientFactory;
        _adminSettings = adminSettings;
        _logger = logger;
        _apiKey = config.GetValue<string>("ChatSettings:GifSettings:Klipy:ApiKey") ?? "";
        _customerId = config.GetValue<string>("ChatSettings:GifSettings:Klipy:CustomerId") ?? "yap";
        _locale = config.GetValue<string>("ChatSettings:GifSettings:Klipy:Locale") ?? "en_US";
    }

    public Task<GifSearchResult> SearchAsync(string query, string? cursor, int limit, CancellationToken ct)
    {
        if (!IsConfigured) return Task.FromResult(new GifSearchResult(new(), null));

        var url = $"{BaseUrl}{_apiKey}/gifs/search?customer_id={Uri.EscapeDataString(_customerId)}" +
                  $"&q={Uri.EscapeDataString(query)}" +
                  CommonPaginationParams(cursor, limit);
        return FetchSearchAsync(url, cursor, ct);
    }

    public Task<GifSearchResult> GetTrendingAsync(string? cursor, int limit, CancellationToken ct)
    {
        if (!IsConfigured) return Task.FromResult(new GifSearchResult(new(), null));

        var url = $"{BaseUrl}{_apiKey}/gifs/trending?customer_id={Uri.EscapeDataString(_customerId)}" +
                  CommonPaginationParams(cursor, limit);
        return FetchSearchAsync(url, cursor, ct);
    }
    public async Task RegisterShareAsync(string sourceId, string? query, CancellationToken ct)
    {
        if (!IsConfigured || string.IsNullOrEmpty(sourceId)) return;
        var url = $"{BaseUrl}{_apiKey}/gifs/share/{Uri.EscapeDataString(sourceId)}" +
                  $"?customer_id={Uri.EscapeDataString(_customerId)}" +
                  (string.IsNullOrEmpty(query) ? "" : $"&q={Uri.EscapeDataString(query)}");
        try
        {
            var client = _httpClientFactory.CreateClient("Klipy");
            using var response = await client.GetAsync(url, ct);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Klipy share-trigger failed for {SourceId} (non-critical)", sourceId);
        }
    }

    public async Task<List<string>> GetItemTagsAsync(string sourceId, CancellationToken ct)
    {
        if (!IsConfigured || string.IsNullOrEmpty(sourceId)) return new();

        // Documented item lookup (GIF - Items API): GET /gifs/items?slugs={slug} — takes a
        // comma-separated slug list and returns { result, data: { data: [ {id, slug, title,
        // file, tags[], type, ...} ] } }. Note: tags[] is often empty; Klipy's catalog is
        // sparsely tagged, so title is frequently all we get.
        var url = $"{BaseUrl}{_apiKey}/gifs/items?slugs={Uri.EscapeDataString(sourceId)}" +
                  $"&customer_id={Uri.EscapeDataString(_customerId)}&locale={_locale}";
        try
        {
            var client = _httpClientFactory.CreateClient("Klipy");
            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                // Warning, not Debug: this endpoint fires rarely (once per favorite), and a 4xx
                // here (bad key, rate limit, removed item) should be visible in the console.
                _logger.LogWarning("Klipy item lookup HTTP {Status} for {SourceId}", response.StatusCode, sourceId);
                return new();
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

            // Documented shape: data.data is an array (batch endpoint; we ask for one slug).
            // Tolerate object-shaped variants too — Klipy wraps responses inconsistently.
            var item = doc.RootElement;
            if (item.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
            {
                item = data;
                if (item.TryGetProperty("data", out var inner))
                {
                    if (inner.ValueKind == JsonValueKind.Array)
                    {
                        if (inner.GetArrayLength() == 0)
                        {
                            _logger.LogInformation("Klipy items lookup: no item returned for {SourceId} (removed or unknown slug)", sourceId);
                            return new();
                        }
                        item = inner[0];
                    }
                    else if (inner.ValueKind == JsonValueKind.Object)
                    {
                        item = inner;
                    }
                }
            }
            if (item.ValueKind != JsonValueKind.Object) return new();

            var keywords = ParseTagsElement(item);
            var tagCount = keywords.Count;

            // Title / description come along as phrase keywords — tokenized local search matches
            // individual words inside them, so one sentence-tag covers many future queries.
            var title = TryGetString(item, "title", "content_description");
            if (!string.IsNullOrWhiteSpace(title)) keywords.Add(title!);

            // Breakdown visibility: makes it obvious in the console whether Klipy's tags are
            // being used or enrichment is effectively title-only. When tags don't parse, the
            // raw value is dumped so the parser can be adapted to the real shape.
            if (tagCount > 0)
                _logger.LogInformation("Klipy item {SourceId}: {TagCount} tags [{Tags}] + title=\"{Title}\"",
                    sourceId, tagCount, string.Join(", ", keywords.Take(tagCount)), title ?? "-");
            else
                _logger.LogInformation("Klipy item {SourceId}: no usable tags (raw tags value: {Raw}), title=\"{Title}\"",
                    sourceId,
                    item.TryGetProperty("tags", out var rawTags) ? Truncate(rawTags.GetRawText(), 300) : "(absent)",
                    title ?? "-");

            return keywords;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Klipy item lookup failed for {SourceId} (non-critical)", sourceId);
            return new();
        }
    }

    private string CommonPaginationParams(string? cursor, int limit)
    {
        // Klipy uses 1-based integer page; we store it as a string in our cursor field.
        var page = 1;
        if (!string.IsNullOrEmpty(cursor) && int.TryParse(cursor, out var parsed) && parsed > 0)
            page = parsed;
        var perPage = Math.Clamp(limit, 8, 50);
        return $"&page={page}&per_page={perPage}&rating={RatingParam()}&locale={_locale}";
    }

    private async Task<GifSearchResult> FetchSearchAsync(string url, string? cursor, CancellationToken ct)
    {
        _logger.LogInformation("Klipy GET {Url}", RedactKey(url));
        try
        {
            var client = _httpClientFactory.CreateClient("Klipy");
            using var response = await client.GetAsync(url, ct);
            var bodyText = await response.Content.ReadAsStringAsync(ct);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Klipy HTTP {Status} for {Url} — body: {Body}",
                    response.StatusCode, RedactKey(url), Truncate(bodyText, 500));
                return new GifSearchResult(new(), null);
            }

            _logger.LogInformation("Klipy HTTP {Status} for {Url} ({Bytes} bytes)",
                response.StatusCode, RedactKey(url), bodyText.Length);

            using var doc = JsonDocument.Parse(bodyText);

            // Standard Klipy envelope: { "result": true, "data": { "data": [...], "current_page": N, "has_next": bool } }
            if (!doc.RootElement.TryGetProperty("data", out var outer) || outer.ValueKind != JsonValueKind.Object)
            {
                _logger.LogWarning("Klipy response has no 'data' object. Root kind: {Kind}, body: {Body}",
                    doc.RootElement.ValueKind, Truncate(bodyText, 800));
                return new GifSearchResult(new(), null);
            }
            if (!outer.TryGetProperty("data", out var items) || items.ValueKind != JsonValueKind.Array)
            {
                _logger.LogWarning("Klipy response 'data.data' is not an array. Outer keys: [{Keys}], body: {Body}",
                    string.Join(",", outer.EnumerateObject().Select(p => p.Name)), Truncate(bodyText, 800));
                return new GifSearchResult(new(), null);
            }

            var totalItems = items.GetArrayLength();
            var list = new List<GifSearchItem>();
            var skippedAds = 0;
            var rejectedNoMedia = 0;
            foreach (var r in items.EnumerateArray())
            {
                if (r.TryGetProperty("type", out var typ) && typ.ValueKind == JsonValueKind.String
                    && typ.GetString() == "ad")
                {
                    skippedAds++;
                    continue;
                }

                // Isolate per-item parse failures: one malformed item must not discard the whole
                // page (the outer catch returns an empty result).
                try
                {
                    var item = ParseResultItem(r);
                    if (item != null) list.Add(item);
                    else rejectedNoMedia++;
                }
                catch (Exception ex)
                {
                    rejectedNoMedia++;
                    _logger.LogWarning(ex, "Klipy: skipping unparseable item");
                }
            }

            if (list.Count == 0 && totalItems > 0)
            {
                // Got items back but couldn't parse any — log the FIRST item so we can see the actual shape.
                var firstItem = items[0];
                _logger.LogWarning("Klipy returned {Total} items but parsed 0 (ads skipped={Ads}, rejected={Rej}). " +
                    "First item keys: [{Keys}]. First item sample: {Sample}",
                    totalItems, skippedAds, rejectedNoMedia,
                    string.Join(",", firstItem.EnumerateObject().Select(p => p.Name)),
                    Truncate(firstItem.GetRawText(), 1500));
            }
            else
            {
                _logger.LogInformation("Klipy parsed {Parsed}/{Total} items (ads={Ads}, rejected={Rej})",
                    list.Count, totalItems, skippedAds, rejectedNoMedia);
            }

            string? nextCursor = null;
            if (outer.TryGetProperty("has_next", out var hasNext) && hasNext.ValueKind == JsonValueKind.True)
            {
                var currentPage = 1;
                if (outer.TryGetProperty("current_page", out var cp) && cp.ValueKind == JsonValueKind.Number)
                    currentPage = cp.GetInt32();
                else if (int.TryParse(cursor, out var fromCursor))
                    currentPage = fromCursor;
                nextCursor = (currentPage + 1).ToString();
            }

            return new GifSearchResult(list, nextCursor);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Klipy request error for {Url}", RedactKey(url));
            return new GifSearchResult(new(), null);
        }
    }

    private static string Truncate(string s, int max)
        => s.Length <= max ? s : s[..max] + "…";

    private GifSearchItem? ParseResultItem(JsonElement r)
    {
        // Klipy's id can be numeric or string; the slug (also string) is the share-friendly identifier.
        // Prefer slug if present (the share / items endpoints take it), fall back to id.
        var slug = TryGetString(r, "slug");
        var idStr = slug ?? TryGetStringOrNumeric(r, "id");
        if (string.IsNullOrEmpty(idStr)) return null;

        var title = TryGetString(r, "title", "content_description") ?? "";
        var full = new List<MediaFormat>();
        var preview = new List<MediaFormat>();
        int width = 0, height = 0;

        // Current Klipy shape: file.{hd|md|sm}.{gif|webp|jpg|mp4|webm}.{url,width,height,size}.
        // We prefer the "md" tier for full formats: gif is ~3× smaller than hd (5MB vs 17MB on
        // the cat example), while mp4/webm are byte-identical between tiers (Klipy doesn't
        // downsize video). Fall back to "hd" if "md" isn't present for some items.
        // Previews come from "sm" tier (smallest), falling back to "md".
        if (r.TryGetProperty("file", out var file) && file.ValueKind == JsonValueKind.Object)
        {
            full.AddRange(PlayableFormats(file, "md", "hd"));
            preview.AddRange(PlayableFormats(file, "sm", "md"));
            foreach (var mf in full)
                if (width == 0 || height == 0) { width = mf.Width; height = mf.Height; }
        }
        // Legacy Tenor-style fallback: media.{mp4|webm|gif|tinymp4|tinygif|...}.
        else if (r.TryGetProperty("media", out var media) && media.ValueKind == JsonValueKind.Object)
        {
            foreach (var fmt in media.EnumerateObject())
            {
                var mf = ParseMediaFormat(fmt.Value, fmt.Name);
                if (mf == null) continue;
                if (IsFullSizeFormatKey(fmt.Name))
                {
                    full.Add(mf);
                    if (width == 0 || height == 0) { width = mf.Width; height = mf.Height; }
                }
                else if (IsPreviewFormatKey(fmt.Name))
                {
                    preview.Add(mf);
                }
            }
        }

        if (full.Count == 0 && preview.Count == 0)
        {
            var topKeys = string.Join(",", r.EnumerateObject().Select(p => p.Name));
            _logger.LogWarning("Klipy item {Id} produced no formats. Top keys: [{TopKeys}]", idStr, topKeys);
            return null;
        }
        return new GifSearchItem(idStr, title, width, height, full, preview, ParseTagsElement(r));
    }

    /// <summary>
    /// Klipy's per-item "tags" field shape isn't stable across docs and endpoints, so accept
    /// anything plausible: an array of strings, an array of objects (name/text/tag), or a single
    /// comma-separated string. Returns empty when absent or unrecognized.
    /// </summary>
    private static List<string> ParseTagsElement(JsonElement item)
    {
        var result = new List<string>();
        if (!item.TryGetProperty("tags", out var tags)) return result;

        switch (tags.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var t in tags.EnumerateArray())
                {
                    var s = t.ValueKind switch
                    {
                        JsonValueKind.String => t.GetString(),
                        JsonValueKind.Object => TryGetString(t, "name", "text", "tag"),
                        _ => null
                    };
                    if (!string.IsNullOrWhiteSpace(s)) result.Add(s!);
                }
                break;

            case JsonValueKind.String:
                result.AddRange(tags.GetString()!
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                break;
        }
        return result;
    }

    /// <summary>The playable formats of one size tier of an item's "file" object, in the order of the JSON: the
    /// preferred tier, or the fallback tier when the item has no preferred one.</summary>
    private static List<MediaFormat> PlayableFormats(JsonElement file, string preferredTier, string fallbackTier)
    {
        var formats = new List<MediaFormat>();
        if (!(file.TryGetProperty(preferredTier, out var tier) && tier.ValueKind == JsonValueKind.Object)
            && !(file.TryGetProperty(fallbackTier, out tier) && tier.ValueKind == JsonValueKind.Object))
            return formats;

        foreach (var fmt in tier.EnumerateObject())
            if (IsPlayableFormatKey(fmt.Name) && ParseMediaFormat(fmt.Value, fmt.Name) is { } mf)
                formats.Add(mf);
        return formats;
    }

    /// <summary>
    /// Formats our renderer can use. WebP is the new preferred format — animated WebP plays in
    /// an &lt;img&gt; tag (instant animation, no browser autoplay policy) and is ~2× smaller than
    /// the equivalent GIF. Klipy's jpg is rejected (static-only).
    /// </summary>
    private static bool IsPlayableFormatKey(string formatKey) =>
        formatKey.Equals("mp4", StringComparison.OrdinalIgnoreCase)
        || formatKey.Equals("webm", StringComparison.OrdinalIgnoreCase)
        || formatKey.Equals("gif", StringComparison.OrdinalIgnoreCase)
        || formatKey.Equals("webp", StringComparison.OrdinalIgnoreCase);

    private static MediaFormat? ParseMediaFormat(JsonElement el, string formatName)
    {
        if (el.ValueKind != JsonValueKind.Object) return null;

        var url = TryGetString(el, "url", "src");
        if (string.IsNullOrEmpty(url)) return null;

        // Klipy returns dims either as { "width", "height" } or as a [w, h] array under "dims" (Tenor style).
        int w = 0, h = 0;
        if (el.TryGetProperty("width", out var wEl) && wEl.ValueKind == JsonValueKind.Number) w = wEl.GetInt32();
        if (el.TryGetProperty("height", out var hEl) && hEl.ValueKind == JsonValueKind.Number) h = hEl.GetInt32();
        if ((w == 0 || h == 0) && el.TryGetProperty("dims", out var dims) && dims.ValueKind == JsonValueKind.Array && dims.GetArrayLength() >= 2)
        {
            // Guard each element's kind like the width/height reads above. GetInt32() on a string
            // or fractional number throws, and an unguarded throw here aborts the entire page parse.
            if (dims[0].ValueKind == JsonValueKind.Number) w = (int)dims[0].GetDouble();
            if (dims[1].ValueKind == JsonValueKind.Number) h = (int)dims[1].GetDouble();
        }

        long size = 0;
        if (el.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number) size = s.GetInt64();
        else if (el.TryGetProperty("file_size", out var fs) && fs.ValueKind == JsonValueKind.Number) size = fs.GetInt64();

        return new MediaFormat(url!, ContentTypeFor(formatName), w, h, size);
    }

    private static readonly HashSet<string> FullFormatKeys = new(StringComparer.OrdinalIgnoreCase)
        { "mp4", "loopedmp4", "looped_mp4", "webm", "gif", "mediumgif", "medium_gif", "hd" };

    private static readonly HashSet<string> PreviewFormatKeys = new(StringComparer.OrdinalIgnoreCase)
        { "tinymp4", "tiny_mp4", "nanomp4", "nano_mp4", "tinywebm", "tiny_webm", "nanowebm", "nano_webm",
          "tinygif", "tiny_gif", "nanogif", "nano_gif", "sm", "preview" };

    private static bool IsFullSizeFormatKey(string key) => FullFormatKeys.Contains(key);
    private static bool IsPreviewFormatKey(string key) => PreviewFormatKeys.Contains(key);

    private static string ContentTypeFor(string formatName)
    {
        var k = formatName.ToLowerInvariant();
        if (k.Contains("mp4")) return "video/mp4";
        if (k.Contains("webm")) return "video/webm";
        if (k.Contains("gif")) return "image/gif";
        if (k.Contains("webp")) return "image/webp";
        return "application/octet-stream";
    }

    private string RatingParam() => _adminSettings.KlipyRating switch
    {
        KlipyRating.G => "g",
        KlipyRating.PG => "pg",
        KlipyRating.PG13 => "pg-13",
        KlipyRating.R => "r",
        _ => "pg"
    };

    private string RedactKey(string url) =>
        string.IsNullOrEmpty(_apiKey) ? url : url.Replace(_apiKey, "***");

    private static string? TryGetString(JsonElement el, params string[] keys)
    {
        foreach (var k in keys)
        {
            if (el.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrEmpty(s)) return s;
            }
        }
        return null;
    }

    private static string? TryGetStringOrNumeric(JsonElement el, string key)
    {
        if (!el.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            _ => null
        };
    }
}
