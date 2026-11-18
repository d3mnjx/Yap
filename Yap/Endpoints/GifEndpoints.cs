using System.Security.Claims;
using Microsoft.AspNetCore.Http.Features;
using Yap.Models.Gifs;
using Yap.Services.Accounts;
using Yap.Services.Gifs;

namespace Yap.Endpoints;

/// <summary>
/// The GIF picker's tabs and search (PK-13 to PK-37), the star, and the person's library in Settings (ST-21 to
/// ST-24). Uploads go through the TUS endpoint; the server library's management is on the admin API.
/// </summary>
public static class GifEndpoints
{
    private const int ProviderPage = 30;   // PK-28

    public static void MapGifs(this RouteGroupBuilder api)
    {
        var gifs = api.MapGroup("/gifs");

        gifs.MapGet("/recent", (ClaimsPrincipal me, GifService lib, UserService users) =>
            Results.Ok(lib.GetRecents(me.Username()).Select(e => Card(e, me.Id(), lib, users)).ToList()));   // PK-16

        gifs.MapGet("/favorites", (ClaimsPrincipal me, GifService lib, UserService users) =>
            Results.Ok(new FolderedDto(lib.GetFavoriteFolders(me.Id()), lib.GetFavorites(me.Id()).Select(e => Card(e, me.Id(), lib, users)).ToList())));   // PK-32

        gifs.MapGet("/server", (ClaimsPrincipal me, GifService lib, UserService users) =>
            Results.Ok(new FolderedDto(lib.GetServerFolders(), lib.GetServerGifs().Select(e => Card(e, me.Id(), lib, users)).ToList())));   // PK-37

        gifs.MapGet("/trending", async (string? cursor, GifService lib, CancellationToken ct) =>   // PK-18: the Browse grid
        {
            if (!lib.IsConfigured) return Results.Problem("No GIF provider is configured.", statusCode: 404);
            var page = await lib.GetTrendingAsync(cursor, ProviderPage, ct);
            return Results.Ok(new ProviderPageDto(page.Items, page.NextCursor));
        });

        // Library hits first, then the provider's (PK-24). Without a provider the second list is empty (PK-29).
        gifs.MapGet("/search", async (string q, string? cursor, ClaimsPrincipal me, GifService lib, UserService users, CancellationToken ct) =>
        {
            q = q.Trim();
            if (q.Length == 0) return Results.Problem("Type something to search.", statusCode: 400);
            var library = cursor is null ? lib.SearchLocal(q, me.Id()).Select(e => Card(e, me.Id(), lib, users)).ToList() : [];
            GifSearchResult provider = new([], null);
            if (lib.IsConfigured)
            {
                try { provider = await lib.SearchProviderAsync(q, cursor, ProviderPage, ct); }
                catch (Exception) { /* PK-31: no provider section and no error when the provider does not answer */ }
            }
            return Results.Ok(new SearchDto(library, provider.Items, provider.NextCursor));
        });

        gifs.MapPut("/{id:guid}/favorite", (Guid id, FavoriteRequest body, ClaimsPrincipal me, GifService lib) =>   // PK-21, PK-34
        {
            if (lib.GetEntry(id) is not { } entry || !lib.CanUse(entry, me.Id())) return Results.Problem("GIF unavailable", statusCode: 404);   // an id alone is no right to the entry
            if (body.On && body.Folder is not null) lib.SetFavoriteFolder(me.Id(), id, body.Folder);
            else lib.SetFavorite(me.Id(), id, body.On);
            return Results.NoContent();
        });

        gifs.MapPut("/{id:guid}/tags", (Guid id, TagsRequest body, ClaimsPrincipal me, GifService lib) =>   // ST-23, PK-27: the uploader or the admin
            lib.SetTags(me.Id(), id, body.Tags) ? Results.NoContent() : Results.Problem("GIF unavailable", statusCode: 404));

        gifs.MapDelete("/{id:guid}", (Guid id, ClaimsPrincipal me, GifService lib) => lib.DeleteEntry(me.Id(), id, force: false) switch   // ST-24
        {
            GifDeleteResult.Deleted or GifDeleteResult.SoftDeleted => Results.NoContent(),
            GifDeleteResult.UnstarredOnly => Results.Ok(new { note = "Still used in chat or by others — removed from your library instead." }),
            GifDeleteResult.NotAllowed => Results.Problem("You can only delete your own uploads.", statusCode: 403),
            _ => Results.Problem("GIF unavailable", statusCode: 404),
        });

        // My GIFs in Settings: every starred GIF plus the person's uploads, with folders and the quota (ST-21).
        gifs.MapGet("/library", (ClaimsPrincipal me, GifService lib, UserService users) =>
            Results.Ok(new LibraryDto(lib.GetFavoriteFolders(me.Id()), lib.GetFavorites(me.Id()).Select(e => Card(e, me.Id(), lib, users)).ToList(),
                lib.GetUserLibraryBytes(me.Id()), lib.UserQuotaBytes)));

        gifs.MapGet("/export", (HttpContext ctx, ClaimsPrincipal me, GifService lib) => StreamPackAsync(ctx, lib, me.Id(), "yap-my-gifs.zip"));   // ST-22
    }

    /// <summary>One card: the preview for the grid, the file for a send, the star for this person, the folder and tags.</summary>
    public static GifCardDto Card(GifEntry e, Guid viewerId, GifService lib, UserService users)
    {
        var favorite = lib.TryGetFavorite(viewerId, e.Id, out var folder);
        return new GifCardDto(e.Id, e.PreviewUrl ?? e.Src, e.Src, e.SrcIsImage, e.Width, e.Height, favorite,
            folder, lib.GetTags(e), e.IsServerGif, e.ServerFolder,
            e.UploadedByUserId is { } uid ? users.GetById(uid)?.Username : null, e.UploadedByUserId == viewerId, e.FileSizeBytes);
    }

    /// <summary>Streams the zip straight onto the response. The zip writer makes a few synchronous writes, so sync I/O
    /// is allowed for this response.</summary>
    public static async Task StreamPackAsync(HttpContext ctx, GifService lib, Guid? userId, string fileName)
    {
        if (ctx.Features.Get<IHttpBodyControlFeature>() is { } body) body.AllowSynchronousIO = true;
        ctx.Response.ContentType = "application/zip";
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{fileName}\"";
        await lib.WritePackAsync(ctx.Response.Body, userId, ctx.RequestAborted);
    }
}

public sealed record GifCardDto(Guid Id, string? Preview, string? Src, bool IsImage, int Width, int Height, bool Favorite, string? Folder,
    List<string> Tags, bool IsServer, string? ServerFolder, string? Uploader, bool Mine, long SizeBytes);

public sealed record FolderedDto(List<string> Folders, List<GifCardDto> Gifs);

public sealed record ProviderPageDto(List<GifSearchItem> Items, string? NextCursor);

public sealed record SearchDto(List<GifCardDto> Library, List<GifSearchItem> Provider, string? NextCursor);

public sealed record LibraryDto(List<string> Folders, List<GifCardDto> Gifs, long UsedBytes, long QuotaBytes);

public sealed record FavoriteRequest(bool On, string? Folder);

public sealed record TagsRequest(List<string> Tags);
