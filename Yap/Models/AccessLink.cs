namespace Yap.Models;

/// <summary>
/// One shareable sign-in credential in URL form: <c>/invite/{Code}</c>.
/// </summary>
/// <remarks>
/// A single row covers both things the UI talks about. While <see cref="UserId"/> is null it
/// is an invite: whoever opens it first picks a username, and the row becomes that user's
/// login link. A user holds at most one active link; minting a new one revokes the old.
///
/// The code is a readable "color-animal-NNNN" phrase on purpose. The place people need it
/// most is a fresh device, where they read it off another screen and type it (VerifyDevice
/// accepts it as the secret code). The ~160M space only holds up together with the failure
/// brake in AccessLinkService, because there is no username in front of the code.
/// </remarks>
public class AccessLink
{
    public Guid Id { get; set; } = Guid.NewGuid();

    /// <summary>Canonical form, e.g. "blue-fox-4821". Matching ignores case and separators.</summary>
    public string Code { get; set; } = "";

    /// <summary>Who minted it: the admin (invite or rescue) or the user themself.</summary>
    public Guid CreatedById { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>Owner. Null until an invite is claimed.</summary>
    public Guid? UserId { get; set; }

    /// <summary>Null means the link never expires.</summary>
    public DateTime? ExpiresAt { get; set; }

    public DateTime? RevokedAt { get; set; }

    /// <summary>
    /// First successful sign-in through the link. Also the moment an admin-minted code
    /// stops being shown to the admin (see <see cref="AdminCanSeeCode"/>).
    /// </summary>
    public DateTime? FirstUsedAt { get; set; }

    public DateTime? LastUsedAt { get; set; }

    public int UseCount { get; set; }

    /// <summary>Admin's memo for an open invite ("for Tom"). Never shown to the invitee.</summary>
    public string? Note { get; set; }

    public bool IsRevoked => RevokedAt != null;

    public bool IsExpired => ExpiresAt is { } at && at <= DateTime.UtcNow;

    public bool IsActive => !IsRevoked && !IsExpired;

    public bool IsClaimed => UserId != null;

    /// <summary>
    /// The admin may read the code only while it is still theirs to hand over: a link they
    /// minted that nobody has opened yet. After first use, or for a link the user made
    /// themself, it is the user's secret, exactly like the passphrase is today.
    /// </summary>
    public bool AdminCanSeeCode => FirstUsedAt == null && (UserId == null || CreatedById != UserId);
}
