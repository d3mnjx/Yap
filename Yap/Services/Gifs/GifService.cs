using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Yap.Models;
using Yap.Models.Chat;
using Yap.Models.Gifs;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Persistence;

using Yap.Services.Media;

namespace Yap.Services.Gifs;

/// <summary>
/// Singleton orchestrator for the GIF feature: local cache index, provider delegation,
/// download + normalization pipeline, favorites, and reference counting.
///
/// Mirrors the LinkPreviewService / MediaCacheService patterns: ConcurrentDictionary
/// in-memory state, fire-and-forget background work with in-flight dedup,
/// callback events for UI to refresh when async work completes.
/// </summary>
public partial class GifService
{
    private readonly IDbContextFactory<ChatDbContext>? _dbFactory;   // startup load only
    private readonly PersistenceWriter _writer;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IWebHostEnvironment _env;
    private readonly UploadPaths _uploads;
    private readonly IGifSourceProvider _provider;
    private readonly GifFfmpegHelper _ffmpeg;
    private readonly UserService _userService;
    private readonly ILogger<GifService> _logger;

    // In-memory index of all entries, populated on startup.
    private readonly ConcurrentDictionary<Guid, GifEntry> _entries = new();

    // (providerId, sourceId) → entry id, for fast dedup of provider results.
    private readonly ConcurrentDictionary<(string Provider, string SourceId), Guid> _byProviderSourceId = new();

    // tag → set of entry ids. Tags are lowercased + trimmed. Lookups during local-first search.
    private readonly Dictionary<string, HashSet<Guid>> _tagIndex = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _tagIndexLock = new();

    // Dedup background download/transcode tasks per provider sourceId.
    private readonly ConcurrentDictionary<string, byte> _inFlightDownloads = new();

    // Per-user favorites: gifId → folder (null = unsorted). Memory is the source of truth; every
    // change enqueues a write. Folder lives on the relationship so the same GIF can sit in
    // different folders for different users.
    private readonly ConcurrentDictionary<Guid, Dictionary<Guid, string?>> _favoritesByUser = new();

    // content sha256 hex → entry id, for import dedup (custom uploads only).
    private readonly ConcurrentDictionary<string, Guid> _byContentHash = new();

    // The provider items this server showed in a picker lately, by source id. A send names an item; the server uses
    // its own copy, never the client's URLs: with those, a person could make the server fetch any address and then
    // serve it to everyone as a GIF. An hour and a few thousand items cover a pick; after that the person searches again.
    private readonly ConcurrentDictionary<string, (GifSearchItem Item, DateTime At)> _shownItems = new();

    private const int MaxRecentGifs = 30;
    private const int LocalSearchLimit = 24;
    private const int PartialMatchLimit = 2; // tolerated (all-but-one-word) search hits — one grid row, enough to keep teach-on-click alive without burying provider results
    private const long MaxDownloadBytes = 64L * 1024 * 1024; // 64MB safety ceiling per file
    private const int DownloadTimeoutMs = 30_000;
    private const long PreviewMinSourceBytes = 300 * 1024; // below this, the full file is effectively its own preview

    /// <summary>Raised when a user's favorites change. UI filters by their own userId.</summary>
    public event Action<Guid>? OnFavoritesChanged;

    public IGifSourceProvider Provider => _provider;
    public bool IsConfigured => _provider.IsConfigured;

    public GifService(IServiceProvider serviceProvider,
        PersistenceWriter writer,
        IHttpClientFactory httpClientFactory,
        IWebHostEnvironment env,
        UploadPaths uploads,
        IGifSourceProvider provider,
        GifFfmpegHelper ffmpeg,
        UserService userService,
        ILogger<GifService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _env = env;
        _uploads = uploads;
        _provider = provider;
        _ffmpeg = ffmpeg;
        _userService = userService;
        _logger = logger;
        _writer = writer;
        _dbFactory = serviceProvider.GetService<IDbContextFactory<ChatDbContext>>();

        // BYOG quota: generous cap on a user's own custom-upload bytes (imports + uploads).
        // Admins are exempt; starred provider GIFs are shared cache and never count.
        var config = serviceProvider.GetService<IConfiguration>();
        UserQuotaBytes = (config?.GetValue("ChatSettings:GifSettings:UserQuotaMB", 4096) ?? 4096) * 1024L * 1024;

        EnsureDirectories();
    }

    private string CustomUploadsDir => _uploads.Gifs;
    private string CacheDir => Path.Combine(_env.ContentRootPath, "Data", "gif-cache");

    private void EnsureDirectories()
    {
        Directory.CreateDirectory(CustomUploadsDir);
        Directory.CreateDirectory(CacheDir);
    }

    /// <summary>
    /// Loads all GifEntries + FavoriteGifs from DB into the in-memory index. Call on startup
    /// after persistence is initialized.
    /// </summary>
    public async Task InitializeAsync()
    {
        if (_dbFactory == null) return;

        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync();
            var entries = await db.GifEntries.AsNoTracking().ToListAsync();
            foreach (var entry in entries)
            {
                _entries[entry.Id] = entry;
                if (!string.IsNullOrEmpty(entry.SourceProviderId) && !string.IsNullOrEmpty(entry.SourceId))
                    _byProviderSourceId[(entry.SourceProviderId, entry.SourceId)] = entry.Id;
                if (!string.IsNullOrEmpty(entry.ContentHash))
                    _byContentHash[entry.ContentHash] = entry.Id;
                IndexEntryTags(entry);
            }

            var favorites = await db.FavoriteGifs.AsNoTracking().ToListAsync();
            foreach (var fav in favorites)
            {
                var map = _favoritesByUser.GetOrAdd(fav.UserId, _ => new Dictionary<Guid, string?>());
                lock (map) map[fav.GifEntryId] = fav.Folder;
            }

            _logger.LogInformation("Loaded {EntryCount} GIF entries, {FavCount} favorites", entries.Count, favorites.Count);

            // Backfill: any provider entries that have a remote gif URL but no local gif file
            // get queued for download. Catches entries created before we cached gifs locally,
            // and also re-fetches if files were manually deleted.
            var backfillNeeded = entries.Where(NeedsBackgroundNormalization).ToList();
            if (backfillNeeded.Count > 0)
            {
                _logger.LogInformation("Backfilling local cache for {Count} GIF entries", backfillNeeded.Count);
                foreach (var entry in backfillNeeded)
                    QueueNormalization(entry);
            }

            // Backfill missing dimensions for custom uploads. Animated-WebP uploads taking the
            // copy-as-is path were stored 0×0 because ffprobe can't read their size; ImageSharp
            // can. Without real dimensions the chat can't reserve space and they jump in on load.
            // Header read only (no decode), one-time per affected file, so run it in the background.
            var dimsBackfill = entries
                .Where(e => e.SourceProviderId == null && (e.Width == 0 || e.Height == 0)
                            && !string.IsNullOrEmpty(e.GifUrl))
                .ToList();
            if (dimsBackfill.Count > 0)
            {
                _logger.LogInformation("Backfilling dimensions for {Count} custom GIF uploads", dimsBackfill.Count);
                _ = Task.Run(() => BackfillCustomUploadDimensions(dimsBackfill));
            }

            // Cut picker previews for entries that predate the preview pipeline. Background work
            // through the transcode semaphore (~0.5s/file); a picker shows a preview the next time it opens.
            var previewBackfill = entries
                .Where(e => e.DeletedAt == null && e.PreviewUrl == null)
                .ToList();
            if (previewBackfill.Count > 0 && GifFfmpegHelper.IsAvailable)
            {
                _logger.LogInformation("Backfilling picker previews for up to {Count} GIF entries", previewBackfill.Count);
                _ = Task.Run(() => BackfillPreviewsAsync(previewBackfill));
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load GIF library from database");
        }
    }

