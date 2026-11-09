using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Yap.Models.Chat;
using Yap.Services.Chat;
using Yap.Services.Media;

namespace Yap.Tests;

/// <summary>
/// Link cards stay with their rows: a good card is served whatever its age and never fetched again, survives
/// a restart as a file, and its picture is a small WebP on this server. A "restart" here is a second
/// LinkPreviewService on the same content root: it starts with empty memory, as the server does after a deploy.
/// </summary>
public class LinkCardTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public LinkCardTests(YapFactory app) => _app = app;

    private LinkPreviewService NewService() => new(_app.Service<IHttpClientFactory>(), NullLogger<LinkPreviewService>.Instance,
        _app.Service<IWebHostEnvironment>(), _app.Service<ImageService>());

    private static LinkPreview GoodCard(string url, DateTime fetchedAt) => new()
    {
        Url = url, Title = "A title", Description = "A description", SiteName = "A site",
        ImageUrl = "/media-cache/0123456789abcdef_card.webp", FetchedAt = fetchedAt,
    };

    private string CardFile(string url) => Path.Combine(_app.ContentRoot, "Data", "link-cards", $"{MediaCacheService.ComputeHash(url)}.json");

    private static async Task<T> EventuallyAsync<T>(Func<T?> probe) where T : class
    {
        for (var i = 0; i < 100; i++)
        {
            if (probe() is { } value) return value;
            await Task.Delay(100);
        }
        throw new TimeoutException("the background fetch did not finish in 10 s");
    }

    [Fact(DisplayName = "A card survives a restart")]
    public void Card_survives_restart()
    {
        const string url = "https://example.com/restart";
        var saved = GoodCard(url, new DateTime(2026, 11, 9, 8, 0, 0, DateTimeKind.Utc));
        NewService().SaveCard(saved);

        var loaded = NewService().GetCachedPreview(url);

        Assert.NotNull(loaded);
        Assert.Equal(saved.Title, loaded.Title);
        Assert.Equal(saved.Description, loaded.Description);
        Assert.Equal(saved.SiteName, loaded.SiteName);
        Assert.Equal(saved.ImageUrl, loaded.ImageUrl);
        Assert.Equal(saved.FetchedAt, loaded.FetchedAt);
    }

    [Fact(DisplayName = "A good card is never fetched again; a card without content is retried after an hour")]
    public void Only_empty_cards_are_fetched_again()
    {
        const string url = "https://example.com/old";
        NewService().SaveCard(GoodCard(url, DateTime.UtcNow.AddDays(-30)));

        var loaded = NewService().GetCachedPreview(url);

        Assert.NotNull(loaded);
        Assert.False(LinkPreviewService.NeedsFetch(loaded));
        Assert.True(LinkPreviewService.NeedsFetch(null));
        Assert.True(LinkPreviewService.NeedsFetch(new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow.AddHours(-2) }));
        Assert.False(LinkPreviewService.NeedsFetch(new LinkPreview { Url = url, Failed = true, FetchedAt = DateTime.UtcNow.AddMinutes(-30) }));
    }

    [Fact(DisplayName = "A queued fetch for a link with a good card reads no page and hands back the card")]
    public async Task Good_card_is_not_fetched()
    {
        const string url = "http://127.0.0.1/kept";   // a fetch would fail the SSRF check and leave a failed card
        NewService().SaveCard(GoodCard(url, DateTime.UtcNow.AddDays(-30)));
        var service = NewService();
        LinkPreview? handed = null;
        service.OnPreviewFetched = (_, _, card) => handed = card;

        service.QueueFetch(Guid.NewGuid(), url);
        await Task.Delay(500);   // time for a fetch, had one started

        Assert.Equal("A title", handed?.Title);
        Assert.Equal("A title", service.GetCachedPreview(url)?.Title);
    }

    [Fact(DisplayName = "A failed fetch with no old card writes no card file")]
    public async Task Failed_fetch_writes_nothing()
    {
        const string url = "http://127.0.0.1/never";
        var service = NewService();

        service.QueueFetch(Guid.NewGuid(), url);
        await EventuallyAsync(() => service.GetCachedPreview(url) is { Failed: true } p ? p : null);

        Assert.False(File.Exists(CardFile(url)));
        Assert.Null(NewService().GetCachedPreview(url));
    }

    [Theory(DisplayName = "A card picture becomes a WebP no larger than 640 px on either side, and a small picture keeps its size")]
    [InlineData(2000, 1000, 640, 320)]
    [InlineData(3000, 3000, 640, 640)]
    [InlineData(640, 2000, 205, 640)]   // one side already at the limit: the other must still shrink
    [InlineData(2000, 640, 640, 205)]
    [InlineData(100, 50, 100, 50)]      // never enlarged
    [InlineData(1, 1, 1, 1)]            // a tracking pixel stays a pixel
    public async Task Picture_becomes_small_webp(int width, int height, int outWidth, int outHeight)
    {
        var dir = Directory.CreateTempSubdirectory("yap-card-picture-test");
        try
        {
            using var png = new MemoryStream();
            using (var image = new Image<Rgba32>(width, height, new Rgba32(200, 100, 50, 255))) await image.SaveAsPngAsync(png);
            png.Position = 0;
            var path = Path.Combine(dir.FullName, "card.webp");

            Assert.True(await _app.Service<ImageService>().SaveWebpFitAsync(png, path, 640));
            var info = await Image.IdentifyAsync(path);
            Assert.Equal("Webp", info.Metadata.DecodedImageFormat?.Name);
            Assert.Equal((outWidth, outHeight), (info.Width, info.Height));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact(DisplayName = "Bytes that are no picture are refused")]
    public async Task Other_bytes_are_refused()
    {
        var dir = Directory.CreateTempSubdirectory("yap-card-picture-test");
        try
        {
            using var html = new MemoryStream("<html>not a picture</html>"u8.ToArray());
            Assert.False(await _app.Service<ImageService>().SaveWebpFitAsync(html, Path.Combine(dir.FullName, "no.webp"), 640));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact(DisplayName = "The picture name comes from the resolved URL, so two sites with the same relative og:image do not share a file")]
    public void Picture_name_uses_resolved_url()
    {
        var a = LinkPreviewService.ResolvePicture("https://a.example/post/1", "/og.png");
        var b = LinkPreviewService.ResolvePicture("https://b.example/post/1", "/og.png");

        Assert.Equal("https://a.example/og.png", a);
        Assert.Equal("https://b.example/og.png", b);
        Assert.NotEqual(MediaCacheService.ComputeHash(a!), MediaCacheService.ComputeHash(b!));
        Assert.Null(LinkPreviewService.ResolvePicture("https://a.example/", "javascript:alert(1)"));
        Assert.Null(LinkPreviewService.ResolvePicture("https://a.example/post", ""));    // content="" was no picture before
        Assert.Null(LinkPreviewService.ResolvePicture("https://a.example/post", "#"));   // the page itself is no picture
    }
}
