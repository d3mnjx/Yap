using tusdotnet.Interfaces;

namespace Yap.Services.Media;

/// <summary>
/// The ids of tus uploads. An id is the id of the person who created the upload and then a random GUID, 64 hex
/// digits. The owner is in the id, so the owner check needs no memory and no file: an upload survives a restart
/// of the server, and the person's client goes on with it (OF-10). The random half keeps an id unguessable, and a
/// person who learns another person's id still fails <see cref="Owns"/>.
/// </summary>
internal sealed class UploadIds(Guid owner) : ITusFileIdProvider
{
    public Task<string> CreateId(string metadata) => Task.FromResult($"{owner:N}{Guid.NewGuid():N}");

    public Task<bool> ValidateId(string fileId) => Task.FromResult(IsValid(fileId));

    // The id becomes a file name in the tus folder, so nothing but lower-case hex digits passes. 32 digits is the id
    // of an upload from before the owner was in the id: valid, so that the expiry sweep can remove it, and nobody's.
    public static bool IsValid(string fileId) =>
        fileId.Length is 32 or 64 && fileId.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    public static bool Owns(Guid user, string fileId) =>
        fileId.Length == 64 && IsValid(fileId) && fileId.StartsWith(user.ToString("N"), StringComparison.Ordinal);
}