    public GifEntry? GetEntry(Guid id) => _entries.TryGetValue(id, out var e) ? e : null;

    /// <summary>Every library entry — custom uploads and provider cache — newest first. For the admin listing.</summary>
    public List<GifEntry> GetAllEntries() =>
        _entries.Values
            .Where(e => e.DeletedAt == null)
            .OrderByDescending(e => e.CreatedAt)
            .ToList();

    /// <summary>How many users favorited each entry (entries with zero favorites are absent). For the admin listing.</summary>
    public Dictionary<Guid, int> GetFavoriteCounts()
    {
        var counts = new Dictionary<Guid, int>();
        foreach (var map in _favoritesByUser.Values)
        {
            Guid[] ids;
            lock (map) ids = map.Keys.ToArray();
            foreach (var id in ids)
                counts[id] = counts.GetValueOrDefault(id) + 1;
        }
        return counts;
    }

    #region Public read API

    /// <summary>
    /// Local-first search across the cached library. The query is split into words, each word
    /// substring-matched against tags (order-independent) — "kiss blow" finds an entry tagged
    /// "blow" + "kisses". All words but one must match: full matches rank first, but one unknown
    /// word doesn't hide an otherwise-good hit — and clicking such a hit appends the full query
    /// as a tag, teaching the entry the word it was missing. Tolerated hits are capped at
    /// <see cref="PartialMatchLimit"/> when a provider is configured, so near-misses can't crowd
    /// out the provider section. When <paramref name="userId"/> is given, that user's favorites
    /// rank above equally-matching entries, followed by server-library GIFs.
    ///
    /// Visibility: custom uploads are private — only their uploader and users who favorited them
    /// see them here. Server-library and provider-cached entries are public. Receiving a GIF in
    /// chat and starring it is how a private upload enters another user's searchable pool.
    /// </summary>
    public List<GifEntry> SearchLocal(string query, Guid? userId = null, int limit = LocalSearchLimit)
    {
        if (string.IsNullOrWhiteSpace(query)) return new();

        var tokens = query.Trim().ToLowerInvariant()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(t => t.Length >= 2)
            .Distinct()
            .ToList();
        if (tokens.Count == 0) return new();

        // Per-entry count of how many query words matched at least one tag.
        var matchCounts = new Dictionary<Guid, int>();

        lock (_tagIndexLock)
        {
            foreach (var token in tokens)
            {
                // Entries with any tag containing this token. Contains() covers exact hits too.
                // A full index sweep per token is cheap — the tag index stays small.
                var tokenHits = new HashSet<Guid>();
                foreach (var (tag, ids) in _tagIndex)
                {
                    if (tag.Contains(token))
                        tokenHits.UnionWith(ids);
                }
                foreach (var id in tokenHits)
                    matchCounts[id] = matchCounts.GetValueOrDefault(id) + 1;
            }
        }

        var requiredMatches = Math.Max(1, tokens.Count - 1);

        var favIds = new HashSet<Guid>();
        if (userId is Guid uid && _favoritesByUser.TryGetValue(uid, out var favMap))
            lock (favMap) favIds.UnionWith(favMap.Keys);

        var ranked = matchCounts
            .Where(kv => kv.Value >= requiredMatches)
            .Select(kv => (Entry: _entries.TryGetValue(kv.Key, out var e) ? e : null, Matches: kv.Value))
            .Where(x => x.Entry is { DeletedAt: null } e
                        && (e.IsServerGif
                            || e.SourceProviderId != null
                            || (userId is Guid u && (e.UploadedByUserId == u || favIds.Contains(e.Id)))))
            .OrderByDescending(x => x.Matches)                    // full matches above tolerated ones
            .ThenByDescending(x => favIds.Contains(x.Entry!.Id))  // then the searcher's own picks
            .ThenByDescending(x => x.Entry!.IsServerGif)          // then the curated server library
            .ThenByDescending(x => x.Entry!.UseCount)
            .ThenByDescending(x => x.Entry!.LastUsedAt)
            .ToList();

        // Full matches are genuinely relevant — show them all. Tolerated hits exist only to keep
        // the teach-on-click loop alive, so one grid row is enough: uncapped, a two-word query
        // degenerates to OR and buries the provider section under one-word near-misses.
        // With no provider configured there's nothing below to bury — skip the cap.
        var partialCap = IsConfigured ? PartialMatchLimit : limit;
        var full = ranked.Where(x => x.Matches == tokens.Count);
        var partial = ranked.Where(x => x.Matches < tokens.Count).Take(partialCap);
        return full.Concat(partial).Take(limit).Select(x => x.Entry!).ToList();
    }

    public async Task<GifSearchResult> SearchProviderAsync(string query, string? cursor, int limit, CancellationToken ct)
    {
        var result = await _provider.SearchAsync(query, cursor, limit, ct);
        RememberShown(result);
        return result;
    }

