using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yap.Models.Chat;

/// <summary>
/// A pinned message, as the channel stores it and as the client receives it (MR-77, SH-48). The pin carries a copy of
/// what the panel shows (author, text, time, the media under the text), so the panel works for a message that the
/// startup load left in the database. Edit keeps the copy current; Delete removes the pin.
/// </summary>
public sealed record Pin(Guid MessageId, string Username, string? Text, DateTime Timestamp, IReadOnlyList<PinMedia> Media, string PinnedBy, DateTime PinnedAt)
{
    /// <summary>Never null. A channel row from the first pin build (2026-10-18, before the panel showed media) has no
    /// media in its pins at all, and the deserializer passes null for a constructor argument that the JSON lacks.</summary>
    [JsonConverter(typeof(PinMediaListConverter))]
    public IReadOnlyList<PinMedia> Media { get; init; } = Media ?? [];

    public static Pin Of(ChatMessage m, string pinnedBy, IReadOnlyList<PinMedia> media) =>
        new(m.Id, m.Username, string.IsNullOrEmpty(m.Content) ? null : m.Content, m.Timestamp, media, pinnedBy, DateTime.UtcNow);
}

/// <summary>
/// One item under a pin's text (SH-48), in the row's order, resolved when the pin is made: a GIF file can move or go,
/// and a link card loads only when a page shows its link, so the pin keeps its own copy of the URLs. Kind decides the shape:
/// image (Src: the medium picture; Large and Original: what the gallery viewer shows and downloads, TL-24), gif (Src:
/// the file the panel shows, a picture when IsImage, else a video it loops; no Src when the file is gone), video (Src
/// and Poster: an uploaded video, or a cached link video with the card's Title, Site and Url), link (Poster, Title,
/// Site and Url of a link card), voice (Src, DurationMs and Peaks: what the row's player draws). Width and Height keep
/// a GIF's shape before it loads. The fields after Peaks came on 2026-11-04: an older copy lacks them, and the panel
/// falls back to Src.
/// </summary>
public sealed record PinMedia(string Kind, string? Src = null, string? Poster = null, int? Width = null, int? Height = null,
    string? Title = null, string? Site = null, int? DurationMs = null, string? Peaks = null,
    string? Large = null, string? Original = null, bool? IsImage = null, string? Url = null);

/// <summary>
/// The media list of a stored pin. Pins made before 2026-10-23 hold one object (the first picture only) or null, and
/// they stay in the channel rows: this reads them as a list of one or none. The wire and new rows carry a plain array.
/// </summary>
public sealed class PinMediaListConverter : JsonConverter<IReadOnlyList<PinMedia>>
{
    public override bool HandleNull => true;   // a stored null reaches Read and becomes an empty list, not a null property

    public override IReadOnlyList<PinMedia> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.Null => [],
        JsonTokenType.StartObject => JsonSerializer.Deserialize<PinMedia>(ref reader, options) is { } one ? [one] : [],
        _ => JsonSerializer.Deserialize<List<PinMedia>>(ref reader, options) ?? [],
    };

    public override void Write(Utf8JsonWriter writer, IReadOnlyList<PinMedia> value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, options);
}
