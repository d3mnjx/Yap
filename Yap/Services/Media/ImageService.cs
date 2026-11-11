using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Gif;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Yap.Services.Media;

/// <summary>
/// - Generates WebP thumbnails on upload at two sizes: 800px (gallery) and 1600px (lightbox)
/// - Uses SixLabors.ImageSharp for cross-platform image processing
/// - Smart resampling: Lanczos3 for photos, Box for screenshots/graphics
/// - A small file (<500KB) keeps its size and is only converted to WebP, within the limits of ThumbnailWidth
/// - Auto-orients images based on EXIF data
/// </summary>
public class ImageService
{
    // Available sizes for different use cases
    public const int SizeMedium = 800;  // Gallery and single image preview
    public const int SizeLarge = 1600;  // Lightbox (caps very large uploads)

    // All thumbnails are WebP for best compression
    private static readonly WebpEncoder WebpEncoder = new() { Quality = 90 };

    // Skip processing for small files (already optimized)
    private const int SmallFileThreshold = 500 * 1024; // 500 KB

    // One decode at a time. A message with several pictures completes its uploads together, and four
    // concurrent decodes of 1500 px images took the process down on a Windows dev machine (2026-10-15)
    // while the same files passed one after another. The wait is a few hundred ms per picture.
    private static readonly SemaphoreSlim Gate = new(1, 1);

    // A picture that a person uploads is decoded whole for its thumbnails and for a profile picture, at 4 bytes a
    // pixel or more, and the size of the file says nothing about the pixels: a PNG of one colour, 10000 x 10000, is
    // 300 KB on disk and took 2 GB of memory (measured 2026-11-11). 50 MP lets the full photo of a 50 MP phone
    // camera through (8160 x 6120). An upload is refused by the pixels of one frame (OverMaxPixelsAsync). A decode
    // counts all frames of an animation together and reads the ones that fit (WithinMaxPixels).
    public const long MaxPixels = 50_000_000;
    // A thumbnail keeps the size of a small file and the height of a tall picture (SaveThumbnailAsync), and the WebP
    // encoder needs several times the memory of the decode. Far above every real case: a screenshot of 1080 x 10000
    // has 11 MP, a 4K screenshot 8 MP.
    private const long MaxThumbnailPixels = 16_000_000;
    // The longest side that the WebP format can hold. The encoder throws above it, and the picture then has no
    // thumbnail at all: a screenshot of 1080 x 20000 is within every pixel limit here and lost its thumbnails this way.
    private const int MaxWebpSide = 16383;

    // Link card pictures (SaveWebpFitAsync): small and many, so a lower quality than the uploads' thumbnails.
    private static readonly WebpEncoder FitEncoder = new() { Quality = 80 };
    // The pictures come from any page a person links to. 16 MP is far above what a 640 px result needs and keeps one
    // decode in the tens of MB.
    private const long MaxFitPixels = 16_000_000;

    /// <summary>
    /// A picture from the network as a WebP no larger than <paramref name="maxSide"/> on either side, or false when
    /// the bytes are no picture or too many pixels. Behind the same gate as the uploads: a room open after a deploy
    /// can queue hundreds of link cards at once, and parallel decodes are what took the process down. One frame
    /// only, and a large picture is scaled down while it is decoded (a JPEG skips the full-size decode), so an
    /// animation or a huge photo costs little. A small picture keeps its size. <paramref name="source"/> must be
    /// seekable.
    /// </summary>
    public async Task<bool> SaveWebpFitAsync(Stream source, string path, int maxSide)
    {
        await Gate.WaitAsync();
        try
        {
            var info = await Image.IdentifyAsync(source);
            if ((long)info.Width * info.Height > MaxFitPixels) return false;
            source.Position = 0;
            var box = new Size(maxSide, maxSide);
            var tooLarge = info.Width > maxSide || info.Height > maxSide;
            // TargetSize is only a decode hint that saves memory, never the limit. ImageSharp enlarges a small picture
            // to it (a 1x1 tracking pixel became 640x640) and does nothing when one side already equals it (640x2000
            // stayed 640x2000). So it is set only for a picture that must shrink, and the Resize below is the limit.
            var options = new DecoderOptions { MaxFrames = 1, TargetSize = tooLarge ? box : null };
            using var image = await Image.LoadAsync(options, source);
            // A square box, so the limit still holds after AutoOrient swaps width and height.
            if (image.Width > maxSide || image.Height > maxSide) image.Mutate(x => x.Resize(new ResizeOptions { Size = box, Mode = ResizeMode.Max }));
            image.Mutate(x => x.AutoOrient());
            await image.SaveAsync(path, FitEncoder);
            return true;
        }
        catch (ImageFormatException)
        {
            return false;   // not a picture, or a broken one
        }
        finally { Gate.Release(); }
    }