    public async Task<GifSearchResult> GetTrendingAsync(string? cursor, int limit, CancellationToken ct)
    {
        var result = await _provider.GetTrendingAsync(cursor, limit, ct);
        RememberShown(result);
        return result;
    }

    private void RememberShown(GifSearchResult result)
    {
        var now = DateTime.UtcNow;
        foreach (var item in result.Items) _shownItems[item.SourceId] = (item, now);
        if (_shownItems.Count > 5000)
            foreach (var key in _shownItems.Where(e => now - e.Value.At > TimeSpan.FromHours(1)).Select(e => e.Key).ToList()) _shownItems.TryRemove(key, out _);
    }

    public List<GifEntry> GetFavorites(Guid userId)
    {
        if (!_favoritesByUser.TryGetValue(userId, out var map)) return new();
        Guid[] ids;
        lock (map) ids = map.Keys.ToArray();
        return ids
            .Select(id => _entries.TryGetValue(id, out var e) ? e : null)
            .Where(e => e != null && e.DeletedAt == null)
            .Select(e => e!)
            .OrderByDescending(e => e.LastUsedAt)
            .ToList();
    }

    public bool IsFavorite(Guid userId, Guid gifEntryId)
    {
        if (!_favoritesByUser.TryGetValue(userId, out var map)) return false;
        lock (map) return map.ContainsKey(gifEntryId);
    }

    public List<GifEntry> GetRecents(string username)
    {
        var ids = _userService.GetRecentGifs(username);
        return ids
            .Select(id => _entries.TryGetValue(id, out var e) ? e : null)
            .Where(e => e != null && e.DeletedAt == null)
            .Select(e => e!)
            .ToList();
    }

    #endregion

    #region Send flows

    /// <summary>
    /// Called when the user clicks a provider result in the picker. The client's item only names the GIF: the
    /// server's own copy from a recent search (_shownItems) supplies the URLs, the title and the tags. Creates a
    /// GifEntry from it, or hits the existing entry for that sourceId, updates usage, queues the background
    /// download, and returns a GifAttachment ready to embed in a ChatMessage. No round-trip to the provider.
    /// </summary>
    public GifAttachment? SendProviderGif(GifSearchItem item, string? query, Guid userId, string username)
    {
        if (string.IsNullOrEmpty(item.SourceId)) return null;
        // An id this server never showed and never cached is refused (PK-20 wording on the client). The client's
        // own title and tags are never harvested: tags are shared search words (SetTags).
        var shown = _shownItems.TryGetValue(item.SourceId, out var recent) ? recent.Item : null;
        var existing = _byProviderSourceId.TryGetValue((_provider.ProviderId, item.SourceId), out var existingId) ? _entries.GetValueOrDefault(existingId) : null;
        if (shown is null && existing is null) return null;
        item = shown ?? item;

        GifEntry entry;
        if (existing is not null)
        {
            entry = existing;
            TouchUsage(entry, query);
            // A fresh search item carries the provider's title + tags — harvest them even on cache hits, so
            // entries cached before harvesting existed pick them up on the next send.
            if (shown is not null)
            {
                AppendTag(entry, shown.Title);
                foreach (var tag in shown.Tags.Take(12)) AppendTag(entry, tag);
            }
            _logger.LogInformation("SendProviderGif hit cached entry {EntryId} for sourceId={SourceId}", entry.Id, item.SourceId);
        }
        else
        {
            entry = CreateEntryFromProviderItem(item, query);
            _logger.LogInformation("SendProviderGif created new entry {EntryId} for sourceId={SourceId} (formats: {FormatCount})",
                entry.Id, item.SourceId, item.Formats.Count);
        }

        // Fire-and-forget provider share notification (TOS requirement for some providers).
        _ = _provider.RegisterShareAsync(item.SourceId, query, CancellationToken.None);

        // Queue background normalization if local files aren't ready yet.
        if (NeedsBackgroundNormalization(entry))
            QueueNormalization(entry);

        AddToRecents(userId, username, entry.Id);

        return new GifAttachment(entry.Id, entry.Width, entry.Height);
    }

    /// <summary>Whether a person may use an entry: star it, send it by id. Public entries (the server library, the
    /// provider's cache) and the person's own uploads always; another person's upload once it was sent in a
    /// conversation or starred by the person, which is the search rule ("custom uploads are private"). A deleted
    /// entry never. The id of an entry is not an entry ticket by itself.</summary>
    public bool CanUse(GifEntry entry, Guid userId) =>
        entry.DeletedAt == null
        && (entry.IsServerGif || entry.SourceProviderId != null || entry.UploadedByUserId == userId
            || entry.ReferenceCount > 0 || IsFavorite(userId, entry.Id));

    /// <summary>The person's own custom upload: the one kind of entry a non-admin may tag or delete. Provider items
    /// and the server library belong to everyone.</summary>
    public bool IsOwnUpload(GifEntry entry, Guid userId) => entry.SourceProviderId == null && entry.UploadedByUserId == userId;

    /// <summary>Called when the user picks an already-cached GIF (Recent, Favorite, or a local search hit).</summary>
    public Task<GifAttachment?> SendCachedGifAsync(Guid gifEntryId, string? query, Guid userId, string username)
    {
        if (!_entries.TryGetValue(gifEntryId, out var entry) || !CanUse(entry, userId))
            return Task.FromResult<GifAttachment?>(null);

        TouchUsage(entry, query);
        AddToRecents(userId, username, gifEntryId);

        return Task.FromResult<GifAttachment?>(new GifAttachment(entry.Id, entry.Width, entry.Height));
    }

