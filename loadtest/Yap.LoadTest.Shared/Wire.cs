using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yap.LoadTest.Shared;

// Copies of the server's wire shapes, reduced to the fields this tool reads or sends. The server's records live
// in Yap/Models and Yap/Endpoints; System.Text.Json ignores the fields that are missing here. When a field named
// below changes on the server, change it here too. The tool depends on: MessageDto.Id/ChannelId/ClientId/Username,
// RoomDto.Id/Name/IsLobby, BootstrapDto.User/Config/Rooms/Users, Conversation.Messages, LinkDto.Url, LoadSample (all fields
// but CpuPeakPercent, which equals CpuPercent in the 1 s samples this tool reads).

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },   // the server sends enums as camelCase strings
    };
}

public sealed record MessageDto(Guid Id, Guid ChannelId, Guid? ClientId, string Username, string Text, DateTime Timestamp);
public sealed record RoomDto(Guid Id, string Name, bool IsLobby);
public sealed record UserDto(string Username, bool IsAdmin, bool IsBot);
public sealed record MeDto(Guid Id, string Username, bool IsAdmin);
public sealed record LinkDto(string Code, string Url);
public sealed record ClientConfigDto(string UploadUrl, int MaxUploadMB, bool LinkPreviews, bool MediaCaching);
public sealed record BootstrapDto(MeDto? User, ClientConfigDto? Config, List<RoomDto>? Rooms, List<UserDto>? Users, EmojiImages? EmojiImages);
public sealed record Conversation(Guid ChannelId, List<MessageDto> Messages);
public sealed record EmojiEntry(string Shortcode);
public sealed record EmojiPack(string Key, List<EmojiEntry> Emojis);
public sealed record EmojiImages(List<EmojiPack>? Packs);
public sealed record TusInfo(string? Url, string? Type);

public sealed record SendMessageRequest(Guid ClientId, string? Text, Guid? ReplyToId, List<string>? Images);
public sealed record SignInRequest(string Username, string? Code);
public sealed record RoomRequest(string Name, string? Description, bool AdminOnly, string HistoryLimit = "unlimited", bool SinceJoined = false);
public sealed record SettingsRequest(bool? RegistrationClosed, bool? RequireApproval, bool? SmartLogin, bool? LinkPreviews, bool? MediaCaching);

/// <summary>One second of the server, as GET /api/admin/load returns it (Yap/Services/Admin/LoadMetrics.cs).</summary>
public sealed record LoadSample(DateTime At, double CpuPercent, long WorkingSetMB, long HeapMB, int Gen0, int Gen1, int Gen2, double GcPauseMs,
    int ThreadPoolThreads, long ThreadPoolQueue, int Connections, int MessagesPerSec, int HubSendsPerSec, int RequestsPerSec,
    double RequestP95Ms, long RequestMaxMs, int WriterDepth, double SweepMs, double? MachineLoad1, long? MachineMemAvailableMB);
public sealed record LoadResponse(LoadSample? Latest, List<LoadSample> Series);