    /// <summary>The size of a picture with more than <see cref="MaxPixels"/> in one frame, or null. Reads the header
    /// only, so the upload endpoint can refuse such a picture with the reason before anything decodes it. Null also
    /// for bytes that are no picture: the endpoint asks before it knows what the file is (a GIF upload can be a video),
    /// and "is it a picture" has its own check and its own refusal there.</summary>
    public static async Task<Size?> OverMaxPixelsAsync(string path)
    {
        try
        {
            var info = await Image.IdentifyAsync(path);
            return (long)info.Width * info.Height > MaxPixels ? info.Size : null;
        }
        catch (ImageFormatException) { return null; }
    }

    /// <summary>
    /// How a picture from a person is decoded: within <see cref="MaxPixels"/>, or not at all (null) when one frame
    /// alone has more. Of an animation, the frames that fit are read: a very long one gets a shorter loop as its
    /// thumbnail, and the file itself stays as it came. EVERY full decode of such a picture goes through here. The
    /// plain Image.LoadAsync(path) takes whatever the header says.
    /// </summary>
    private static DecoderOptions? WithinMaxPixels(ImageInfo info)
    {
        var frame = Math.Max(1, (long)info.Width * info.Height);
        if (frame > MaxPixels) return null;
        // More than one frame only for the formats that hold an animation: there each frame is drawn on the one
        // canvas whose size the header gives, so "frames x canvas" is the true cost. A TIFF holds pages, each with a
        // size of its own, and the header gives the first: with a page of 10 x 10 in front, a second page of
        // 20000 x 20000 was within this budget, and the decoder reads every page it is allowed before it compares
        // their sizes. One frame is all a thumbnail of such a file needs.
        var animation = info.Metadata.DecodedImageFormat is GifFormat or WebpFormat or PngFormat;
        return new DecoderOptions { MaxFrames = animation ? (uint)(MaxPixels / frame) : 1 };
    }

    /// <summary>
    /// Generates only the medium (800px) thumbnail for fast initial display.
    /// </summary>
    public async Task GenerateMediumThumbnailAsync(string originalPath)
    {
        await GenerateSingleThumbnailAsync(originalPath, SizeMedium);
    }

    /// <summary>
    /// Generates only the large (1600px) thumbnail for lightbox.
    /// </summary>
    public async Task GenerateLargeThumbnailAsync(string originalPath)
    {
        await GenerateSingleThumbnailAsync(originalPath, SizeLarge);
    }

    private async Task GenerateSingleThumbnailAsync(string originalPath, int size)
    {
        try
        {
            var (directory, filename, originalExtension, skipResizing) = GetFileInfo(originalPath);
            var thumbPath = Path.Combine(directory, $"{filename}_{size}px.webp");

            if (File.Exists(thumbPath)) return;

            await Gate.WaitAsync();
            try
            {
                if (WithinMaxPixels(await Image.IdentifyAsync(originalPath)) is not { } options) return;   // the upload endpoint refuses these; this is the guard at the decode itself
                using var image = await Image.LoadAsync(options, originalPath);
                image.Mutate(x => x.AutoOrient());

                try { await SaveThumbnailAsync(image, thumbPath, size, originalExtension, skipResizing); }
                catch
                {
                    // An encoder that throws leaves the file it began. That file is no picture, the row shows it as
                    // a broken one, and File.Exists above keeps it for good. Without it the row asks again and gets a 404.
                    try { File.Delete(thumbPath); } catch { }
                    throw;
                }
            }
            finally { Gate.Release(); }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to generate {size}px thumbnail for {originalPath}: {ex.Message}");
        }
    }

    private static (string Directory, string Filename, string Extension, bool SkipResizing) GetFileInfo(string originalPath)
    {
        var directory = Path.GetDirectoryName(originalPath)!;
        var filename = Path.GetFileNameWithoutExtension(originalPath);
        var extension = Path.GetExtension(originalPath).ToLowerInvariant();
        var skipResizing = new FileInfo(originalPath).Length < SmallFileThreshold;
        return (directory, filename, extension, skipResizing);
    }

    /// <summary>The width of a thumbnail: the picture's own for a small file and for a narrow picture, else
    /// <paramref name="size"/>. Neither rule looks at the height, and a small file can hold any number of pixels (one
    /// colour compresses to almost nothing), so the result also stays within <see cref="MaxThumbnailPixels"/>, and
    /// neither side of the thumbnail is longer than <see cref="MaxWebpSide"/>.</summary>
    internal static int ThumbnailWidth(int imageWidth, int imageHeight, int size, bool smallFile)
    {
        var width = smallFile || imageWidth <= size ? imageWidth : size;
        var pixels = (long)width * width * imageHeight / imageWidth;
        if (pixels > MaxThumbnailPixels) width = (int)(width * Math.Sqrt((double)MaxThumbnailPixels / pixels));
        width = Math.Min(width, MaxWebpSide);                                           // a wide picture
        width = (int)Math.Min(width, (long)MaxWebpSide * imageWidth / imageHeight);     // a tall one: the height follows the width
        return Math.Max(1, width);
    }