    /// <summary>
    /// Try to accept an uploaded file as a custom GIF. If the file qualifies (explicit kind=gif marker,
    /// .gif extension, OR short silent video heuristic), it gets normalized and registered as a
    /// GifEntry, and the source file is consumed (deleted). Returns the new attachment, or null if
    /// the file should remain in the regular image/video pipeline.
    /// </summary>
    /// <param name="sourceExtension">The extension of the name the uploader gave the file. It is a parameter, not
    /// read from <paramref name="sourceFilePath"/>: a tus upload is read where tus stored it, under a name with no
    /// extension, so that a file that is not a GIF never gets a public URL (TusEndpoints). It selects only between
    /// "copy as it is" (.gif, .webp) and "transcode"; the bytes are checked on both ways.</param>
    public async Task<GifAttachment?> TryAcceptAsGifAsync(string sourceFilePath, string sourceExtension, string originalContentType,
        bool isExplicitGif, Guid? uploaderUserId, string? originalFileName = null, CancellationToken ct = default)
    {
        if (!File.Exists(sourceFilePath)) return null;

        var sourceExt = sourceExtension.ToLowerInvariant();
        var isAnimatedImageSource = sourceExt is ".gif" or ".webp";

        // Only video sources require ffmpeg (they must be transcoded to animated WebP).
        // .gif/.webp are copied as-is, so a machine without ffmpeg can still accept them —
        // ImageSharp takes over validation below. Keeps BYOG alive on ffmpeg-less installs.
        if (!GifFfmpegHelper.IsAvailable && !isAnimatedImageSource)
        {
            _logger.LogWarning("ffmpeg unavailable — cannot accept video upload as GIF: {Path}", sourceFilePath);
            return null;
        }

        var probe = GifFfmpegHelper.IsAvailable ? await _ffmpeg.ProbeAsync(sourceFilePath, ct) : null;
        if (probe == null && !isAnimatedImageSource)
        {
            if (isExplicitGif) _logger.LogWarning("ffprobe failed on explicit GIF upload {Path}", sourceFilePath);
            return null;
        }

        // Probe-less gif/webp: ImageSharp must at least recognize the container, otherwise we'd
        // copy arbitrary bytes into the library.
        if (probe == null)
        {
            var (vw, vh) = TryReadImageDimensions(sourceFilePath);
            if (vw <= 0 || vh <= 0)
            {
                if (isExplicitGif) _logger.LogWarning("Unreadable gif/webp upload rejected: {Path}", sourceFilePath);
                return null;
            }
        }

        // Reject obviously-too-long uploads (defends against tar pit and accidental video attaches).
        const double MaxGifDurationSec = 30.0;
        if (probe != null && probe.DurationSeconds > MaxGifDurationSec && !isExplicitGif)
            return null;

        // Auto-classify: short + no audio + has video stream → GIF-like.
        // Explicit kind=gif marker bypasses classification (audio gets stripped on transcode).
        var qualifies = isExplicitGif
            || (probe is { HasAudio: false, VideoCodec: not null }
                && probe.DurationSeconds <= MaxGifDurationSec && probe.DurationSeconds > 0);
        if (!qualifies) return null;

        // Produce an animated WebP for any upload. WebP in <img> = instant animation on page load
        // (no autoplay policy block), and ~2× smaller than the equivalent GIF. .gif and animated
        // .webp sources are copied as-is (already img-tag-friendly, looping, and optimized — and
        // ffmpeg can't reliably re-encode animated webp anyway); everything else (mp4, mov, webm)
        // goes through ffmpeg's libwebp encoder.
        var entryId = Guid.NewGuid();
        string localExt;
        string localPath;
        bool produced;
        string? contentHash = null;

        if (sourceExt is ".gif" or ".webp")
        {
            // Copy-as-is path (the format every exported pack contains): hash the source before
            // copying — identical bytes mean re-imports of an exported pack, or the same file
            // picked twice, converge on the existing entry instead of duplicating it on disk.
            contentHash = TryHashFile(sourceFilePath);
            if (contentHash != null && FindDuplicateByHash(contentHash, uploaderUserId) is { } dup)
            {
                TryDelete(sourceFilePath); // consumed, same contract as a successful accept
                return new GifAttachment(dup.Id, dup.Width, dup.Height);
            }

            localExt = sourceExt;
            localPath = Path.Combine(CustomUploadsDir, $"{entryId}{localExt}");
            try
            {
                File.Copy(sourceFilePath, localPath, overwrite: true);
                produced = true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to copy uploaded {Ext} to {Path}", sourceExt, localPath);
                produced = false;
            }
        }
        else
        {
            localExt = ".webp";
            localPath = Path.Combine(CustomUploadsDir, $"{entryId}.webp");
            produced = await _ffmpeg.TranscodeToAnimatedWebpAsync(sourceFilePath, localPath, ct);
            if (!produced)
                _logger.LogWarning("Failed to transcode upload to animated WebP: {Path}", sourceFilePath);
        }

        if (!produced) return null;

        // Transcode path: only the produced file has stable bytes to dedup on.
        if (contentHash == null)
        {
            contentHash = TryHashFile(localPath);
            if (contentHash != null && FindDuplicateByHash(contentHash, uploaderUserId) is { } dup)
            {
                TryDelete(localPath);
                TryDelete(sourceFilePath);
                return new GifAttachment(dup.Id, dup.Width, dup.Height);
            }
        }

        // Dimensions: prefer the source probe; fall back to probing the produced output.
        int width = probe?.Width ?? 0, height = probe?.Height ?? 0;
        if (width == 0 || height == 0)
        {
            var outProbe = await _ffmpeg.ProbeAsync(localPath, ct);
            if (outProbe != null) { width = outProbe.Width; height = outProbe.Height; }
        }
        // ffprobe routinely reports 0×0 for animated WebP — exactly the files that take the
        // copy-as-is branch above. ImageSharp reads the dimensions from the container header.
        // Without real dimensions the chat can't reserve layout space and the GIF "pops in"
        // after its (multi-MB) bytes finally arrive.
        if (width == 0 || height == 0)
        {
            var (iw, ih) = TryReadImageDimensions(localPath);
            if (iw > 0 && ih > 0) { width = iw; height = ih; }
        }

        var entry = new GifEntry(sourceProviderId: null, sourceId: null, uploaderUserId)
        {
            Id = entryId,
            GifUrl = $"/uploads/gifs/{entryId}{localExt}",
            Width = width,
            Height = height,
            DurationSeconds = probe?.DurationSeconds ?? 0,
            FileSizeBytes = SafeFileSize(localPath),
            OriginalContentType = originalContentType,
            TranscodeStatus = GifTranscodeStatus.DoneGif,
            CreatedAt = DateTime.UtcNow,
            LastUsedAt = DateTime.UtcNow,
            ContentHash = contentHash,
        };

        // Seed search tags from the uploaded file's name — the only free metadata a lazy upload
        // carries ("facepalm02_00000000.webp" → "facepalm"). Without a seed tag the entry is
        // unreachable by search, and the organic search-term accumulation never gets a chance to
        // kick in. Admins can refine tags later in the GIFs panel.
        foreach (var tag in TagsFromFileName(originalFileName))
            AppendTag(entry, tag);

        // Picker preview: from the original video when there was one (decodes on any ffmpeg; the
        // source is consumed below), else from the copied gif/webp itself — animated WebP decode
        // needs ffmpeg ≥ 9.0, and on older builds this skips cleanly (renderers fall back).
        await TryGeneratePreviewAsync(entry, isAnimatedImageSource ? localPath : sourceFilePath);

        PersistNewEntry(entry);
        IndexEntry(entry);

        // Consume the source file.
        TryDelete(sourceFilePath);

        return new GifAttachment(entry.Id, entry.Width, entry.Height);
    }

