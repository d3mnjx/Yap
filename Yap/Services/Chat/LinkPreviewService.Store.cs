using System.Text.Json;
using Yap.Models.Chat;

namespace Yap.Services.Chat;

/// <summary>
/// The disk side of the link cards. Memory stays the truth (<see cref="_cache"/>); a copy of each good card goes to
/// <c>Data/link-cards/</c> so a restart does not take every card off every row and scrape every link again. The
/// card's picture is copied to <c>Data/media-cache/</c> and served from this origin, so a reader's browser does not
/// open a connection to the remote site (a tracking pixel for everyone who reads the room, and about 3 round trips).
/// Files only: no database, so both persistence modes keep their cards. Nothing deletes these files yet, the same
/// as the rest of the media cache, and pins hold the picture URL.
/// </summary>
public partial class LinkPreviewService
{
    private const long MaxPictureBytes = 5 * 1024 * 1024;
    private static readonly TimeSpan PictureTimeout = TimeSpan.FromSeconds(10);
    // The plain card box is 80 px; 640 px also covers the pin panel and the video poster fallback, which use ImageUrl.
    private const int PictureMaxSide = 640;
    // At most two card pictures are downloaded and decoded at once. Without it, every fetch of a lobby open after a
    // deploy (up to 250) holds its whole download (up to 5 MB) in memory while it waits on ImageService's one-at-a-time
    // gate, and an upload's thumbnail waits behind all of them. The cost is that cards of a first open arrive over a
    // longer time; later opens find the cards and pictures on disk.
    private static readonly SemaphoreSlim PictureSlots = new(2, 2);

    // Not under Data/media-cache: that folder is served as static files, and a card holds a URL someone posted,
    // maybe in a DM.
    private string CardDirectory => Path.Combine(_env.ContentRootPath, "Data", "link-cards");
    private string PictureDirectory => Path.Combine(_env.ContentRootPath, "Data", "media-cache");
    private string CardPath(string url) => Path.Combine(CardDirectory, $"{MediaCacheService.ComputeHash(url)}.json");

    // The media fields are left out on purpose: the mapper attaches them from the media cache, which is on disk already.
    private sealed record StoredCard(string Url, string? Title, string? Description, string? SiteName, string? ImageUrl, DateTime FetchedAt);

    /// <summary>
    /// Plain write, no temp file: the fetch puts the card in memory first and the disk is read only on a memory
    /// miss, <c>_inFlight</c> allows one writer per URL, and <see cref="LoadCard"/> treats a torn file as missing.
    /// </summary>
    internal void SaveCard(LinkPreview p)
    {
        try
        {
            var card = new StoredCard(p.Url, p.Title, p.Description, p.SiteName, p.ImageUrl, p.FetchedAt);
            File.WriteAllText(CardPath(p.Url), JsonSerializer.Serialize(card));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not save the link card of {Url}", p.Url);
        }
    }

    private LinkPreview? LoadCard(string url)
    {
        try
        {
            var path = CardPath(url);
            if (!File.Exists(path)) return null;
            var card = JsonSerializer.Deserialize<StoredCard>(File.ReadAllText(path));
            // The file name is a 64-bit hash: the URL inside says whether the file belongs to this link.
            if (card is null || card.Url != url) return null;
            var preview = new LinkPreview
            {
                Url = url, Title = card.Title, Description = card.Description, SiteName = card.SiteName,
                ImageUrl = card.ImageUrl, FetchedAt = card.FetchedAt,
            };
            return preview.HasContent ? preview : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// The card picture as a URL on this server, or the remote URL when the copy fails (the card keeps a picture,
    /// as before this copy existed), or null when the og:image is no http(s) URL.
    /// </summary>
    internal async Task<string?> LocalPictureAsync(string pageUrl, string ogImage)
    {
        if (ResolvePicture(pageUrl, ogImage) is not { } remote) return null;

        // Named by the resolved URL, never the raw attribute: two sites with the same relative "/og.png" must not
        // share a file, or one page could put its picture on the other site's cards. The file is written once and
        // never overwritten, which keeps the immutable cache headers of /media-cache/ true; an unchanged og:image
        // on a refetch finds its file and downloads nothing.
        var name = $"{MediaCacheService.ComputeHash(remote)}_card.webp";
        var path = Path.Combine(PictureDirectory, name);
        if (File.Exists(path)) return $"/media-cache/{name}";

        var temp = Path.Combine(PictureDirectory, $"{name}.{Guid.NewGuid():N}.tmp");
        await PictureSlots.WaitAsync();
        try
        {
            using var timeout = new CancellationTokenSource(PictureTimeout);
            using var bytes = await DownloadPictureAsync(remote, timeout.Token);
            if (bytes is null || !await _images.SaveWebpFitAsync(bytes, temp, PictureMaxSide)) return remote;
            // Temp file, then move: a reader never gets half of a file the browser then keeps for good.
            File.Move(temp, path, overwrite: true);
            return $"/media-cache/{name}";
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not copy the card picture {Picture}", remote);
            return remote;
        }
        finally
        {
            PictureSlots.Release();
            File.Delete(temp);   // no-op after the move or when nothing was written
        }
    }

    /// <summary>
    /// A relative og:image is resolved against the page; only http(s) is kept. An empty value or "#" resolves to the
    /// page itself, which is no picture: it gave no thumbnail before this resolve existed, and must not now make every
    /// reader load the page as an image.
    /// </summary>
    internal static string? ResolvePicture(string pageUrl, string ogImage)
    {
        if (string.IsNullOrWhiteSpace(ogImage)) return null;
        var page = new Uri(pageUrl);
        if (!Uri.TryCreate(page, ogImage, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return null;
        return uri.GetLeftPart(UriPartial.Query) == page.GetLeftPart(UriPartial.Query) ? null : uri.AbsoluteUri;
    }

    /// <summary>
    /// The picture's bytes, or null for an error status or a file over the cap. The bytes are counted while they are
    /// read (a chunked response has no length), and the token covers the body reads too: with ResponseHeadersRead
    /// the client's own timeout ends at the headers.
    /// </summary>
    private async Task<MemoryStream?> DownloadPictureAsync(string url, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient("MediaFetch");   // SSRF-guarded: public addresses only, every redirect hop checked
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxPictureBytes) return null;

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var bytes = new MemoryStream();
        var chunk = new byte[64 * 1024];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (bytes.Length + read > MaxPictureBytes) { bytes.Dispose(); return null; }
            bytes.Write(chunk, 0, read);
        }
        bytes.Position = 0;
        return bytes;
    }
}
