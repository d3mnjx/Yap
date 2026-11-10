namespace Yap.Services.Media;

/// <summary>
/// Where uploaded files live on disk. The URLs stay <c>/uploads/*</c>; the folder comes from
/// <c>ChatSettings:UploadsPath</c>, relative to the content root. The default keeps the Docker volume
/// (<c>/app/wwwroot/uploads</c>) valid.
/// </summary>
public sealed class UploadPaths
{
    public string Root { get; }
    public string Profiles => Path.Combine(Root, "profiles");
    public string Gifs => Path.Combine(Root, "gifs");
    public const string TusTempFolder = "tus-temp";   // also the URL segment under /uploads that Program.cs refuses to serve
    public string TusTemp => Path.Combine(Root, TusTempFolder);
    public string TusResults => Path.Combine(TusTemp, "results");   // what each finished upload became (TusEndpoints); under tus-temp, so never served

    public UploadPaths(IConfiguration configuration, IWebHostEnvironment env)
    {
        var configured = configuration["ChatSettings:UploadsPath"];
        Root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.WebRootPath, "uploads")
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configured));
    }

    /// <summary>The file behind an <c>/uploads/</c> URL, or null for any other URL (a pin may keep a <c>/media-cache/</c>
    /// video) and for a path that leaves the folder. The file may not exist.</summary>
    public string? PathOf(string url)
    {
        const string prefix = "/uploads/";
        if (!url.StartsWith(prefix, StringComparison.Ordinal)) return null;
        var relative = url[prefix.Length..];
        var query = relative.IndexOf('?');
        if (query >= 0) relative = relative[..query];
        var root = Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        return path.StartsWith(root, StringComparison.Ordinal) ? path : null;
    }
}