    /// <summary>
    /// One-time repair for custom uploads stored with 0×0 dimensions (animated WebP that ffprobe
    /// couldn't measure). Reads the real size from each local file via ImageSharp and persists it.
    /// Updates the in-memory entry so historical messages — which fall back to the entry's
    /// dimensions when their own attachment carries 0×0 — render with reserved space too.
    /// </summary>
    private void BackfillCustomUploadDimensions(List<GifEntry> entries)
    {
        var fixedCount = 0;
        foreach (var entry in entries)
        {
            try
            {
                var path = Path.Combine(CustomUploadsDir, Path.GetFileName(entry.GifUrl!));
                if (!File.Exists(path)) continue;

                var (w, h) = TryReadImageDimensions(path);
                if (w <= 0 || h <= 0) continue;

                entry.Width = w;
                entry.Height = h;
                _writer.Enqueue(Writes.GifEntry(entry));

                fixedCount++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to backfill dimensions for custom GIF {Id}", entry.Id);
            }
        }
        if (fixedCount > 0)
            _logger.LogInformation("Backfilled dimensions for {Count} custom GIF uploads", fixedCount);
    }

    /// <summary>
    /// One-time catch-up for entries created before the preview pipeline existed (and a retry for
    /// ones whose generation failed, e.g. animated-WebP sources on a pre-7.1 ffmpeg).
    /// TryGeneratePreviewAsync adopts files already on disk, so an interrupted run resumes free.
    /// </summary>
    private async Task BackfillPreviewsAsync(List<GifEntry> entries)
    {
        var made = 0;
        foreach (var entry in entries)
        {
            try
            {
                if (ResolveLocalFile(entry) is not { } sourcePath) continue; // remote-only, or files gone
                if (!await TryGeneratePreviewAsync(entry, sourcePath)) continue;

                _writer.Enqueue(Writes.GifEntry(entry));
                made++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Preview backfill failed for GIF {Id}", entry.Id);
            }
        }
        if (made > 0)
            _logger.LogInformation("Generated {Count} GIF picker previews (backfill)", made);
    }

    #endregion

    #region Favorites

    /// <summary>
    /// Idempotent favorite add/remove. Adding an existing favorite is safe to repeat — pack
    /// imports and auto-favorite-on-upload re-run without flipping state the way a toggle would.
    /// A null <paramref name="folder"/> on an existing favorite means "keep its folder" (a re-add
    /// must not unfile it); use <see cref="SetFavoriteFolder"/> to move one to unsorted.
    /// Removal ignores the folder. Returns the resulting state.
    /// </summary>
    public bool SetFavorite(Guid userId, Guid gifEntryId, bool favorite, string? folder = null)
        => SetFavoriteCore(userId, gifEntryId, favorite, folder, explicitFolder: folder != null);

    /// <summary>Files a favorite into a folder — null moves it to unsorted. Adds the favorite if missing.</summary>
    public void SetFavoriteFolder(Guid userId, Guid gifEntryId, string? folder)
        => SetFavoriteCore(userId, gifEntryId, favorite: true, folder, explicitFolder: true);

    private bool SetFavoriteCore(Guid userId, Guid gifEntryId, bool favorite, string? folder, bool explicitFolder)
    {
        if (!_entries.TryGetValue(gifEntryId, out var entry)) return false;
        if (favorite && !CanUse(entry, userId)) return false;   // a star needs a right to the entry; taking one back never does

        folder = SanitizeFolder(folder);
        var map = _favoritesByUser.GetOrAdd(userId, _ => new Dictionary<Guid, string?>());

        // Decide the write under the lock, enqueue it after.
        bool insert = false, delete = false, moveFolder = false;
        lock (map)
        {
            if (favorite && map.TryGetValue(gifEntryId, out var currentFolder))
            {
                var effective = explicitFolder ? folder : currentFolder;
                moveFolder = !string.Equals(currentFolder, effective, StringComparison.Ordinal);
                if (moveFolder) map[gifEntryId] = effective;
                folder = effective;
            }
            else if (favorite)
            {
                map[gifEntryId] = folder;
                insert = true;
            }
            else
            {
                delete = map.Remove(gifEntryId);
            }
        }

        if (insert || moveFolder)
            _writer.Enqueue(Writes.Favorite(userId, gifEntryId, folder));
        else if (delete)
            _writer.Enqueue(Writes.DeleteFavorite(userId, gifEntryId));

        // Favoriting is a strong "I'll want this again" signal — the moment to ask the provider
        // for its keywords so the GIF becomes findable by search, not just via the Favorites tab.
        if (insert)
            QueueProviderTagEnrichment(entry);

        if (insert || delete || moveFolder)
            OnFavoritesChanged?.Invoke(userId);
        return favorite;
    }

