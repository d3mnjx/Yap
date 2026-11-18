namespace Yap.Models.Chat;

/// <summary>
/// Embedded in ChatMessage.GifAttachments JSON column. Carries just enough to render the GIF
/// in chat history independent of the live GifEntry. Width/Height are duplicated for layout stability
/// even if the underlying GifEntry is missing (defensive fallback).
///
/// The actual playable URLs are looked up at render time via the GifService by GifEntryId — this
/// lets background normalization (provider CDN URL → local file, MP4 → WebM transcode) update what
/// gets served without rewriting historical messages.
///
/// A positional record, so its properties are init-only: ChatDbContext compares GifAttachments element-wise
/// to detect changes, so an attachment must be equal by value and must not change in place.
/// </summary>
public sealed record GifAttachment(Guid GifEntryId, int Width, int Height);
