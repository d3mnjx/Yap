using System.Text.RegularExpressions;
using Yap.Endpoints;
using Yap.Middleware;
using Yap.Models;
using Yap.Services;
using Yap.Services.Gifs;

namespace Yap.Offline;

/// <summary>
/// Adapts emoji, GIF and completed-upload services for the chat API and resolves account-owned
/// media for message acceptance.
/// </summary>
public static class OfflineContent
{
    // Every route is registered on OfflineEndpoints' authenticated/antiforgery-filtered group.
    private static User CurrentUser(HttpContext http) => http.RequestServices
        .GetRequiredService<UserService>()
        .AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
    public static object Gif(GifEntry e, GifService gifs, Guid user, string? uploader = null) => new
    {
        e.Id,
        e.Width,
        e.Height,
        url = e.GifUrl ?? e.RemoteGifUrl ?? e.Mp4Url ?? e.WebmUrl ?? e.RemoteMp4Url ?? e.RemoteWebmUrl,
        preview = e.PreviewUrl ?? e.GifUrl ?? e.RemoteGifUrl ?? e.WebmUrl ?? e.Mp4Url ?? e.RemoteMp4Url,
        uploader,
        e.ServerFolder,
        title = string.Join(" ", gifs.GetTags(e)),
        favorite = gifs.IsFavorite(user, e.Id),
        e.UploadedByUserId
    };
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/catalog", GetCatalog);
        api.MapPost("/emoji/recent", (HttpContext http, RecentRequest request, UserService users) =>
        {
            users.UpdateRecentEmojis(CurrentUser(http).Id, request.Values.Where(v => v.Length <= 100).Distinct().Take(20).ToList());
            return Results.Ok(new
            {
            });
        });
        api.MapGet("/uploads/{uploadId}", (string uploadId, HttpContext http, IWebHostEnvironment env) =>
        {
            var result = TusEndpoints.Completed(env, CurrentUser(http).Id, uploadId);
            return result is null ? Results.NotFound() : Results.Ok(result);
        });
        api.MapGet("/gifs/library", GetLibrary);
        api.MapGet("/gifs", SearchGifs);
        api.MapGet("/gifs/categories", async (GifService gifs, HttpContext http) => Results.Ok(await gifs.GetCategoriesAsync(http.RequestAborted)));
        api.MapPost("/gifs/favorite", async (HttpContext http, FavoriteRequest request, GifService gifs) => Results.Ok(new { favorite = await gifs.SetFavoriteAsync(CurrentUser(http).Id, request.Id, request.Active) }));
        api.MapPost("/gifs/select", SelectProviderGif);
    }

    private static async Task<IResult> GetCatalog(
        HttpContext http,
        EmojiService emoji,
        CustomEmojiService custom,
        UserService users,
        ChatService chat,
        IConfiguration config)
    {
        var user = CurrentUser(http);
        string Source(string value) => Regex.Match(emoji.GetEmojiHtml(value).Value, "src=\"([^\"]+)\"").Groups[1].Value;
        var categories = custom.Packs.Select(p => new
        {
            key = p.Key,
            name = p.DisplayName,
            icon = p.Emojis[0].Url,
            items = p.Emojis.Select(e => new { value = $":{e.Shortcode}:", keywords = e.Keywords, src = e.Url }).ToArray()
        }).Concat(
            EmojiData.Categories.Select(c => new
            {
                key = c.Key,
                name = c.Key,
                icon = Source(c.Value.Icon),
                items = c.Value.Emojis.Select(e => new { value = e, keywords = EmojiData.EmojiKeywords.GetValueOrDefault(e) ?? "", src = Source(e) }).ToArray()
            }));
        var quick = await chat.GetTopReactionEmojisAsync(user.Id, 3);
        foreach (var fallback in new[] { "❤️", "😂", "👍" })
        {
            if (quick.Count < 3 && !quick.Contains(fallback))
                quick.Add(fallback);
        }
        return Results.Ok(new
        {
            categories,
            recent = users.GetRecentEmojis(user.Username),
            quick,
            labels = new
            {
                roomHeaders = config.GetSection("ChatSettings:FunnyTexts:RoomHeaders").Get<string[]>() ?? ["# {0}"],
                messagePlaceholders = config.GetSection("ChatSettings:FunnyTexts:MessagePlaceholders").Get<string[]>() ?? ["Type a message..."]
            },
            uploadEndpoint = config["ChatSettings:UploadUrl"] ?? "/api/tus",
            maxUploadBytes = (long)config.GetValue("ChatSettings:MaxUploadSizeMB", 100) * 1024 * 1024
        });
    }

    private static IResult GetLibrary(
        HttpContext http,
        GifService gifs,
        UserService users,
        ChatConfigService config)
    {
        var user = CurrentUser(http);
        object Item(GifEntry entry) => Gif(entry, gifs, user.Id, users.GetById(entry.UploadedByUserId ?? Guid.Empty)?.Username);
        return Results.Ok(new
        {
            recent = gifs.GetRecents(user.Username).Select(Item),
            favorites = gifs.GetFavorites(user.Id).Select(Item),
            server = gifs.GetServerGifs().Select(Item),
            favoriteFolders = gifs.GetFavoriteFolders(user.Id),
            favoriteFolderMap = gifs.GetFavoriteFolderMap(user.Id),
            serverFolders = gifs.GetServerFolders(),
            configured = gifs.IsConfigured,
            provider = gifs.Provider.DisplayName,
            attribution = gifs.Provider.AttributionImageUrl,
            projectName = config.ProjectName
        });
    }

    private static async Task<IResult> SearchGifs(
        HttpContext http,
        GifService gifs,
        UserService users,
        string? mode,
        string? q,
        string? cursor,
        string? folder)
    {
        var user = CurrentUser(http);
        var query = q ?? "";
        var local = mode switch
        {
            "favorites" => gifs.GetFavorites(user.Id),
            "recent" => gifs.GetRecents(user.Username),
            "server" => gifs.GetServerGifs(folder),
            "trending" => new List<GifEntry>(),
            _ => gifs.SearchLocal(query, user.Id)
        };
        if (query.Length > 0 && mode is "favorites" or "recent" or "server")
            local = local.Where(e => string.Join(" ", gifs.GetTags(e)).Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        GifSearchResult? remote = null;
        string? error = null;
        if (gifs.IsConfigured && (mode is "trending" or "search"))
        {
            try
            {
                remote = mode == "trending" ? await gifs.GetTrendingAsync(cursor, 30, http.RequestAborted) : await gifs.SearchProviderAsync(query, cursor, 30, http.RequestAborted);
            }
            catch
            {
                error = "GIF provider is unavailable. Try again.";
            }
        }
        return Results.Ok(new
        {
            items = local.Select(e => Gif(e, gifs, user.Id, users.GetById(e.UploadedByUserId ?? Guid.Empty)?.Username)),
            remote,
            configured = gifs.IsConfigured,
            provider = gifs.Provider.DisplayName,
            attribution = gifs.Provider.AttributionImageUrl,
            error,
            folders = gifs.GetServerFolders()
        });
    }

    private static async Task<IResult> SelectProviderGif(
        HttpContext http,
        ProviderRequest request,
        GifService gifs)
    {
        // Re-fetch from the configured provider; never let an arbitrary client URL enter server downloads.
        var page = string.IsNullOrEmpty(request.Query) ? await gifs.GetTrendingAsync(request.Cursor, 50, http.RequestAborted) : await gifs.SearchProviderAsync(request.Query, request.Cursor, 50, http.RequestAborted);
        var item = page.Items.FirstOrDefault(i => i.SourceId == request.SourceId);
        if (item == null)
            return Results.NotFound(new
            {
                error = "That GIF is not available anymore. Try another one."
            });
        var user = CurrentUser(http);
        var attachment = await gifs.SendProviderGifAsync(item, request.Query, user.Id, user.Username);
        return attachment == null ? Results.NotFound() : Results.Ok(new
        {
            id = attachment.GifEntryId
        });
    }

    /// <summary>
    /// The client's recent emoji selections to persist for the authenticated account.
    /// </summary>
    public record RecentRequest(string[] Values);
    /// <summary>
    /// The desired favorite membership of a GIF, so the request does not depend on toggling prior
    /// state.
    /// </summary>
    public record FavoriteRequest(Guid Id, bool Active);
    /// <summary>
    /// Identifies a GIF within a provider result page so the server can re-fetch trusted media
    /// metadata.
    /// </summary>
    public record ProviderRequest(string SourceId, string? Query, string? Cursor);
    public static async Task<(List<string>? Images, List<string>? Videos, List<GifAttachment>? Gifs)> ResolveMedia(HttpContext http, User user, string[]? uploads, Guid? gifId)
    {
        if ((uploads?.Length ?? 0) > 20)
            throw new ChatSendException(400, "invalid_media", "Too many attachments.");
        List<string> images = new(), videos = new();
        List<GifAttachment> attachments = new();
        var gifs = http.RequestServices.GetRequiredService<GifService>();
        foreach (var id in uploads ?? [])
        {
            var result = TusEndpoints.Completed(http.RequestServices.GetRequiredService<IWebHostEnvironment>(), user.Id, id);
            if (result is not { } value)
                throw new ChatSendException(400, "upload_unavailable", "Upload is not complete for this account.");
            var type = value.GetProperty("type").GetString();
            if (type == "image")
                images.Add(value.GetProperty("url").GetString()!);
            else if (type == "video")
                videos.Add(value.GetProperty("url").GetString()!);
            else if (type == "gif")
                attachments.Add(new GifAttachment(value.GetProperty("gifEntryId").GetGuid(), value.GetProperty("width").GetInt32(), value.GetProperty("height").GetInt32()));
            else
                throw new ChatSendException(400, "upload_failed", "This file could not be processed.");
        }
        if (gifId is { } selected)
        {
            var attachment = await gifs.SendCachedGifAsync(selected, null, user.Id, user.Username);
            if (attachment == null)
                throw new ChatSendException(404, "gif_unavailable", "This GIF is unavailable.");
            attachments.Add(attachment);
        }
        return (images.Count > 0 ? images : null, videos.Count > 0 ? videos : null, attachments.Count > 0 ? attachments : null);
    }
}