    /// <summary>
    /// Fire-and-forget: fetches the provider's descriptive keywords (tags, title) for a cached
    /// provider GIF and merges them into its local tag set. No-op for custom uploads.
    /// </summary>
    private void QueueProviderTagEnrichment(GifEntry entry)
    {
        if (entry.SourceProviderId != _provider.ProviderId || string.IsNullOrEmpty(entry.SourceId)) return;

        var dedupKey = $"tags:{entry.SourceProviderId}:{entry.SourceId}";
        if (!_inFlightDownloads.TryAdd(dedupKey, 0)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                var keywords = await _provider.GetItemTagsAsync(entry.SourceId!, CancellationToken.None);
                if (keywords.Count == 0) return;

                foreach (var keyword in keywords.Take(12))
                    AppendTag(entry, keyword);

                // AppendTag does not enqueue a write (its usage-path caller does), so this one does.
                _writer.Enqueue(Writes.GifEntry(entry));
                _logger.LogInformation("Enriched GIF {EntryId} with {Count} provider keywords: [{Keywords}]",
                    entry.Id, keywords.Count, string.Join(", ", keywords.Take(12)));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Provider tag enrichment failed for {EntryId} (non-critical)", entry.Id);
            }
            finally { _inFlightDownloads.TryRemove(dedupKey, out _); }
        });
    }

    #endregion

    #region Tags

    /// <summary>Tags of an entry for display/editing (admin panel). Empty list when none.</summary>
    public List<string> GetTags(GifEntry entry) => DeserializeTags(entry.Tags);

    /// <summary>
    /// Replaces an entry's full tag set. Updates the in-memory tag index — the only place tags are ever removed
    /// from it. The uploader edits an own upload, the admin edits anything; tags are shared search words, so
    /// nobody else does (ST-23, PK-27).
    /// </summary>
    public bool SetTags(Guid actorUserId, Guid gifEntryId, IEnumerable<string> tags)
    {
        if (!_entries.TryGetValue(gifEntryId, out var entry) || entry.DeletedAt != null) return false;
        if (!_userService.IsAdmin(actorUserId) && !IsOwnUpload(entry, actorUserId)) return false;

        var newTags = tags
            .Select(t => t.Trim().ToLowerInvariant())
            .Where(t => t.Length is >= 2 and <= 64)
            .Distinct()
            .ToList();

        var oldTags = DeserializeTags(entry.Tags);
        entry.Tags = newTags.Count > 0 ? JsonSerializer.Serialize(newTags) : null;

        lock (_tagIndexLock)
        {
            foreach (var tag in oldTags.Except(newTags))
            {
                if (_tagIndex.TryGetValue(tag, out var set))
                {
                    set.Remove(entry.Id);
                    if (set.Count == 0) _tagIndex.Remove(tag);
                }
            }
            foreach (var tag in newTags)
            {
                if (!_tagIndex.TryGetValue(tag, out var set))
                    _tagIndex[tag] = set = new HashSet<Guid>();
                set.Add(entry.Id);
            }
        }

        _writer.Enqueue(Writes.GifEntry(entry));
        return true;
    }

    /// <summary>
    /// Derives seed tags from an uploaded file's name: splits on separators, strips digit runs
    /// off token edges ("facepalm02_00000000" → "facepalm"), drops number-only noise. Multi-word
    /// names also yield the joined phrase so a search like "the office" hits too.
    /// </summary>
    internal static List<string> TagsFromFileName(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return new();

        var baseName = Path.GetFileNameWithoutExtension(fileName);
        var tags = Regex.Split(baseName, @"[^\p{L}\p{Nd}]+")
            .Select(t => Regex.Replace(t, @"^\p{Nd}+|\p{Nd}+$", "").ToLowerInvariant())
            .Where(t => t.Length >= 2)
            .Distinct()
            .Take(6)
            .ToList();

        if (tags.Count > 1)
        {
            var phrase = string.Join(' ', tags);
            if (phrase.Length <= 64) tags.Add(phrase);
        }
        return tags;
    }

    #endregion

    #region Reference count maintenance (called by ChatService)

    public void IncrementReferences(List<GifAttachment>? attachments)
    {
        if (attachments == null || attachments.Count == 0) return;
        foreach (var att in attachments)
        {
            if (_entries.TryGetValue(att.GifEntryId, out var entry))
            {
                lock (entry) { entry.ReferenceCount++; }
                _writer.Enqueue(Writes.GifEntry(entry));
            }
        }
    }

    public void DecrementReferences(List<GifAttachment>? attachments)
    {
        if (attachments == null || attachments.Count == 0) return;
        foreach (var att in attachments)
        {
            if (_entries.TryGetValue(att.GifEntryId, out var entry))
            {
                lock (entry) { if (entry.ReferenceCount > 0) entry.ReferenceCount--; }
                _writer.Enqueue(Writes.GifEntry(entry));
            }
        }
    }

    #endregion

    #region Internals: entry creation, indexing, background work

    private GifEntry CreateEntryFromProviderItem(GifSearchItem item, string? query)
    {
        var entry = new GifEntry(_provider.ProviderId, item.SourceId, uploadedByUserId: null)
        {
            Width = item.Width,
            Height = item.Height,
            CreatedAt = DateTime.UtcNow,
            LastUsedAt = DateTime.UtcNow,
            TranscodeStatus = GifTranscodeStatus.Pending,
        };

        // Consider full-quality formats first, then preview formats, so items that ship only a
        // preview tier still yield a usable source instead of a dead (all-null) entry.
        var formats = item.Formats.Concat(item.PreviewFormats).ToList();

        foreach (var fmt in formats)
        {
            switch (fmt.ContentType)
            {
                case "video/mp4": entry.RemoteMp4Url ??= fmt.Url; break;
                case "video/webm": entry.RemoteWebmUrl ??= fmt.Url; break;
            }
            entry.OriginalContentType ??= fmt.ContentType;
        }

        // For the animated-image slot, prefer WebP (~2× smaller than GIF) and fall back to GIF.
        // Stored in RemoteGifUrl regardless of format — the field is "URL of an animated image",
        // and the <img> tag plays both formats transparently.
        entry.RemoteGifUrl = formats.FirstOrDefault(f => f.ContentType == "image/webp")?.Url
                          ?? formats.FirstOrDefault(f => f.ContentType == "image/gif")?.Url;

        // Ensure dims if provider didn't give them at the top level — pull from any format.
        if (entry.Width == 0 || entry.Height == 0)
        {
            var anyDims = formats.FirstOrDefault(f => f.Width > 0 && f.Height > 0);
            if (anyDims != null) { entry.Width = anyDims.Width; entry.Height = anyDims.Height; }
        }

        AppendTag(entry, query);
        // Klipy's human-written title + tags are free metadata: the title is stored as one phrase
        // tag, which tokenized local search matches word-by-word ("cat dancing" hits "a cat is
        // dancing"); provider tags land as individual keywords.
        AppendTag(entry, item.Title);
        foreach (var tag in item.Tags.Take(12))
            AppendTag(entry, tag);

        PersistNewEntry(entry);
        IndexEntry(entry);
        return entry;
    }

    private void IndexEntry(GifEntry entry)
    {
        _entries[entry.Id] = entry;
        if (!string.IsNullOrEmpty(entry.SourceProviderId) && !string.IsNullOrEmpty(entry.SourceId))
            _byProviderSourceId[(entry.SourceProviderId, entry.SourceId)] = entry.Id;
        if (!string.IsNullOrEmpty(entry.ContentHash))
            _byContentHash[entry.ContentHash] = entry.Id;
        IndexEntryTags(entry);
    }

    /// <summary>
    /// Dedup lookup, deliberately scoped: a hash hit only counts when the existing entry is a
    /// server GIF or belongs to the same uploader. Matching other users' private uploads would
    /// hand out their entry id (and the "via @user" badge) to someone who was never shown it.
    /// </summary>
    private GifEntry? FindDuplicateByHash(string contentHash, Guid? uploaderUserId)
        => _byContentHash.TryGetValue(contentHash, out var id)
           && _entries.TryGetValue(id, out var existing)
           && existing.DeletedAt == null
           && (existing.IsServerGif || (uploaderUserId != null && existing.UploadedByUserId == uploaderUserId))
            ? existing
            : null;

    private void IndexEntryTags(GifEntry entry)
    {
        var tags = DeserializeTags(entry.Tags);
        if (tags.Count == 0) return;
        lock (_tagIndexLock)
        {
            foreach (var tag in tags)
            {
                if (!_tagIndex.TryGetValue(tag, out var set))
                    _tagIndex[tag] = set = new HashSet<Guid>();
                set.Add(entry.Id);
            }
        }
    }

    private static bool NeedsBackgroundNormalization(GifEntry entry)
    {
        if (entry.SourceProviderId == null) return false; // Custom uploads are already normalized.
        if (entry.DeletedAt != null) return false;
        if (!string.IsNullOrEmpty(entry.GifUrl)) return false; // Local animated image already present.
        // We render via <img>; need to produce a local animated image from whatever the provider
        // gave us — a remote webp/gif, or (failing that) a remote mp4/webm we transcode to webp.
        return !string.IsNullOrEmpty(entry.RemoteGifUrl)
            || !string.IsNullOrEmpty(entry.RemoteMp4Url)
            || !string.IsNullOrEmpty(entry.RemoteWebmUrl);
    }

    private void QueueNormalization(GifEntry entry)
    {
        if (entry.SourceProviderId == null || string.IsNullOrEmpty(entry.SourceId)) return;
        var dedupKey = $"{entry.SourceProviderId}:{entry.SourceId}";
        if (!_inFlightDownloads.TryAdd(dedupKey, 0)) return;

        _ = Task.Run(async () =>
        {
            try { await NormalizeProviderEntryAsync(entry); }
            catch (Exception ex) { _logger.LogWarning(ex, "GIF normalization failed for {EntryId}", entry.Id); }
            finally { _inFlightDownloads.TryRemove(dedupKey, out _); }
        });
    }

    private async Task NormalizeProviderEntryAsync(GifEntry entry)
    {
        // Chat renders provider GIFs via <img> — animated WebP/GIF in img tags has no autoplay
        // policy (instant playback on page load), unlike <video> which Chrome's MEI can block until
        // first user gesture. We serve from our own /gif-cache instead of hammering the provider's CDN.
        if (!string.IsNullOrEmpty(entry.RemoteGifUrl))
        {
            // Provider gave us an animated image (webp/gif) — download it as-is. The file extension
            // is taken from the URL so the static-file middleware sets the right Content-Type.
            var ext = GuessExtensionFromUrl(entry.RemoteGifUrl);
            var localPath = Path.Combine(CacheDir, $"{entry.Id}{ext}");
            if (!File.Exists(localPath))
            {
                var ok = await DownloadAsync(entry.RemoteGifUrl, localPath, CancellationToken.None);
                if (!ok) { MarkFailed(entry); return; }
            }
            entry.GifUrl = $"/gif-cache/{entry.Id}{ext}";
            entry.FileSizeBytes = SafeFileSize(localPath);
            await TryGeneratePreviewAsync(entry, localPath);
        }
        else
        {
            // Video-only item (no webp/gif): download the mp4/webm and transcode it to an animated
            // WebP so it still renders in an <img> instead of hot-linking the CDN via <video>.
            // Without ffmpeg we leave GifUrl null and fall back to the remote <video> at render time.
            string videoUrl, srcExt;
            if (!string.IsNullOrEmpty(entry.RemoteMp4Url)) { videoUrl = entry.RemoteMp4Url; srcExt = ".mp4"; }
            else if (!string.IsNullOrEmpty(entry.RemoteWebmUrl)) { videoUrl = entry.RemoteWebmUrl; srcExt = ".webm"; }
            else return;

            if (!GifFfmpegHelper.IsAvailable) return; // No transcoder; render falls back to remote <video>.

            var webpPath = Path.Combine(CacheDir, $"{entry.Id}.webp");
            if (!File.Exists(webpPath))
            {
                // Intermediate video lives in the system temp dir, not the web-served cache.
                var tempVideo = Path.Combine(Path.GetTempPath(), $"gifsrc-{entry.Id}{srcExt}");
                try
                {
                    if (!await DownloadAsync(videoUrl, tempVideo, CancellationToken.None)) { MarkFailed(entry); return; }
                    if (!await _ffmpeg.TranscodeToAnimatedWebpAsync(tempVideo, webpPath, CancellationToken.None)) { MarkFailed(entry); return; }
                    // Cut the picker preview from the source video while it's still on disk —
                    // that decode works on any ffmpeg, unlike re-reading the animated webp.
                    entry.FileSizeBytes = SafeFileSize(webpPath);
                    await TryGeneratePreviewAsync(entry, tempVideo);
                }
                finally { TryDelete(tempVideo); }
            }
            entry.GifUrl = $"/gif-cache/{entry.Id}.webp";
            entry.FileSizeBytes = SafeFileSize(webpPath);
            await TryGeneratePreviewAsync(entry, webpPath); // no-op when made above; covers the file-already-existed path
        }

        entry.TranscodeStatus |= GifTranscodeStatus.DoneGif;
        PersistFormats(entry);
    }

    /// <summary>
    /// Produces the small animated-WebP preview (/gif-cache/{id}.p.webp) that the picker and
    /// management grids render instead of the full-size file. Skipped when the full file is
    /// already light enough to be its own preview, or when ffmpeg can't decode the source
    /// (animated-WebP inputs need ffmpeg ≥ 9.0 — older builds fail the transcode cleanly).
    /// PreviewUrl simply stays null on any skip: every renderer falls back to the full file.
    /// Adopts a preview file already on disk, so restarts and re-imports never re-encode.
    /// </summary>
    private async Task<bool> TryGeneratePreviewAsync(GifEntry entry, string sourcePath)
    {
        if (entry.PreviewUrl != null) return true;
        if (!GifFfmpegHelper.IsAvailable) return false;

        var previewPath = Path.Combine(CacheDir, $"{entry.Id}.p.webp");
        if (!File.Exists(previewPath))
        {
            if (entry.FileSizeBytes > 0 && entry.FileSizeBytes < PreviewMinSourceBytes) return false;
            if (!await _ffmpeg.TranscodeToPreviewWebpAsync(sourcePath, previewPath)) return false;
        }

        entry.PreviewUrl = $"/gif-cache/{entry.Id}.p.webp";
        return true;
    }

    /// <summary>
    /// Pulls the file extension off the URL path (handles query strings / fragments). Falls back
    /// to .webp when nothing looks right.
    /// </summary>
    private static string GuessExtensionFromUrl(string url)
    {
        try
        {
            var path = new Uri(url, UriKind.Absolute).AbsolutePath;
            var ext = Path.GetExtension(path).ToLowerInvariant();
            return ext switch { ".gif" => ".gif", ".webp" => ".webp", _ => ".webp" };
        }
        catch
        {
            return ".webp";
        }
    }

    private async Task<bool> DownloadAsync(string url, string destPath, CancellationToken ct)
    {
        try
        {
            var uri = new Uri(url);
            if (!await NetworkSecurityHelper.IsPublicHostAsync(uri.Host))
            {
                _logger.LogWarning("Refusing to download GIF from non-public host {Host}", uri.Host);
                return false;
            }

            var client = _httpClientFactory.CreateClient("Klipy");
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(DownloadTimeoutMs);

            using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("GIF download HTTP {Status} for {Url}", response.StatusCode, url);
                return false;
            }
            if (response.Content.Headers.ContentLength > MaxDownloadBytes)
            {
                _logger.LogWarning("GIF too large ({Size}B) for {Url}", response.Content.Headers.ContentLength, url);
                return false;
            }

            // Stream to disk with a hard cap so a chunked/headerless response (Content-Length
            // absent) can't blow past MaxDownloadBytes — the header check above only helps when
            // the length is advertised.
            bool overCap = false;
            await using (var fs = File.Create(destPath))
            await using (var src = await response.Content.ReadAsStreamAsync(cts.Token))
            {
                var buffer = new byte[81920];
                long total = 0;
                int read;
                while ((read = await src.ReadAsync(buffer, cts.Token)) > 0)
                {
                    total += read;
                    if (total > MaxDownloadBytes) { overCap = true; break; }
                    await fs.WriteAsync(buffer.AsMemory(0, read), cts.Token);
                }
            }

            if (overCap)
            {
                TryDelete(destPath);
                _logger.LogWarning("GIF exceeded size cap mid-download: {Url}", url);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "GIF download failed: {Url}", url);
            TryDelete(destPath);
            return false;
        }
    }

    private void MarkFailed(GifEntry entry)
    {
        entry.TranscodeStatus |= GifTranscodeStatus.Failed;
        _writer.Enqueue(Writes.GifEntry(entry));
    }

    private void TouchUsage(GifEntry entry, string? query)
    {
        lock (entry)
        {
            entry.UseCount++;
            entry.LastUsedAt = DateTime.UtcNow;
        }
        AppendTag(entry, query);
        _writer.Enqueue(Writes.GifEntry(entry));
    }

    private void AppendTag(GifEntry entry, string? query)
    {
        if (string.IsNullOrWhiteSpace(query)) return;
        var tag = query.Trim().ToLowerInvariant();
        if (tag.Length < 2 || tag.Length > 64) return;

        var tags = DeserializeTags(entry.Tags);
        if (tags.Contains(tag)) return;

        tags.Add(tag);
        entry.Tags = JsonSerializer.Serialize(tags);

        lock (_tagIndexLock)
        {
            if (!_tagIndex.TryGetValue(tag, out var set))
                _tagIndex[tag] = set = new HashSet<Guid>();
            set.Add(entry.Id);
        }
    }

    private static List<string> DeserializeTags(string? json)
    {
        if (string.IsNullOrEmpty(json)) return new();
        try { return JsonSerializer.Deserialize<List<string>>(json) ?? new(); }
        catch { return new(); }
    }

    private void AddToRecents(Guid userId, string username, Guid gifEntryId)
    {
        var recents = _userService.GetRecentGifs(username);
        recents.Remove(gifEntryId);
        recents.Insert(0, gifEntryId);
        if (recents.Count > MaxRecentGifs) recents = recents.Take(MaxRecentGifs).ToList();
        _userService.UpdateRecentGifs(userId, recents);
    }

    #endregion

    #region DB persistence

    private void PersistNewEntry(GifEntry entry) => _writer.Enqueue(Writes.NewGifEntry(entry));

    private void PersistFormats(GifEntry entry) => _writer.Enqueue(Writes.GifEntry(entry));

    #endregion

    /// <summary>
    /// Reads pixel dimensions straight from the image header (no full decode). Reliable for
    /// animated WebP and GIF, where ffprobe frequently returns 0×0. Returns (0,0) on failure.
    /// </summary>
    private (int Width, int Height) TryReadImageDimensions(string filePath)
    {
        try
        {
            var info = SixLabors.ImageSharp.Image.Identify(filePath);
            return (info.Width, info.Height);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "ImageSharp could not read dimensions for {Path}", filePath);
            return (0, 0);
        }
    }

    /// <summary>SHA-256 of a file's bytes as lowercase hex. Null when the file can't be read.</summary>
    private string? TryHashFile(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            return Convert.ToHexStringLower(SHA256.HashData(fs));
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not hash {Path} for dedup", path);
            return null;
        }
    }

    private static long SafeFileSize(string path)
    {
        try { return new FileInfo(path).Length; } catch { return 0; }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}
