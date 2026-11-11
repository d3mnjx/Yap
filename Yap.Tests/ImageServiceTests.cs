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

    [Fact(DisplayName = "A thumbnail keeps the size of a small file and of a narrow picture, up to 16 MP")]
    public void Thumbnail_width_has_a_pixel_limit()
    {
        Assert.Equal(800, ImageService.ThumbnailWidth(1700, 1300, ImageService.SizeMedium, smallFile: false));     // a photo
        Assert.Equal(1920, ImageService.ThumbnailWidth(1920, 1080, ImageService.SizeMedium, smallFile: true));     // a small screenshot keeps its size
        Assert.Equal(1080, ImageService.ThumbnailWidth(1080, 10000, ImageService.SizeLarge, smallFile: false));    // a long screenshot, 11 MP
        // One colour: 300 KB on disk. Before the limit the "thumbnail" was the whole picture, 100 MP, encoded again.
        Assert.Equal(4000, ImageService.ThumbnailWidth(10000, 10000, ImageService.SizeMedium, smallFile: true));
        // Not square, and over the limit: 8000 x 4000 keeps its shape at 16 MP.
        var width = ImageService.ThumbnailWidth(8000, 4000, ImageService.SizeMedium, smallFile: true);
        Assert.InRange((long)width * (4000L * width / 8000), 15_900_000, 16_000_000);
    }

    [Fact(DisplayName = "No side of a thumbnail is longer than WebP can hold (16383 px)")]
    public void Thumbnail_width_keeps_both_sides_within_webp()
    {
        // Narrow and very tall: no wider than the thumbnail, so it was never made smaller, and the encoder refused it.
        // The height follows the width: 60000 x 218 / 800 = 16350.
        Assert.Equal(218, ImageService.ThumbnailWidth(800, 60000, ImageService.SizeMedium, smallFile: false));
        // A long screenshot. 21.6 MP gave 929 x 17204 with the pixel limit alone.
        var width = ImageService.ThumbnailWidth(1080, 20000, ImageService.SizeLarge, smallFile: false);
        Assert.InRange(20000 * width / 1080, 16000, 16383);
        // A small file keeps its width, and that side has the same limit.
        Assert.Equal(16383, ImageService.ThumbnailWidth(20000, 100, ImageService.SizeMedium, smallFile: true));
    }

    [Fact(DisplayName = "A very tall picture gets its thumbnails")]
    public async Task A_very_tall_picture_gets_its_thumbnails()
    {
        var dir = Directory.CreateTempSubdirectory("yap-image-test");
        try
        {
            // One colour, 300 x 20000: 6 MP, a small file. Before the limit of the sides the thumbnail was the picture
            // in its own size, the WebP encoder threw at 20000 px, and the row had no picture.
            var path = Path.Combine(dir.FullName, "tall.png");
            using (var image = new Image<L8>(300, 20000)) await image.SaveAsPngAsync(path);

            var service = _app.Services.GetRequiredService<ImageService>();
            await service.GenerateMediumThumbnailAsync(path);
            await service.GenerateLargeThumbnailAsync(path);

            foreach (var name in new[] { "tall_800px.webp", "tall_1600px.webp" })
            {
                var info = await Image.IdentifyAsync(Path.Combine(dir.FullName, name));
                Assert.InRange(info.Height, 16000, 16383);
                Assert.Equal(300.0 / 20000, (double)info.Width / info.Height, 3);   // the shape of the picture
            }
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact(DisplayName = "Of a file with pages (TIFF) only the first page is decoded: the pixel limit knows only its size")]
    public async Task Only_the_first_page_of_a_tiff_is_decoded()
    {
        var dir = Directory.CreateTempSubdirectory("yap-image-test");
        try
        {
            // The name of a picture, the bytes of a TIFF with two pages: 10 x 10, then 400 x 400. The header gives the
            // size of the first page, and the pixel limit counted the frames by it. A second page of 20000 x 20000
            // was within that count, and the decoder reads each page whole before it compares their sizes.
            var path = Path.Combine(dir.FullName, "pages.png");
            await File.WriteAllBytesAsync(path, TwoPageTiff(10, 10, 400, 400));
            Assert.Equal(new Size(10, 10), (await Image.IdentifyAsync(path)).Size);
            // The premise: with every page allowed, the decoder reads both and then refuses the file for their sizes
            // ("not supported"; a broken file is an ImageFormatException).
            await Assert.ThrowsAsync<NotSupportedException>(() => Image.LoadAsync(path));

            await _app.Services.GetRequiredService<ImageService>().GenerateMediumThumbnailAsync(path);

            // A thumbnail exists, so the decode stopped after the first page: with the second one it throws (above).
            using var thumbnail = await Image.LoadAsync(Path.Combine(dir.FullName, "pages_800px.webp"));
            Assert.Equal(new Size(10, 10), thumbnail.Size);
        }
        finally { dir.Delete(recursive: true); }
    }

    /// <summary>A TIFF of two grey pages, not compressed, little-endian: the header, then for each page its pixels
    /// and its directory of nine entries. ImageSharp cannot write this file, its frames all have one size.</summary>
    private static byte[] TwoPageTiff(int width1, int height1, int width2, int height2)
    {
        const int DirectorySize = 2 + 9 * 12 + 4;
        var pixels1 = 8;                                            // after the header
        var directory1 = pixels1 + width1 * height1;
        var pixels2 = directory1 + DirectorySize;
        var directory2 = pixels2 + width2 * height2;
        using var stream = new MemoryStream();
        using var file = new BinaryWriter(stream);                  // little-endian, as the "II" of the header says
        file.Write("II"u8); file.Write((ushort)42); file.Write((uint)directory1);

        void Page(int pixels, int width, int height, int next)
        {
            file.Write(new byte[width * height]);                   // black
            void Entry(ushort tag, ushort type, int value) { file.Write(tag); file.Write(type); file.Write((uint)1); file.Write((uint)value); }
            const ushort Short = 3, Long = 4;
            file.Write((ushort)9);
            Entry(256, Long, width);                                // ImageWidth
            Entry(257, Long, height);                               // ImageLength
            Entry(258, Short, 8);                                   // BitsPerSample
            Entry(259, Short, 1);                                   // Compression: none
            Entry(262, Short, 1);                                   // PhotometricInterpretation: black is zero
            Entry(273, Long, pixels);                               // StripOffsets: where this page's pixels start
            Entry(277, Short, 1);                                   // SamplesPerPixel
            Entry(278, Long, height);                               // RowsPerStrip: one strip
            Entry(279, Long, width * height);                       // StripByteCounts
            file.Write((uint)next);
        }
        Page(pixels1, width1, height1, directory2);
        Page(pixels2, width2, height2, 0);
        file.Flush();
        return stream.ToArray();
    }

    [Fact(DisplayName = "SH-48: the large URL of an old pin's medium URL follows the naming rule; another URL has none")]
    public void Large_url_of_a_medium_url()
    {
        Assert.Equal(ImageService.GetLargeUrl("/uploads/a.b.jpg"), ImageService.LargeOfMedium(ImageService.GetMediumUrl("/uploads/a.b.jpg")));
        Assert.Null(ImageService.LargeOfMedium("/uploads/gifs/cat.gif"));   // an image-file GIF of an old pin
    }
}
