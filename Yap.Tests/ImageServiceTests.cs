using Microsoft.Extensions.DependencyInjection;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Yap.Services.Media;

namespace Yap.Tests;

/// <summary>
/// The thumbnail pipeline on this machine: one decode, one resize, two WebP encodes. Runs the same code an
/// upload runs, outside the web server, so a machine-specific failure shows here first.
/// </summary>
public class ImageServiceTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public ImageServiceTests(YapFactory app) => _app = app;

    [Fact(DisplayName = "An uploaded picture gets its 800 px and 1600 px WebP thumbnails")]
    public async Task Thumbnails_are_written_next_to_the_picture()
    {
        var dir = Directory.CreateTempSubdirectory("yap-image-test");
        try
        {
            // Noise, so the PNG stays over 500 KB and the resize path runs, not the plain conversion of small files.
            var path = Path.Combine(dir.FullName, "picture.png");
            var noise = new Random(1);
            using (var image = new Image<Rgba32>(1700, 1300))
            {
                image.ProcessPixelRows(rows =>
                {
                    for (var y = 0; y < rows.Height; y++)
                    {
                        var row = rows.GetRowSpan(y);
                        for (var x = 0; x < row.Length; x++) row[x] = new Rgba32((byte)noise.Next(256), (byte)noise.Next(256), (byte)noise.Next(256), 255);
                    }
                });
                await image.SaveAsPngAsync(path);
            }
            Assert.True(new FileInfo(path).Length > 500 * 1024, "the test picture must be large enough to be resized");

            var service = _app.Services.GetRequiredService<ImageService>();
            await service.GenerateMediumThumbnailAsync(path);
            await service.GenerateLargeThumbnailAsync(path);

            using var medium = await Image.LoadAsync(Path.Combine(dir.FullName, "picture_800px.webp"));
            Assert.Equal(800, medium.Width);
            using var large = await Image.LoadAsync(Path.Combine(dir.FullName, "picture_1600px.webp"));
            Assert.Equal(1600, large.Width);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact(DisplayName = "SH-48: the large URL of an old pin's medium URL follows the naming rule; another URL has none")]
    public void Large_url_of_a_medium_url()
    {
        Assert.Equal(ImageService.GetLargeUrl("/uploads/a.b.jpg"), ImageService.LargeOfMedium(ImageService.GetMediumUrl("/uploads/a.b.jpg")));
        Assert.Null(ImageService.LargeOfMedium("/uploads/gifs/cat.gif"));   // an image-file GIF of an old pin
    }
}
