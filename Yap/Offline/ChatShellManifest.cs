using System.Security.Cryptography;
using System.Text;

namespace Yap.Offline;

/// <summary>One startup inventory of anonymous shell files, shared by installation and fetch policy.</summary>
public sealed class ChatShellManifest
{
    public record Asset(string Url, string Hash, bool Install);
    public string Version
    {
        get;
    }
    public Asset[] Assets
    {
        get;
    }

    public ChatShellManifest(IWebHostEnvironment environment)
    {
        var root = environment.WebRootPath;
        var branding = Path.Combine(environment.ContentRootPath, "Data", "branding");
        var contentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
        string ServedFile(string url, string fallback)
        {
            var replacement = Path.Combine(branding, url.TrimStart('/'));
            return File.Exists(replacement) && contentTypes.TryGetContentType(replacement, out _) ? replacement : fallback;
        }
        Assets = Directory.Exists(root) ? Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => (Path: path, Url: "/" + Path.GetRelativePath(root, path).Replace('\\', '/')))
            .Where(file => IsShellAsset(file.Url))
            .OrderBy(file => file.Url, StringComparer.Ordinal)
            .Select(file => new Asset(file.Url, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(ServedFile(file.Url, file.Path)))), IsInstallAsset(file.Url)))
            .ToArray() : [];
        Version = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join("\n", Assets.Select(asset => asset.Url + ":" + asset.Hash + ":" + asset.Install)))));
    }

    private static bool IsInstallAsset(string path) =>
        (!path.StartsWith("/themes/", StringComparison.Ordinal) || path.EndsWith(".css")) &&
        !path.StartsWith("/images/", StringComparison.Ordinal) &&
        !path.StartsWith("/chat-client/vendor/add-to-homescreen-3.5/assets/img/", StringComparison.Ordinal);

    private static bool IsShellAsset(string path)
    {
        // Precompressed siblings are transport variants, not distinct browser resources.
        if (path.EndsWith(".br") || path.EndsWith(".gz") || path.EndsWith(".md") || path.Contains("/sample/") || path.Contains("/aardvark-") || path.EndsWith("/aardvark.svg"))
            return false;
        if (path.StartsWith("/chat-client/", StringComparison.Ordinal))
            return !(path.StartsWith("/chat-client/emoji/", StringComparison.Ordinal) && path.EndsWith(".svg"));
        return path.StartsWith("/fonts/", StringComparison.Ordinal)
            || path.StartsWith("/themes/", StringComparison.Ordinal)
            || path.StartsWith("/images/", StringComparison.Ordinal)
            || path is "/app.css" or "/themes.css" or "/notif.mp3" or "/js/appearance.js"
                or "/service-worker.js" or "/service-worker-module.js" or "/icon.svg" or "/icon-192.png" or "/icon-512.png"
                or "/emoji_selection_greys.png" or "/emoji_selection_color.png";
    }
}
