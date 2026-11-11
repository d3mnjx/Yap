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
    public string TusTemp => Path.Combine(Root, "tus-temp");   // inside the uploads root, and the /uploads handler leaves it out (Program.cs)
    public string TusResults => Path.Combine(TusTemp, "results");   // what each finished upload became (TusEndpoints); under tus-temp, so never served

    public UploadPaths(IConfiguration configuration, IWebHostEnvironment env)
    {
        var configured = configuration["ChatSettings:UploadsPath"];
        Root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.WebRootPath, "uploads")
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configured));
    }

    /// <summary>
    /// Whether a media URL that a client sent with a message is the plain URL of a file under <c>/uploads/</c>. The
    /// start of the text is not enough: every reader's browser resolves the URL before it asks, with the reader's
    /// cookie, so "/uploads/../api/x" is a request to /api/x. A URL of the upload endpoint has only letters,
    /// digits, "-", "_" and "." in its segments, and no segment starts with a dot. That leaves no "..", no empty
    /// segment, no "%2e", no backslash (a browser reads it as a slash), no query and no fragment.
    /// </summary>
    public static bool IsUploadUrl(string url)
    {
        const string prefix = "/uploads/";
        if (url.Length > 200 || !url.StartsWith(prefix, StringComparison.Ordinal)) return false;   // a real one has about 50 characters
        return url[prefix.Length..].Split('/').All(segment =>
            segment.Length > 0 && segment[0] != '.' && segment.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'));
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
