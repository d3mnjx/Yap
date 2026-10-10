using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class MediaChecks
{
    public static void Run(IServiceProvider services, string root, User user, OfflineSnapshotService snapshots)
    {
        var previews = services.GetRequiredService<LinkPreviewService>();
        var folder = Path.Combine(root, "Data", "media-cache");
        Directory.CreateDirectory(folder);
        ReaderMessage View(string content) => snapshots.Message(new ChatMessage(Guid.NewGuid(), user.Id, user.Username, content, DateTime.UtcNow), user.Id);
        void Check(bool value, string label)
        {
            if (!value)
                throw new Exception(label);
            Console.WriteLine("PASS " + label);
        }
        var url = "https://example.com/portrait-fixture";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16].ToLowerInvariant();
        // Disk lookup only; browser tests supply real decodable media separately.
        File.WriteAllBytes(Path.Combine(folder, hash + ".mp4"), [0]);
        File.WriteAllBytes(Path.Combine(folder, hash + "_poster.webp"), [0]);
        File.WriteAllText(Path.Combine(folder, hash + ".dims"), "180x320");
        File.WriteAllText(Path.Combine(folder, hash + ".title"), "Cached portrait title");
        var cached = View(url).Previews!.Single();
        Check(cached.MediaWidth == 180 && cached.MediaHeight == 320 && cached.Title == "Cached portrait title" && cached.CachedPosterUrl != null,
            "snapshot projects cached portrait dimensions, local poster and sidecar title without OG preview");
        var og = previews.GetOrCreatePreview(url);
        og.Title = "OG title";
        Check(View(url).Previews!.Single().Title == "OG title", "OG title takes precedence over cached title");
        var failed = previews.GetOrCreatePreview("https://example.com/failed-fixture");
        failed.Title = "Failed preview";
        failed.Failed = true;
        Check(View(failed.Url).Previews!.Length == 0, "failed non-media preview is suppressed like the original");
        var urls = Enumerable.Range(0, 7).Select(i => "https://example.com/preview-" + i).ToArray();
        foreach (var item in urls)
            previews.GetOrCreatePreview(item).Title = "Preview";
        Check(View(string.Join(" ", urls)).Previews!.Length == 5, "snapshot retains original five-preview message limit");
    }
}
