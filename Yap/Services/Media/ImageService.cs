using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Yap.Services.Media;

/// <summary>
/// - Generates WebP thumbnails on upload at two sizes: 800px (gallery) and 1600px (lightbox)
/// - Uses SixLabors.ImageSharp for cross-platform image processing
/// - Smart resampling: Lanczos3 for photos, Box for screenshots/graphics
/// - Skips resizing for small files(<500KB), just converts to WebP
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
                using var image = await Image.LoadAsync(originalPath);
                image.Mutate(x => x.AutoOrient());

                await SaveThumbnailAsync(image, thumbPath, size, originalExtension, skipResizing);
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

    private static async Task SaveThumbnailAsync(Image image, string thumbPath, int size, string originalExtension, bool skipResizing)
    {
        if (skipResizing || image.Width <= size)
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
                Size = new Size(size, 0), // 0 = maintain aspect ratio
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
        try
        {
            // Ensure profiles directory exists
            Directory.CreateDirectory(_profiles);

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

            using var image = await Image.LoadAsync(imageStream);
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
