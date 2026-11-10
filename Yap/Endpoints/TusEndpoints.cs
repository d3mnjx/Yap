using System.Net;
using System.Security.Claims;
using System.Text.Json;
using tusdotnet;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;
using tusdotnet.Models.Expiration;
using tusdotnet.Stores;
using Yap.Services;
using Yap.Services.Gifs;
using Yap.Services.Accounts;
using Yap.Services.Media;

using Yap.Models.Accounts;

namespace Yap.Endpoints;

public static class TusEndpoints
{
    private static readonly HashSet<string> _imageExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp" };
    private static readonly HashSet<string> _videoExtensionsForGifProbe = new(StringComparer.OrdinalIgnoreCase)
        { ".mp4", ".webm", ".mov", ".mkv" };

    public static void MapTusEndpoints(this WebApplication app)
    {
        var uploads = app.Services.GetRequiredService<UploadPaths>();
        var tusStorePath = uploads.TusTemp;
        Directory.CreateDirectory(uploads.TusResults);   // under the tus folder, which this creates too

        app.MapTus("/api/tus", async httpContext => new()
        {
            // The id of an upload names its owner (UploadIds). An anonymous request never creates one: OnAuthorize refuses it first.
            Store = new TusDiskStore(tusStorePath, false, TusDiskBufferSize.Default,
                new UploadIds(httpContext.User.IsSignedIn() ? httpContext.User.Id() : Guid.Empty)),
            MaxAllowedUploadSizeInBytesLong = GetMaxUploadBytes(httpContext),
            Expiration = new SlidingExpiration(TimeSpan.FromHours(24)),   // an abandoned upload expires; TusCleanupService removes it
            Events = new()
            {
                OnAuthorizeAsync = eventContext =>
                {
                    if (eventContext.HttpContext.Request.Method == "OPTIONS")
                        return Task.CompletedTask;

                    if (!eventContext.HttpContext.User.IsSignedIn())
                    {
                        eventContext.FailRequest(HttpStatusCode.Unauthorized, "Authentication required");
                        return Task.CompletedTask;
                    }
                    // An upload in progress belongs to the person who created it. Anyone else's PATCH, HEAD or
                    // DELETE on its id gets 404. The owner is read from the id, so this holds after a restart too,
                    // and the person's client goes on with the upload.
                    if (eventContext.Intent is not (IntentType.CreateFile or IntentType.GetOptions)
                        && (eventContext.FileId is not { } fileId || !UploadIds.Owns(eventContext.HttpContext.User.Id(), fileId)))
                        eventContext.FailRequest(HttpStatusCode.NotFound, "File not found");
                    return Task.CompletedTask;
                },

                // Rejects doomed GIF-library creates before gigabytes flow. Advisory only — the
                // metadata is client-controlled, so OnFileComplete re-checks authoritatively.
                OnBeforeCreateAsync = eventContext =>
                {
                    string? Meta(string key) => eventContext.Metadata.TryGetValue(key, out var m)
                        ? m.GetString(System.Text.Encoding.UTF8) : null;

                    var kind = Meta("kind");
                    var target = Meta("target");
                    if (kind == "voice")
                    {
                        // The recording cannot be served as it is (VoiceService), so without ffmpeg the upload is doomed.
                        if (!VoiceService.IsAvailable) eventContext.FailRequest("Voice messages are unavailable on this server (ffmpeg missing)");
                        return Task.CompletedTask;
                    }
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
                        var userService = services.GetRequiredService<UserService>();
                        var user = CurrentUser(eventContext.HttpContext, userService);
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
                    var voiceService = eventContext.HttpContext.RequestServices.GetRequiredService<VoiceService>();
                    var mediaLog = eventContext.HttpContext.RequestServices.GetRequiredService<MediaUploadLogService>();
                    var userService = eventContext.HttpContext.RequestServices.GetRequiredService<UserService>();
                    var gifService = eventContext.HttpContext.RequestServices.GetRequiredService<GifService>();

                    var file = await eventContext.GetFileAsync();
                    // The result file of this upload, for GET /api/tus/info. Empty means "the server still works on
                    // the file"; it is written first, so the uploader's poll never finds a finished upload unknown.
                    var resultPath = Path.Combine(uploads.TusResults, file.Id + ".json");
                    File.WriteAllText(resultPath, "");
                    // What the uploader's GET /api/tus/info gets for this file. It is a file, not memory: the answer
                    // can be lost on the network and asked for again, also after a restart. TusCleanupService removes it.
                    void Done(object result) => File.WriteAllText(resultPath, JsonSerializer.Serialize(result, JsonSerializerOptions.Web));

                    // An error in the work below must end as a result too. Without one the result stays "still at work":
                    // the client waits for it, sends the file again, and does the same at each wake-up, one more copy each time.
                    try
                    {
                        var metadata = await file.GetMetadataAsync(eventContext.CancellationToken);

                        // Null when tus metadata carried no filename; originalFileName keeps the
                        // "unknown" placeholder for logging, but tag-seeding must not see it.
                        var uploadedFileName = metadata.TryGetValue("filename", out var fName)
                            ? fName.GetString(System.Text.Encoding.UTF8) : null;
                        var originalFileName = uploadedFileName ?? "unknown";
                        var extension = Path.GetExtension(originalFileName).ToLowerInvariant();
                        var kind = metadata.TryGetValue("kind", out var kindMeta)
                            ? kindMeta.GetString(System.Text.Encoding.UTF8) : null;
                        // Library uploads (GifLibraryManager) carry a destination; chat uploads don't.
                        var target = metadata.TryGetValue("target", out var targetMeta)
                            ? targetMeta.GetString(System.Text.Encoding.UTF8) : null;
                        var folder = metadata.TryGetValue("folder", out var folderMeta)
                            ? folderMeta.GetString(System.Text.Encoding.UTF8) : null;

                        var user = CurrentUser(eventContext.HttpContext, userService);

                        var tusFilePath = Path.Combine(tusStorePath, file.Id);
                        void CleanupTusMetadata()
                        {
                            foreach (var metaFile in Directory.GetFiles(tusStorePath, $"{file.Id}.*"))
                                try { File.Delete(metaFile); } catch { }
                        }

                        // Zip pack import. The archive must never reach the uploads folder — it would be
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
                                Done(new { type = "error", error = "Not allowed" });
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
                            Done(new { type = "gif-pack", importId });
                            return;
                        }

                        // A voice message (IB-70). The transcode reads the tus part itself and writes the .m4a into the
                        // uploads folder, so the raw recording, whose extension the client chose, is never a served file.
                        if (kind == "voice")
                        {
                            var voiceName = $"{Guid.NewGuid()}.m4a";
                            var voicePath = Path.Combine(uploads.Root, voiceName);
                            var voice = await voiceService.TranscodeAsync(tusFilePath, voicePath);
                            var rawSize = new FileInfo(tusFilePath).Length;
                            try { File.Delete(tusFilePath); } catch { }
                            CleanupTusMetadata();
                            if (voice is null)
                            {
                                logger.LogWarning("Voice message rejected: {FileName} ({Size}KB)", originalFileName, rawSize / 1024);
                                Done(new { type = "error", error = VoiceService.IsAvailable ? "Could not process this voice message" : "Voice messages are unavailable on this server (ffmpeg missing)" });
                                return;
                            }
                            if (user != null)
                                mediaLog.Log(user.Id, user.Username, originalFileName, voiceName, new FileInfo(voicePath).Length, "voice", ".m4a");
                            logger.LogDebug("Voice message accepted: {FileName} ({Duration}ms, {RawSize}KB recorded)", voiceName, voice.DurationMs, rawSize / 1024);
                            Done(new { type = "voice", url = $"/uploads/{voiceName}", durationMs = voice.DurationMs });
                            return;
                        }

                        // The extension alone decides, also for kind=gif: the file is served under it (uniqueFileName
                        // below), and both the kind and the file name come from the client. With `kind == "gif" ||` here,
                        // a "GIF" named x.html that failed the GIF check stayed in the uploads folder as a page of this site.
                        string type;
                        if (_imageExtensions.Contains(extension))
                            type = "image"; // Will be re-classified to gif below if applicable.
                        else if (VideoService.IsVideoFile(extension))
                            type = "video";
                        else
                        {
                            logger.LogWarning("Unsupported file type uploaded via tus: {Extension}", extension);
                            Done(new { type = "error", error = "Unsupported file type" });   // without it the result stays "still at work" until the sweep
                            return;
                        }

                        var uploadsFolder = uploads.Root;
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
                                    Done(new
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
                                        gifService.SetServerGif(gifAttachment.GifEntryId, isServer: true, folder);
                                    else
                                        gifService.SetFavorite(user.Id, gifAttachment.GifEntryId, favorite: true, folder);
                                }

                                Done(new
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
                                Done(new { type = "error", error = "Could not process this file as a GIF" });
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
                            var mediumMs = sw.ElapsedMilliseconds;

                            _ = Task.Run(async () =>
                            {
                                try
                                {
                                    var swLarge = System.Diagnostics.Stopwatch.StartNew();
                                    await imageService.GenerateLargeThumbnailAsync(filePath);
                                    swLarge.Stop();
                                    mediaLog.SetCompressDuration(uniqueFileName, mediumMs + swLarge.ElapsedMilliseconds);
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
                                            mediaLog.SetCompressDuration(uniqueFileName, durationMs);
                                    }
                                    catch (Exception ex)
                                    {
                                        logger.LogError(ex, "Error compressing video {FileName}", uniqueFileName);
                                    }
                                });
                            }
                        }

                        Done(new { url = $"/uploads/{uniqueFileName}", type });
                    }
                    catch (Exception ex)
                    {
                        logger.LogError(ex, "The work on the finished upload {FileId} failed", file.Id);
                        Done(new { type = "error", error = "Could not process this file" });
                    }
                }
            }
        }).RequireCors("TusUpload");

        // What a finished upload became, for the person who uploaded it: a guessed or leaked id must not hand someone
        // else's file over, and the server's own path stays on the server. Three answers: 200 with the result, as often
        // as it is asked for; 202 while the server still works on the file; 404 for an id that is not this person's or
        // that the server does not know, and then the client sends the file again. The 202 has no body on purpose: a
        // client from before these answers takes every 2xx for the result, and an empty body makes it ask again.
        app.MapGet("/api/tus/info/{fileId}", async (string fileId, ClaimsPrincipal me) =>
        {
            if (!UploadIds.Owns(me.Id(), fileId)) return Results.NotFound(new { error = "File not found" });   // also the check that makes the id safe as a file name
            try
            {
                // Shared with the writer: OnFileComplete may write the result at this moment, and its write must not fail.
                await using var stream = new FileStream(Path.Combine(uploads.TusResults, fileId + ".json"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream);
                var result = await reader.ReadToEndAsync();
                return result.Length == 0 ? Results.StatusCode(StatusCodes.Status202Accepted) : Results.Text(result, "application/json");
            }
            catch (IOException) { return Results.NotFound(new { error = "File not found" }); }   // no such file (FileNotFoundException and DirectoryNotFoundException are IOExceptions)
        }).RequireAuthorization().RequireCors("TusUpload");
    }

    /// <summary>
    /// Per-request upload ceiling. Zip pack imports get their own (much larger) cap than chat
    /// attachments — with a multi-GB library quota, the chat cap would be a wall. The kind is
    /// sniffed from the create POST's Upload-Metadata header ("gif-pack" base64-encoded), the
    /// only place it's visible before tusdotnet validates Upload-Length against this limit.
    /// </summary>
    // The TUS events run after UseAuthentication, so the principal is set; OnAuthorize already refused anonymous calls.
    private static User? CurrentUser(HttpContext http, UserService users) =>
        http.User.IsSignedIn() ? users.GetById(http.User.Id()) : null;

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
