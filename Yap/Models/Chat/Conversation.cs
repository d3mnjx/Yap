namespace Yap.Models.Chat;

/// <summary>What <c>openRoom</c> and <c>openDm</c> return: the tail of the conversation, who types in it, and its pinned messages (chat-hub.md, SH-48).</summary>
public sealed record Conversation(Guid ChannelId, IReadOnlyList<MessageDto> Messages, bool HasMore, bool Restricted, IReadOnlyList<string> Typists, IReadOnlyList<Pin> Pins);

/// <summary>What <c>older</c> returns (TL-06).</summary>
public sealed record Page(IReadOnlyList<MessageDto> Messages, bool HasMore);

/// <summary>What <c>around</c> returns (SH-49, MR-34, TL-41): the messages around the target, whether older ones exist
/// (HasMore) and whether newer ones exist (HasNewer). Error is the refusal the reader sees (GEN-02); the list is empty then.
/// The error travels in the body because hub.invoke turns every exception into "Something went wrong".</summary>
public sealed record Window(IReadOnlyList<MessageDto> Messages, bool HasMore, bool HasNewer, string? Error = null);

/// <summary>One result of <c>search</c> (SR-08). It has the fields that the client's pin entry drawing reads
/// (<see cref="Pin"/>: message id, author, text, time, the media under the text), so one drawing serves both. The
/// media are the message's own files; a result shows no link card.</summary>
public sealed record SearchHit(Guid MessageId, string Username, string Text, DateTime Timestamp, IReadOnlyList<PinMedia> Media);

/// <summary>What <c>search</c> returns: one page of results, newest first. Total is the count of every match and comes
/// with the first page only (SR-11). HasMore says that a call with the last hit as the cursor finds more. Since is the
/// time of the oldest message the reader can see, null when there is none (SR-12). Error is the refusal the reader
/// sees, in the body for the reason <see cref="Window"/> gives.</summary>
public sealed record SearchPage(IReadOnlyList<SearchHit> Hits, int? Total, bool HasMore, DateTime? Since, string? Error = null);

/// <summary>A refusal from a hub method, with the reason the user reads (GEN-02). A hub method returns null on success.</summary>
public sealed record HubError(string Error);

/// <summary>A room as the client sees it (SH-22, AD-30 to AD-32). Read-only is derived on the client from AdminOnly and the person's admin flag.
/// IsLobby names the room that /lobby opens (SH-43); the sidebar order is the admin's and says nothing about identity (AD-33).
/// PinPermission and Pinners let the client decide whether to offer Pin (MR-77, AD-37); the server decides again on the call.</summary>
public sealed record RoomDto(Guid Id, string Name, string? Description, int SortOrder, bool AdminOnly, HistoryLimit HistoryLimit, bool SinceJoined, bool IsLobby,
    PinPermission PinPermission, IReadOnlyList<string> Pinners)
{
    public static RoomDto From(Channel room) =>
        new(room.Id, room.Name, room.Description, room.SortOrder, room.WritePermission == ChannelPermission.AdminOnly, room.HistoryLimit, room.SinceJoined, room.IsDefault,
            room.PinPermission, room.Pinners);
}

/// <summary>A direct message in the sidebar: the partner and when it last moved (SH-29, SH-30).</summary>
public sealed record DmDto(Guid ChannelId, string Partner, DateTime LastMessageAt);
