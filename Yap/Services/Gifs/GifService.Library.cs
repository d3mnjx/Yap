using System.IO.Compression;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Yap.Models;

namespace Yap.Services.Gifs;

/// <summary>
/// BYOG ("bring your own GIFs") surface of GifService: the admin-curated server library,
/// per-user favorite folders, upload quota, entry deletion, and zip pack import/export.
/// Split off the core file the same way EmojiService.Rendering.cs is.
/// </summary>
public partial class GifService
{
    // Pack import limits. The per-entry cap matches the picker's single-upload cap; the entry
    // count cap is a zip-bomb backstop, not a curation limit.
    private const int MaxPackEntries = 1000;
    private const long MaxPackEntryBytes = 50L * 1024 * 1024;
    private static readonly HashSet<string> PackMediaExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".gif", ".webp", ".mp4", ".webm", ".mov" };

    // camelCase on both sides so exported packs and hand-written manifests read naturally.
    private static readonly JsonSerializerOptions PackJsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>Raised on every processed file of a background pack import. UI filters by ImportId/actor.</summary>
    public event Action<GifImportProgress>? OnImportProgress;

    /// <summary>Per-user cap on custom-upload bytes. Admins are exempt (enforced by callers).</summary>
    public long UserQuotaBytes { get; }

    #region Server library

    public bool HasServerGifs => _entries.Values.Any(e => e.IsServerGif && e.DeletedAt == null);

    public List<GifEntry> GetServerGifs(string? folder = null) =>
        _entries.Values
            .Where(e => e.IsServerGif && e.DeletedAt == null)
            .Where(e => folder == null || string.Equals(e.ServerFolder, folder, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(e => e.CreatedAt)
            .ToList();

    public List<string> GetServerFolders() =>
        _entries.Values
            .Where(e => e.IsServerGif && e.DeletedAt == null && !string.IsNullOrEmpty(e.ServerFolder))
            .Select(e => e.ServerFolder!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>
    /// Adds/removes an entry from the server library, optionally filing it in a folder.
    /// Persisted immediately (an explicit admin action shouldn't be lost to a restart).
    /// Admin-only — enforced by callers, which all sit behind admin gates.
    /// </summary>
    public async Task<bool> SetServerGifAsync(Guid entryId, bool isServer, string? folder = null)
    {
        if (!_entries.TryGetValue(entryId, out var entry) || entry.DeletedAt != null) return false;

        folder = SanitizeFolder(folder);
        lock (entry)
        {
            entry.IsServerGif = isServer;
            entry.ServerFolder = isServer ? folder : null;
        }

        if (_dbFactory != null)
        {
            try
            {
                await using var db = await _dbFactory.CreateDbContextAsync();
                await db.GifEntries
                    .Where(g => g.Id == entryId)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(g => g.IsServerGif, entry.IsServerGif)
                        .SetProperty(g => g.ServerFolder, entry.ServerFolder));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to persist server-library change for GIF {Id}", entryId);
            }
        }

        _changes.Touch(Yap.Services.OfflineChangeKind.Gif, entry.Id);
        OnGifLibraryChanged?.Invoke(entry);
        return true;
    }

    #endregion

    #region Favorite folders

    public List<string> GetFavoriteFolders(Guid userId)
    {
        if (!_favoritesByUser.TryGetValue(userId, out var map)) return new();
        lock (map)
            return map.Values
                .Where(f => f != null)
                .Select(f => f!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .ToList();
    }

    /// <summary>Snapshot of gifId → folder for one user, for joining against GetFavorites.</summary>
    public Dictionary<Guid, string?> GetFavoriteFolderMap(Guid userId)
    {
        if (!_favoritesByUser.TryGetValue(userId, out var map)) return new();
        lock (map) return new Dictionary<Guid, string?>(map);
    }

    /// <summary>
    /// Folder names become zip directory names on export, so they're made path-safe at write
    /// time rather than trusted at read time. One level only — no separators survive.
    /// </summary>
    internal static string? SanitizeFolder(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return null;

        var cleaned = new string(folder.Trim()
            .Where(c => !char.IsControl(c) && c is not ('/' or '\\'))
            .ToArray())
            .Replace("..", "")
            .Trim();

        if (cleaned.Length > 64) cleaned = cleaned[..64].Trim();
        return cleaned.Length == 0 ? null : cleaned;
    }

    #endregion

    #region Quota

    /// <summary>
    /// Bytes of this user's own custom uploads (provider-cached favorites are shared cache and
    /// don't count). Soft-deleted entries don't count either — their files persist only as
    /// message media, like un-quota'd chat images.
    /// </summary>
    public long GetUserLibraryBytes(Guid userId) =>
        _entries.Values
            .Where(e => e.UploadedByUserId == userId && e.SourceProviderId == null && e.DeletedAt == null)
            .Sum(e => e.FileSizeBytes);

    #endregion

    #region Delete

    /// <summary>
    /// Deletes an entry, degrading gracefully instead of breaking chat history or other users'
    /// pools. Without <paramref name="force"/> (self-service): only the uploader's own custom
    /// uploads, and only when nothing references them — otherwise the entry just leaves the
    /// actor's favorites. With force (admin): favorites are purged everywhere; message-referenced
    /// entries are soft-deleted (file kept so history renders), unreferenced ones fully removed.
    /// </summary>
    public async Task<GifDeleteResult> DeleteEntryAsync(Guid actorUserId, Guid entryId, bool force)
    {
        if (!_entries.TryGetValue(entryId, out var entry) || entry.DeletedAt != null)
            return GifDeleteResult.NotFound;

        if (force && !_userService.IsAdmin(actorUserId))
            return GifDeleteResult.NotAllowed;

        if (!force)
        {
            if (entry.SourceProviderId != null || entry.UploadedByUserId != actorUserId)
                return GifDeleteResult.NotAllowed;

            if (entry.ReferenceCount > 0 || CountOtherFavoriters(entryId, actorUserId) > 0)
            {
                await SetFavoriteAsync(actorUserId, entryId, favorite: false);
                return GifDeleteResult.UnstarredOnly;
            }
        }

        // Purge from every user's favorites (memory now, DB below), remembering who to notify.
        var affectedUsers = new List<Guid>();
        foreach (var (uid, map) in _favoritesByUser)
        {
            bool removed;
            lock (map) removed = map.Remove(entryId);
            if (removed) affectedUsers.Add(uid);
        }

        // De-index from search and dedup lookups.
        var tags = DeserializeTags(entry.Tags);
        lock (_tagIndexLock)
        {
            foreach (var tag in tags)
            {
                if (_tagIndex.TryGetValue(tag, out var set))
                {
                    set.Remove(entryId);
                    if (set.Count == 0) _tagIndex.Remove(tag);
                }
            }
        }
        if (entry.ContentHash != null)
            _byContentHash.TryRemove(new KeyValuePair<string, Guid>(entry.ContentHash, entryId));
        if (!string.IsNullOrEmpty(entry.SourceProviderId) && !string.IsNullOrEmpty(entry.SourceId))
            _byProviderSourceId.TryRemove(new KeyValuePair<(string, string), Guid>((entry.SourceProviderId, entry.SourceId), entryId));

        var softDelete = entry.ReferenceCount > 0;
        if (softDelete)
        {
            entry.DeletedAt = DateTime.UtcNow;
        }
        else
        {
            _entries.TryRemove(entryId, out _);
            DeleteLocalFiles(entry);
        }
        _dirtyEntries.TryRemove(entryId, out _);

        if (_dbFactory != null)
        {
            try
            {
                await using var db = await _dbFactory.CreateDbContextAsync();
                await db.FavoriteGifs.Where(f => f.GifEntryId == entryId).ExecuteDeleteAsync();
                if (softDelete)
                    await db.GifEntries.Where(g => g.Id == entryId)
                        .ExecuteUpdateAsync(s => s.SetProperty(g => g.DeletedAt, entry.DeletedAt));
                else
                    await db.GifEntries.Where(g => g.Id == entryId).ExecuteDeleteAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to persist deletion of GIF {Id}", entryId);
            }
        }

        foreach (var uid in affectedUsers)
        {
            _changes.Touch(Yap.Services.OfflineChangeKind.Favorites, uid);
            OnFavoritesChanged?.Invoke(uid);
        }
        _changes.Touch(Yap.Services.OfflineChangeKind.Gif, entry.Id);
        OnGifLibraryChanged?.Invoke(entry);

        _logger.LogInformation("GIF {Id} {Mode}-deleted by {Actor} (refs: {Refs})",
            entryId, softDelete ? "soft" : "hard", actorUserId, entry.ReferenceCount);
        return softDelete ? GifDeleteResult.SoftDeleted : GifDeleteResult.Deleted;
    }

    private int CountOtherFavoriters(Guid entryId, Guid excludeUserId)
    {
        var count = 0;
        foreach (var (uid, map) in _favoritesByUser)
        {
            if (uid == excludeUserId) continue;
            lock (map) { if (map.ContainsKey(entryId)) count++; }
        }
        return count;
    }

    private void DeleteLocalFiles(GifEntry entry)
    {
        // Local files are always {dir}/{entryId}.{ext} in one of the two roots.
        foreach (var dir in new[] { CustomUploadsDir, CacheDir })
        {
            try
            {
                foreach (var file in Directory.GetFiles(dir, $"{entry.Id}.*"))
                    TryDelete(file);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not sweep local files for deleted GIF {Id} in {Dir}", entry.Id, dir);
            }
        }
    }

    #endregion

    #region Pack import

    /// <summary>
    /// Kicks off a background import of an uploaded zip (owns and eventually deletes the file).
    /// Progress arrives via <see cref="OnImportProgress"/> — the manager UI listens over the
    /// circuit, so no HTTP polling is needed. Returns the id progress events carry.
    /// </summary>
    public Guid StartPackImport(string zipPath, Guid actorUserId, bool serverTarget)
    {
        var importId = Guid.NewGuid();
        _ = Task.Run(() => RunPackImportAsync(importId, zipPath, actorUserId, serverTarget));
        return importId;
    }

    private async Task RunPackImportAsync(Guid importId, string zipPath, Guid actorUserId, bool serverTarget)
    {
        int done = 0, skipped = 0, total = 0;
        void Report(bool completed = false, string? error = null)
            => OnImportProgress?.Invoke(new GifImportProgress(importId, actorUserId, serverTarget, done, total, skipped, completed, error));

        try
        {
            using var zip = ZipFile.OpenRead(zipPath);
            var manifest = ReadPackManifest(zip);

            var mediaEntries = zip.Entries
                .Where(e => !string.IsNullOrEmpty(e.Name)          // directories have an empty Name
                            && !e.Name.StartsWith('.')             // dotfiles (.DS_Store and friends)
                            && PackMediaExtensions.Contains(Path.GetExtension(e.Name)))
                .Take(MaxPackEntries)
                .ToList();

            // Without ffmpeg only the copy-as-is formats can import — count video entries out up
            // front so the progress numbers are honest instead of failing them one by one.
            if (!GifFfmpegHelper.IsAvailable)
            {
                var videoEntries = mediaEntries
                    .Where(e => Path.GetExtension(e.Name).ToLowerInvariant() is not (".gif" or ".webp"))
                    .ToList();
                if (videoEntries.Count > 0)
                {
                    _logger.LogWarning("Pack import: skipping {Count} video entries — ffmpeg unavailable", videoEntries.Count);
                    skipped += videoEntries.Count;
                    mediaEntries = mediaEntries.Except(videoEntries).ToList();
                }
            }

            total = mediaEntries.Count + skipped;
            Report();

            var isAdmin = _userService.IsAdmin(actorUserId);

            // Sequential on purpose: one ffmpeg per import keeps a big pack from starving chat
            // uploads (the transcoder itself only allows 2 concurrent runs process-wide).
            foreach (var zipEntry in mediaEntries)
            {
                var ext = Path.GetExtension(zipEntry.Name).ToLowerInvariant();
                var tempPath = Path.Combine(Path.GetTempPath(), $"gif-import-{Guid.NewGuid():N}{ext}");
                try
                {
                    // Extraction never uses zip-supplied names as paths (zip-slip can't happen),
                    // and the size cap counts actual bytes — a crafted header can lie in Length.
                    if (!await CopyZipEntryCappedAsync(zipEntry, tempPath, MaxPackEntryBytes))
                    {
                        _logger.LogWarning("Pack import: {Entry} exceeds the {Cap}MB per-file cap — skipped",
                            zipEntry.FullName, MaxPackEntryBytes / (1024 * 1024));
                        skipped++;
                        continue;
                    }

                    if (!serverTarget && !isAdmin
                        && GetUserLibraryBytes(actorUserId) + SafeFileSize(tempPath) > UserQuotaBytes)
                    {
                        skipped = total - done;
                        Report(completed: true, error: "GIF storage quota exceeded — import stopped");
                        return;
                    }

                    var entryPath = zipEntry.FullName.Replace('\\', '/');
                    var item = manifest?.GetValueOrDefault(entryPath);
                    var hasManifestTags = item?.Tags is { Count: > 0 };

                    // With manifest tags the filename carries no information (export names embed
                    // an id suffix that would seed junk tags) — skip filename seeding entirely.
                    var att = await TryAcceptAsGifAsync(tempPath, MimeFromPackExtension(ext),
                        isExplicitGif: true, actorUserId, hasManifestTags ? null : zipEntry.Name);
                    if (att == null)
                    {
                        skipped++;
                        continue;
                    }

                    // Manifest tags MERGE into the entry (dedup may have landed us on an existing
                    // one — overwriting would let an import clobber accumulated or server tags).
                    if (hasManifestTags && GetEntry(att.GifEntryId) is { } accepted)
                    {
                        foreach (var tag in item!.Tags!)
                            AppendTag(accepted, tag);
                        _dirtyEntries.TryAdd(accepted.Id, 0);
                    }

                    var folder = item?.Folder ?? FirstPathSegment(entryPath);
                    if (serverTarget)
                        await SetServerGifAsync(att.GifEntryId, isServer: true, folder);
                    else
                        await SetFavoriteAsync(actorUserId, att.GifEntryId, favorite: true, folder);

                    done++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Pack import: failed on entry {Entry}", zipEntry.FullName);
                    skipped++;
                }
                finally
                {
                    TryDelete(tempPath); // no-op when TryAccept consumed it
                }
                Report();
            }

            Report(completed: true);
            _logger.LogInformation("GIF pack import {ImportId} finished: {Done}/{Total} imported, {Skipped} skipped",
                importId, done, total, skipped);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GIF pack import {ImportId} failed", importId);
            Report(completed: true, error: "import failed — the zip could not be read");
        }
        finally
        {
            TryDelete(zipPath);
        }
    }

    private Dictionary<string, GifPackItem>? ReadPackManifest(ZipArchive zip)
    {
        var manifestEntry = zip.Entries.FirstOrDefault(e =>
            e.FullName.Equals("gifs.json", StringComparison.OrdinalIgnoreCase));
        if (manifestEntry == null) return null;

        try
        {
            using var stream = manifestEntry.Open();
            var manifest = JsonSerializer.Deserialize<GifPackManifest>(stream, PackJsonOptions);
            if (manifest?.Gifs == null) return null;

            var map = new Dictionary<string, GifPackItem>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in manifest.Gifs)
                if (!string.IsNullOrEmpty(item.File))
                    map[item.File.Replace('\\', '/')] = item;
            return map;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Pack import: gifs.json unreadable — falling back to filename tags");
            return null;
        }
    }

    private static async Task<bool> CopyZipEntryCappedAsync(ZipArchiveEntry zipEntry, string destPath, long maxBytes)
    {
        await using var dest = File.Create(destPath);
        await using var src = zipEntry.Open();
        var buffer = new byte[81920];
        long totalBytes = 0;
        int read;
        while ((read = await src.ReadAsync(buffer)) > 0)
        {
            totalBytes += read;
            if (totalBytes > maxBytes) return false; // caller deletes the partial file
            await dest.WriteAsync(buffer.AsMemory(0, read));
        }
        return true;
    }

    private static string MimeFromPackExtension(string ext) => ext switch
    {
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        _ => "application/octet-stream",
    };

    /// <summary>First directory of a zip entry path — the pack's 1-level folder. Null at root.</summary>
    private static string? FirstPathSegment(string entryPath)
    {
        var idx = entryPath.IndexOf('/');
        return idx > 0 ? entryPath[..idx] : null;
    }

    #endregion

    #region Pack export

    /// <summary>
    /// Streams a zip of a library — a user's pool (favorites) or the server library
    /// (<paramref name="userId"/> null) — straight onto <paramref name="output"/> (works on the
    /// non-seekable HTTP response body). Media entries are stored uncompressed (they already
    /// are); a gifs.json manifest makes the pack a lossless round-trip with import.
    /// </summary>
    public async Task WritePackAsync(Stream output, Guid? userId, CancellationToken ct)
    {
        var items = userId is Guid uid
            ? JoinFavoritesWithFolders(uid)
            : GetServerGifs().Select(e => (Entry: e, Folder: e.ServerFolder)).ToList();

        // The async zip APIs matter here: output is the HTTP response body, and Kestrel forbids
        // the synchronous writes classic ZipArchive.Dispose() does (central directory, entry
        // descriptors) — they'd throw mid-download.
        var zip = await ZipArchive.CreateAsync(output, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);
        await using (zip)
        {
            var manifestItems = new List<GifPackItem>();
            var skippedRemoteOnly = 0;

            foreach (var (entry, folder) in items)
            {
                ct.ThrowIfCancellationRequested();

                var localPath = ResolveLocalFile(entry);
                if (localPath == null)
                {
                    skippedRemoteOnly++; // provider favorite not yet cached locally — nothing to ship
                    continue;
                }

                // Human-readable name + 8-char id suffix: collision-proof without a counter, and
                // the manifest (not the filename) is what carries tags on re-import.
                var baseName = FileNameSafeTag(entry) ?? "gif";
                var zipPath = $"{(folder != null ? folder + "/" : "")}{baseName}-{entry.Id.ToString("N")[..8]}{Path.GetExtension(localPath)}";

                var fileEntry = zip.CreateEntry(zipPath, CompressionLevel.NoCompression);
                await using (var dest = await fileEntry.OpenAsync(ct))
                await using (var src = File.OpenRead(localPath))
                    await src.CopyToAsync(dest, ct);

                manifestItems.Add(new GifPackItem(zipPath, GetTags(entry), folder));
            }

            var manifestZipEntry = zip.CreateEntry("gifs.json", CompressionLevel.Optimal);
            await using (var manifestStream = await manifestZipEntry.OpenAsync(ct))
                await JsonSerializer.SerializeAsync(manifestStream, new GifPackManifest(1, manifestItems), PackJsonOptions, ct);

            if (skippedRemoteOnly > 0)
                _logger.LogInformation("GIF pack export skipped {Count} entries without a local file", skippedRemoteOnly);
        }
    }

    private List<(GifEntry Entry, string? Folder)> JoinFavoritesWithFolders(Guid userId)
    {
        var folders = GetFavoriteFolderMap(userId);
        return GetFavorites(userId)
            .Select(e => (Entry: e, Folder: folders.GetValueOrDefault(e.Id)))
            .ToList();
    }

    /// <summary>Maps an entry's local URL back to its disk path. Null when only remote URLs exist.</summary>
    private string? ResolveLocalFile(GifEntry entry)
    {
        // GifUrl first (every normalized entry has one); legacy custom uploads may only have a
        // local video URL from the older pipeline.
        foreach (var url in new[] { entry.GifUrl, entry.Mp4Url, entry.WebmUrl })
        {
            var path = url switch
            {
                not null when url.StartsWith("/uploads/gifs/") => Path.Combine(CustomUploadsDir, Path.GetFileName(url)),
                not null when url.StartsWith("/gif-cache/") => Path.Combine(CacheDir, Path.GetFileName(url)),
                _ => null,
            };
            if (path != null && File.Exists(path)) return path;
        }
        return null;
    }

    /// <summary>First tag reduced to filename-safe characters, for friendly export names.</summary>
    private string? FileNameSafeTag(GifEntry entry)
    {
        var tag = GetTags(entry).FirstOrDefault();
        if (string.IsNullOrEmpty(tag)) return null;

        var safe = new string(tag.Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        if (safe.Length > 32) safe = safe[..32].Trim('-');
        return safe.Length == 0 ? null : safe;
    }

    #endregion
}

/// <summary>Progress snapshot of a background pack import.</summary>
public sealed record GifImportProgress(
    Guid ImportId, Guid ActorUserId, bool ServerTarget,
    int Done, int Total, int SkippedOrFailed, bool Completed, string? Error);

/// <summary>Outcome of <see cref="GifService.DeleteEntryAsync"/>, for user-facing messaging.</summary>
public enum GifDeleteResult { NotFound, NotAllowed, UnstarredOnly, SoftDeleted, Deleted }

/// <summary>gifs.json pack manifest — the round-trip format shared by import and export.</summary>
internal sealed record GifPackManifest(int Version, List<GifPackItem>? Gifs);
internal sealed record GifPackItem(string File, List<string>? Tags, string? Folder);
