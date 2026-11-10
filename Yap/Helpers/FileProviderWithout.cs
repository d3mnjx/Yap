using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace Yap.Helpers;

/// <summary>
/// The files of another provider, without those in one folder. The place of the file on disk decides, not the path
/// of the request. A static file handler compares its URL prefix segment by segment, but the provider behind it
/// resolves "//uploads/x" and "/uploads/x" to the same file, so a rule on the URL has spellings that get around it
/// (Program.cs: the uploads folder is inside wwwroot, and the folder of tus is inside the uploads folder).
/// </summary>
public sealed class FileProviderWithout(IFileProvider inner, string folder) : IFileProvider
{
    private readonly string _folder = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder)) + Path.DirectorySeparatorChar;

    public IFileInfo GetFileInfo(string subpath)
    {
        var file = inner.GetFileInfo(subpath);
        // Case does not count: on Windows "Uploads" is the same folder. On Linux this can only hide a file too many.
        return file.PhysicalPath is { } path && Path.GetFullPath(path).StartsWith(_folder, StringComparison.OrdinalIgnoreCase)
            ? new NotFoundFileInfo(subpath)
            : file;
    }

    // The static file handlers ask for one file at a time. A listing would still show the folder, so nothing may list through this.
    public IDirectoryContents GetDirectoryContents(string subpath) => inner.GetDirectoryContents(subpath);

    public IChangeToken Watch(string filter) => inner.Watch(filter);
}
