using System.Text.RegularExpressions;

namespace Yap.Helpers;

/// <summary>
/// The username format, in one place. Login.razor checks it as the user types; the invite
/// endpoint checks it server-side, because an invite creates the account without ever
/// passing through the login page's UI.
/// </summary>
public static partial class UsernameRules
{
    public const int MinLength = 2;

    /// <summary>The login form's maxlength. The DB column allows 32, but nothing needs it.</summary>
    public const int MaxLength = 23;

    [GeneratedRegex("^[a-z0-9._]+$")]
    private static partial Regex Allowed();

    /// <summary>
    /// Trims and lowercases the input. Returns an error message for the user, or null when
    /// the shape is fine. Reserved names (the bot) and display-name collisions need services,
    /// so callers check those themselves.
    /// </summary>
    public static string? Check(string? raw, out string normalized)
    {
        normalized = (raw ?? "").Trim().ToLowerInvariant();

        if (normalized.Length < MinLength)
            return $"Username must be at least {MinLength} characters";
        if (normalized.Length > MaxLength)
            return $"Username must be at most {MaxLength} characters";
        if (!Allowed().IsMatch(normalized))
            return "Only lowercase letters, numbers, _ and . allowed";
        if (normalized.Contains(".."))
            return "Cannot have consecutive periods";

        return null;
    }
}