    private static async Task SaveThumbnailAsync(Image image, string thumbPath, int size, string originalExtension, bool skipResizing)
    {
        var width = ThumbnailWidth(image.Width, image.Height, size, skipResizing);
        if (width == image.Width)
        {
            // Just convert to WebP without resizing
            await image.SaveAsync(thumbPath, WebpEncoder);
        }
        else
        {
            // Use different resamplers based on original format:
            // - Lanczos3 for photos (jpg/webp) - smooth gradients
            // - Box for screenshots/graphics (png/gif) - preserves sharp edges
            var sampler = originalExtension is ".png" or ".gif"
                ? KnownResamplers.Box
                : KnownResamplers.Lanczos3;

            using var resized = image.Clone(x => x.Resize(new ResizeOptions
            {
                Size = new Size(width, 0), // 0 = maintain aspect ratio
                Mode = ResizeMode.Max,
                Sampler = sampler
            }));

            await resized.SaveAsync(thumbPath, WebpEncoder);
        }
    }

    /// <summary>
    /// Gets the URL for a specific size variant (always WebP).
    /// Convention: /uploads/image.jpg -> /uploads/image_800px.webp
    /// </summary>
    public static string GetSizedUrl(string originalUrl, int size)
    {
        var lastDot = originalUrl.LastIndexOf('.');
        if (lastDot < 0) return originalUrl;

        return $"{originalUrl[..lastDot]}_{size}px.webp";
    }

    /// <summary>The large URL of a medium URL, or null when the URL is not a medium one. For a pin copied before
    /// 2026-11-04, which holds only the medium URL (SH-48): the two differ only in the size of the suffix.</summary>
    public static string? LargeOfMedium(string mediumUrl)
    {
        var suffix = $"_{SizeMedium}px.webp";
        return mediumUrl.EndsWith(suffix, StringComparison.Ordinal) ? $"{mediumUrl[..^suffix.Length]}_{SizeLarge}px.webp" : null;
    }

    // Convenience methods for common sizes
    public static string GetMediumUrl(string originalUrl) => GetSizedUrl(originalUrl, SizeMedium);
    public static string GetLargeUrl(string originalUrl) => GetSizedUrl(originalUrl, SizeLarge);

    // Profile picture settings
    private const int ProfilePictureSize = 128;
    private readonly string _profiles;

    public ImageService(UploadPaths uploads) => _profiles = uploads.Profiles;

    /// <summary>
    /// Generates a profile picture thumbnail (128px square WebP).
    /// Returns the URL path to the generated image.
    /// Deletes any existing profile picture for this user.
    /// </summary>
    public async Task<string?> GenerateProfilePictureAsync(Stream imageStream, Guid userId)
    {
        // Behind the gate of the uploads, for the same reason: this decodes up to MaxPixels whole (about 200 MB) for a
        // result of 128 px, and a person can send many pictures at once. Without the gate ten such requests held
        // ten decodes at the same time.
        await Gate.WaitAsync();
        try
        {
            // Ensure profiles directory exists
            Directory.CreateDirectory(_profiles);

            // Before the old picture goes: a file that is refused here leaves the person's picture as it is.
            // The stream of a form file can be read twice.
            if (WithinMaxPixels(await Image.IdentifyAsync(imageStream)) is not { } options) return null;
            imageStream.Position = 0;

            // Delete existing profile picture if any
            var existingFiles = Directory.GetFiles(_profiles, $"{userId}.*");
            foreach (var file in existingFiles)
            {
                try { File.Delete(file); } catch { }
            }

            var outputPath = Path.Combine(_profiles, $"{userId}.webp");
            // The file keeps one name per user and is overwritten in place. A browser keys its image cache on the
            // whole URL, so the upload time in the query is what makes every open client fetch the new picture.
            var urlPath = $"/uploads/profiles/{userId}.webp?v={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

            using var image = await Image.LoadAsync(options, imageStream);
            image.Mutate(x => x
                .AutoOrient()
                .Resize(new ResizeOptions
                {
                    Size = new Size(ProfilePictureSize, ProfilePictureSize),
                    Mode = ResizeMode.Crop,
                    Position = AnchorPositionMode.Center
                }));

            await image.SaveAsync(outputPath, WebpEncoder);

            return urlPath;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to generate profile picture for user {userId}: {ex.Message}");
            return null;
        }
        finally { Gate.Release(); }
    }

    /// <summary>
    /// Deletes a user's profile picture.
    /// </summary>
    public void DeleteProfilePicture(Guid userId)
    {
        try
        {
            var filePath = Path.Combine(_profiles, $"{userId}.webp");
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to delete profile picture for user {userId}: {ex.Message}");
        }
    }
}
