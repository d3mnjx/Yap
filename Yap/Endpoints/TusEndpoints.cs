using System.Collections.Concurrent;
using System.Net;
using tusdotnet;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;
using tusdotnet.Stores;
using Yap.Middleware;
using Yap.Services;
using Yap.Services.Gifs;

namespace Yap.Endpoints;

public static class TusEndpoints
{
    private static readonly ConcurrentDictionary<string, (object Result, DateTime CreatedAt)> _completedFiles = new();
    private static readonly HashSet<string> _imageExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp" };
    private static readonly HashSet<string> _videoExtensionsForGifProbe = new(StringComparer.OrdinalIgnoreCase)
        { ".mp4", ".webm", ".mov", ".mkv" };

    public static void MapTusEndpoints(this WebApplication app)
    {
        var tusStorePath = Path.Combine(app.Environment.WebRootPath, "uploads", "tus-temp");
        Directory.CreateDirectory(tusStorePath);
        var webRootPath = app.Environment.WebRootPath;

        app.MapTus("/api/tus", async httpContext => new()
        {
            Store = new TusDiskStore(tusStorePath),
            MaxAllowedUploadSizeInBytesLong = GetMaxUploadBytes(httpContext),
            Events = new()
            {
                OnAuthorizeAsync = eventContext =>
                {
                    if (eventContext.HttpContext.Request.Method == "OPTIONS")
                        return Task.CompletedTask;

                    var token = eventContext.HttpContext.Request.Cookies[AuthMiddleware.CookieName];
                    var userService = eventContext.HttpContext.RequestServices.GetRequiredService<UserService>();
                    var user = !string.IsNullOrEmpty(token) ? userService.AuthenticateByToken(token) : null;
                    if (user == null || (eventContext.HttpContext.Request.Headers.TryGetValue("X-Yap-Upload-User", out var expectedUser) && expectedUser != user.Id.ToString()))
                    {
                        eventContext.FailRequest(HttpStatusCode.Unauthorized, "Authentication required");
                    }
                    return Task.CompletedTask;
                },

                // Rejects doomed GIF-library creates before gigabytes flow. Advisory only — the
                // metadata is client-controlled, so OnFileComplete re-checks authoritatively.
                OnBeforeCreateAsync = eventContext =>
                {
                    string? Meta(string key) => eventContext.Metadata.TryGetValue(key, out var m)
                        ? m.GetString(System.Text.Encoding.UTF8) : null;

                    var kind = Meta("kind");
                    if (kind != "gif-pack" && !eventContext.HttpContext.RequestServices.GetRequiredService<Yap.Offline.ChatLimits>()
                        .AllowedExtensions.Contains(Path.GetExtension(Meta("filename") ?? ""), StringComparer.OrdinalIgnoreCase))
                    {
                        eventContext.FailRequest("This file extension is not allowed.");
                        return Task.CompletedTask;
                    }
                    var target = Meta("target");
                    if (kind is not ("gif" or "gif-pack") && target == null)
                        return Task.CompletedTask; // plain chat upload

                    // Without ffmpeg, .gif/.webp still import (copied as-is) — only video
                    // conversion is off. Packs pass too; video entries inside just get skipped.
                    if (!GifFfmpegHelper.IsAvailable && kind == "gif"
                        && Path.GetExtension(Meta("filename") ?? "").ToLowerInvariant() is not (".gif" or ".webp"))
                    {
                        eventContext.FailRequest("Video conversion is unavailable on this server (ffmpeg missing) — only .gif/.webp files can be imported");
                        return Task.CompletedTask;
                    }

                    if (target != null)
                    {
                        var services = eventContext.HttpContext.RequestServices;
                        var token = eventContext.HttpContext.Request.Cookies[AuthMiddleware.CookieName];
                        var userService = services.GetRequiredService<UserService>();
                        var user = !string.IsNullOrEmpty(token) ? userService.AuthenticateByToken(token) : null;
                        if (user == null)
                        {
                            eventContext.FailRequest("Authentication required");
                        }
                        else if (target == "server" && !userService.IsAdmin(user.Id))
                        {
                            eventContext.FailRequest("Only admins can add to the server library");
                        }
                        else if (target == "user" && !userService.IsAdmin(user.Id))
                        {
                            var gifService = services.GetRequiredService<GifService>();
                            if (eventContext.UploadLength + gifService.GetUserLibraryBytes(user.Id) > gifService.UserQuotaBytes)
                                eventContext.FailRequest("GIF storage quota exceeded");
                        }
                    }
                    return Task.CompletedTask;
                },

                OnFileCompleteAsync = async eventContext =>
                {
                    var logger = eventContext.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("TusUpload");
                    var imageService = eventContext.HttpContext.RequestServices.GetRequiredService<ImageService>();
                    var videoService = eventContext.HttpContext.RequestServices.GetRequiredService<VideoService>();
                    var mediaLog = eventContext.HttpContext.RequestServices.GetRequiredService<MediaUploadLogService>();
                    var userService = eventContext.HttpContext.RequestServices.GetRequiredService<UserService>();
                    var gifService = eventContext.HttpContext.RequestServices.GetRequiredService<GifService>();

                    var file = await eventContext.GetFileAsync();
                    var metadata = await file.GetMetadataAsync(eventContext.CancellationToken);

                    // Null when tus metadata carried no filename; originalFileName keeps the
                    // "unknown" placeholder for logging, but tag-seeding must not see it.
                    var uploadedFileName = metadata.TryGetValue("filename", out var fName)
                        ? fName.GetString(System.Text.Encoding.UTF8) : null;
                    var originalFileName = uploadedFileName ?? "unknown";
                    var extension = Path.GetExtension(originalFileName).ToLowerInvariant();
                    var kind = metadata.TryGetValue("kind", out var kindMeta)
                        ? kindMeta.GetString(System.Text.Encoding.UTF8) : null;
                    if (kind != "gif-pack" && !eventContext.HttpContext.RequestServices.GetRequiredService<Yap.Offline.ChatLimits>()
                        .AllowedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
                        throw new InvalidOperationException("This file extension is not allowed.");
                    // Library uploads (GifLibraryManager) carry a destination; chat uploads don't.
                    var target = metadata.TryGetValue("target", out var targetMeta)
                        ? targetMeta.GetString(System.Text.Encoding.UTF8) : null;
                    var folder = metadata.TryGetValue("folder", out var folderMeta)
                        ? folderMeta.GetString(System.Text.Encoding.UTF8) : null;

                    var token = eventContext.HttpContext.Request.Cookies[AuthMiddleware.CookieName];
                    var user = !string.IsNullOrEmpty(token) ? userService.AuthenticateByToken(token) : null;

                    void Complete(object result)
                    {
                        // Offline sends may lose the completion response or restart the server.
                        // Keep an account-owned receipt outside wwwroot; never consume it on read.
                        if (user != null)
                        {
                            var directory = Path.Combine(app.Environment.ContentRootPath, "Data", "upload-receipts", user.Id.ToString("N"));
                            Directory.CreateDirectory(directory);
                            var path = Path.Combine(directory, file.Id + ".json");
                            File.WriteAllText(path + ".tmp", System.Text.Json.JsonSerializer.Serialize(result));
                            File.Move(path + ".tmp", path, true);
                        }
                        _completedFiles[file.Id] = (result, DateTime.UtcNow);
                        // The final PATCH can acknowledge completed processing without a
                        // follow-up GET. Retained clients may continue using the receipt route.
                        if (!eventContext.HttpContext.Response.HasStarted)
                            eventContext.HttpContext.Response.Headers["X-Yap-Upload-Complete"] =
                                Convert.ToBase64String(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(result));
                    }
                    var tusFilePath = Path.Combine(tusStorePath, file.Id);
                    void CleanupTusMetadata()
                    {
                        foreach (var metaFile in Directory.GetFiles(tusStorePath, $"{file.Id}.*"))
                            try { File.Delete(metaFile); } catch { }
                    }

                    // Zip pack import. The archive must never reach wwwroot/uploads — it would be
                    // publicly served — so it moves to the system temp dir instead, and the
                    // background import owns (and eventually deletes) it.
                    if (kind == "gif-pack")
                    {
                        var serverTarget = target == "server";
                        if (user == null || (serverTarget && !userService.IsAdmin(user.Id)))
                        {
                            logger.LogWarning("Rejected gif-pack upload ({Reason})",
                                user == null ? "unauthenticated" : "server target without admin");
                            try { File.Delete(tusFilePath); } catch { }
                            CleanupTusMetadata();
                            Complete(new { type = "error", error = "Not allowed" });
                            return;
                        }

                        var zipPath = Path.Combine(Path.GetTempPath(), $"gif-pack-{file.Id}.zip");
                        File.Move(tusFilePath, zipPath);
                        CleanupTusMetadata();

                        var importId = gifService.StartPackImport(zipPath, user.Id, serverTarget);
                        mediaLog.Log(user.Id, user.Username, originalFileName, $"gif-pack/{importId}",
                            new FileInfo(zipPath).Length, "gif-pack", ".zip");
                        logger.LogInformation("GIF pack accepted from {User} → import {ImportId} (server: {Server})",
                            user.Username, importId, serverTarget);
                        Complete(new { type = "gif-pack", importId });
                        return;
                    }

                    string type;
                    if (kind == "gif" || _imageExtensions.Contains(extension))
                        type = "image"; // Will be re-classified to gif below if applicable.
                    else if (VideoService.IsVideoFile(extension))
                        type = "video";
                    else
                    {
                        logger.LogWarning("Unsupported file type uploaded via tus: {Extension}", extension);
                        return;
                    }

                    var uploadsFolder = Path.Combine(webRootPath, "uploads");
                    var uniqueFileName = $"{Guid.NewGuid()}{extension}";
                    var filePath = Path.Combine(uploadsFolder, uniqueFileName);

                    File.Move(tusFilePath, filePath);
                    CleanupTusMetadata();

                    var fileSize = new FileInfo(filePath).Length;

                    // GIF routing: explicit kind=gif, .gif extension, or a short silent video clip.
                    // GifService consumes the source file on success; failure leaves it in place for the regular pipeline.
                    var isExplicitGif = kind == "gif" || extension == ".gif";
                    var probeForGif = isExplicitGif
                        || (type == "video" && _videoExtensionsForGifProbe.Contains(extension));
                    var isLibraryUpload = target is "user" or "server"; // manager upload, not a chat attachment
                    if (probeForGif)
                    {
                        // Authoritative gate for library uploads — OnBeforeCreate only rejected
                        // early to save bandwidth, and its inputs are client-controlled headers.
                        if (isLibraryUpload)
                        {
                            var isAdmin = user != null && userService.IsAdmin(user.Id);
                            var overQuota = user != null && !isAdmin && target == "user"
                                && fileSize + gifService.GetUserLibraryBytes(user.Id) > gifService.UserQuotaBytes;
                            if (user == null || (target == "server" && !isAdmin) || overQuota)
                            {
                                try { File.Delete(filePath); } catch { }
                                Complete(new
                                { type = "error", error = overQuota ? "GIF storage quota exceeded" : "Not allowed" });
                                return;
                            }
                        }

                        var contentType = MimeFromExtension(extension);
                        var gifAttachment = await gifService.TryAcceptAsGifAsync(
                            filePath, contentType, isExplicitGif, user?.Id, uploadedFileName);
                        if (gifAttachment != null)
                        {
                            logger.LogDebug("Tus upload classified as GIF: {FileName} ({EntryId})",
                                originalFileName, gifAttachment.GifEntryId);
                            if (user != null)
                            {
                                mediaLog.Log(user.Id, user.Username, originalFileName ?? "unknown",
                                    $"gif/{gifAttachment.GifEntryId}", fileSize, "gif", extension);
                            }

                            // Library uploads land in their destination (folder = the manager's
                            // currently selected folder); chat uploads stay chat-only.
                            if (isLibraryUpload && user != null)
                            {
                                if (target == "server")
                                    await gifService.SetServerGifAsync(gifAttachment.GifEntryId, isServer: true, folder);
                                else
                                    await gifService.SetFavoriteAsync(user.Id, gifAttachment.GifEntryId, favorite: true, folder);
                            }

                            Complete(new
                            {
                                type = "gif",
                                gifEntryId = gifAttachment.GifEntryId,
                                width = gifAttachment.Width,
                                height = gifAttachment.Height
                            });
                            return;
                        }
                        else if (isLibraryUpload)
                        {
                            // A failed manager upload must not fall through into the chat media
                            // pipeline — it would post as an orphan image nobody asked for.
                            try { File.Delete(filePath); } catch { }
                            Complete(new { type = "error", error = "Could not process this file as a GIF" });
                            return;
                        }
                        else if (isExplicitGif)
                        {
                            logger.LogWarning("Explicit kind=gif upload rejected: {FileName}", originalFileName);
                            // Fall through to regular pipeline so the file isn't lost.
                        }
                    }

                    logger.LogDebug("Tus upload complete: {FileName} ({Type}, {Size}KB)", uniqueFileName, type, fileSize / 1024);

                    if (user != null)
                    {
                        mediaLog.Log(user.Id, user.Username, originalFileName, uniqueFileName, fileSize, type, extension);
                    }

                    if (type == "image")
                    {
                        var sw = System.Diagnostics.Stopwatch.StartNew();
                        await imageService.GenerateMediumThumbnailAsync(filePath);
                        if (!File.Exists(ImageService.GetMediumUrl(filePath)))
                        {
                            Complete(new { type = "error", error = "This image could not be decoded." });
                            return;
                        }
                        var mediumMs = sw.ElapsedMilliseconds;

                        _ = Task.Run(async () =>
                        {
                            try
                            {
                                var swLarge = System.Diagnostics.Stopwatch.StartNew();
                                await imageService.GenerateLargeThumbnailAsync(filePath);
                                swLarge.Stop();
                                await mediaLog.SetCompressDurationAsync(uniqueFileName, mediumMs + swLarge.ElapsedMilliseconds);
                            }
                            catch (Exception ex)
                            {
                                logger.LogError(ex, "Error generating large thumbnail for {FileName}", uniqueFileName);
                            }
                        });
                    }
                    else // video
                    {
                        if (VideoService.IsAvailable)
                        {
                            await videoService.GeneratePosterAsync(filePath);

                            _ = Task.Run(async () =>
                            {
                                try
                                {
                                    var (compressedPath, durationMs) = await videoService.CompressVideoAsync(filePath);
                                    if (compressedPath != null && durationMs > 0)
                                        await mediaLog.SetCompressDurationAsync(uniqueFileName, durationMs);
                                }
                                catch (Exception ex)
                                {
                                    logger.LogError(ex, "Error compressing video {FileName}", uniqueFileName);
                                }
                            });
                        }
                    }

                    Complete(new { url = $"/uploads/{uniqueFileName}", path = filePath, type });
                }
            }
        }).RequireCors("TusUpload");

        app.MapGet("/api/tus/info/{fileId}", (string fileId) =>
        {
            if (_completedFiles.TryRemove(fileId, out var result) && result.CreatedAt >= DateTime.UtcNow - ChatReceiptCleanup.Retention)
                return Results.Ok(result.Result);
            return Results.NotFound(new { error = "File not found or still processing" });
        }).RequireCors("TusUpload");
    }

    /// <summary>
    /// Per-request upload ceiling. Zip pack imports get their own (much larger) cap than chat
    /// attachments — with a multi-GB library quota, the chat cap would be a wall. The kind is
    /// sniffed from the create POST's Upload-Metadata header ("gif-pack" base64-encoded), the
    /// only place it's visible before tusdotnet validates Upload-Length against this limit.
    /// </summary>
    public static System.Text.Json.JsonElement? Completed(IWebHostEnvironment env, Guid userId, string id)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-fA-F0-9]{16,64}$")) return null;
        var path = Path.Combine(env.ContentRootPath, "Data", "upload-receipts", userId.ToString("N"), id + ".json");
        try
        {
            return File.GetLastWriteTimeUtc(path) >= DateTime.UtcNow - ChatReceiptCleanup.Retention
                ? System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(File.ReadAllText(path)) : null;
        }
        catch (FileNotFoundException) { return null; } // Cleanup may win a concurrent lookup.
        catch (DirectoryNotFoundException) { return null; }
    }

    // Completion receipts share the send deduplication window; uploaded media is independent.
    public static void PruneReceipts(IWebHostEnvironment env, DateTime before)
    {
        foreach (var pair in _completedFiles)
            if (pair.Value.CreatedAt < before)
                ((ICollection<KeyValuePair<string, (object Result, DateTime CreatedAt)>>)_completedFiles).Remove(pair);
        var root = Path.Combine(env.ContentRootPath, "Data", "upload-receipts");
        if (!Directory.Exists(root)) return;
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            foreach (var path in Directory.EnumerateFiles(directory))
                if (File.GetLastWriteTimeUtc(path) < before) File.Delete(path);
            // A completion may be creating a file while the sweep removes an empty folder.
            // Keep the account folders so writers never lose their parent directory.
        }
    }

    private static long GetMaxUploadBytes(HttpContext httpContext)
    {
        var config = httpContext.RequestServices.GetRequiredService<IConfiguration>();
        var isGifPack = httpContext.Request.Headers.TryGetValue("Upload-Metadata", out var meta)
                        && meta.ToString().Contains("kind Z2lmLXBhY2s=");
        var mb = isGifPack
            ? config.GetValue("ChatSettings:GifSettings:MaxPackSizeMB", 1024)
            : config.GetValue("ChatSettings:MaxUploadSizeMB", 100);
        return (long)mb * 1024 * 1024;
    }

    private static string MimeFromExtension(string ext) => ext switch
    {
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".webm" => "video/webm",
        ".mp4" => "video/mp4",
        ".mov" => "video/quicktime",
        ".mkv" => "video/x-matroska",
        _ => "application/octet-stream"
    };
}
