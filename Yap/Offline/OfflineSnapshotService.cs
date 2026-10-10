using System.Text.Json.Serialization;
using System.Collections.Concurrent;
using Yap.Helpers;
using Yap.Models;
using Yap.Services;
using Yap.Services.Gifs;

namespace Yap.Offline;

// Explicit DTOs: never serialize User, Channel or ChatMessage navigation/credential fields.
/// <summary>
/// Public user and profile fields exposed to chat clients without authentication credentials.
/// </summary>
public record ReaderUser(Guid Id, string Username, string DisplayName, string? Picture, string Gradient, bool IsAdmin = false, bool IsBot = false, string? Bio = null, string? Country = null, DateTime? CreatedAt = null);
/// <summary>
/// Minimal author and text preview of a reply target the recipient may read.
/// </summary>
public record ReaderReply(Guid Id, ReaderUser Author, string Content);
/// <summary>
/// Image variant URLs used by the timeline and full-size gallery.
/// </summary>
public record ReaderImage(string Medium, string Large);
/// <summary>
/// A reaction emoji and the usernames currently associated with it.
/// </summary>
public record ReaderReaction(string Emoji, string[] Users);
/// <summary>
/// Client-facing message content, media and reactions, including the operation ID used to reconcile
/// accepted sends.
/// </summary>
public record ReaderMessage(Guid Id, Guid? OperationId, [property: JsonIgnore] ReaderUser Author, string Content, DateTime Timestamp,
    bool IsEdited, Guid? ReplyToMessageId, ReaderImage[] Images, string[] Videos, int GifCount, ReaderReaction[] Reactions, object[]? Gifs, LinkPreview[]? Previews, ReaderReply? Reply)
{
    public Guid AuthorId => Author.Id;
}
/// <summary>
/// An authorized recent message window with navigation, permission, history and observed-read
/// metadata.
/// </summary>
public record ReaderConversation(Guid Id, string Kind, string Name, string? Description, bool IsDefault, string Path,
    bool CanWrite, bool HasMore, int Unread, bool Muted, ReaderMessage[] Messages, long Received, long ReadThrough, bool MuteBell, long ContentVersion = 0, bool HistoryLimited = false, long HistoryVersion = 0);
/// <summary>
/// The account-specific synchronization payload, ordered by server epoch and sequence and
/// identified by a content revision.
/// </summary>
public record ReaderSnapshot(int Protocol, string Revision, string ServerEpoch, long Sequence, ReaderUser User, bool IsAdmin, string Theme,
    int? FontSize, string? TimeZone, string? DateFormat, string ProjectName, int RecentMessageLimit,
    bool CanSend, int MaxTextLength, ReaderUser[] People, ReaderConversation[] Conversations, int MaxOperationsPerBatch, int MaxBatchBytes,
    int MaxFilesPerMessage, string[] AllowedExtensions, long MaxUploadBytes, int HistoryPageSize,
    int HistoryMaxMessages, int ReadBatch, int TypingTimeoutMs, int AwayAfterMs, object? DateSettings = null);

/// <summary>
/// Projects authorized chat state into bounded, credential-free snapshots with content revisions
/// and ordering for browser reconciliation.
/// </summary>
public sealed class OfflineSnapshotService(ChatService chat, UserService users, IConfiguration config, ChatConfigService branding, SystemBotService bots, NotificationSettingsService notifications, GifService gifs, LinkPreviewService previews, LinkPreviewSettingsService previewSettings, MediaCacheService media, IWebHostEnvironment env, OfflineChangeSignal changes, ChatLimits limits)
{
    private readonly ConcurrentDictionary<Guid, ReaderUser> summaries = new();
    public void InvalidateUser(Guid id) => summaries.TryRemove(id, out _);
    public string Epoch => changes.Epoch;
    public long Stamp() => changes.Stamp();
    public ReaderUser Summary(User user) => summaries.GetOrAdd(user.Id, _ => BuildSummary(user));
    public int RecentLimit => Math.Clamp(config.GetValue("OfflineChat:RecentMessageLimit", 100), 1, 500);
    private ReaderUser BuildSummary(User user)
    {
        var picture = user.ProfilePictureUrl;
        // Profile filenames are overwritten; version the URL so immutable offline caching stays fresh.
        if (picture?.StartsWith("/uploads/profiles/", StringComparison.Ordinal) == true)
        {
            var file = Path.Combine(env.WebRootPath, "uploads", "profiles", Path.GetFileName(picture.Split('?')[0]));
            if (File.Exists(file))
                picture = picture.Split('?')[0] + "?v=" + File.GetLastWriteTimeUtc(file).Ticks;
        }
        return new(user.Id, user.Username, user.EffectiveDisplayName, picture, AvatarColor.GetGradientCss(user.Username), users.IsAdmin(user.Id), bots.IsBotUser(user.Username), user.Bio, user.Country, user.CreatedAt);
    }
    public bool IsDirectMessage(Guid? id) => id is { } value && chat.GetChannel(value)?.IsDirectMessage == true;

    public Channel[] Channels(User user) => chat.GetRooms().Concat(chat.GetDMChannels(user.Username))
        .Where(c => c.CanAccess(user.Id)).DistinctBy(c => c.Id).ToArray();

    public ReaderConversation? Metadata(User user, Guid id, bool? hasMore = null)
    {
        var channel = chat.GetChannel(id);
        if (channel == null || !channel.CanAccess(user.Id))
            return null;
        var checkpoint = chat.GetReadCheckpoint(user.Id, id);
        return new(id, channel.IsDirectMessage ? "dm" : "room",
            channel.IsDirectMessage ? users.GetById(channel.GetOtherParticipantId(user.Id) ?? Guid.Empty)?.EffectiveDisplayName
                ?? channel.GetOtherParticipant(user.Username) ?? "Deleted user" : channel.Name,
            channel.Description, channel.IsDefault, channel.IsDirectMessage
                ? "/dm/" + Uri.EscapeDataString(channel.GetOtherParticipant(user.Username) ?? "")
                : channel.IsDefault ? "/lobby" : $"/room/{id}", channel.CanWrite(user.Id, users.IsAdmin(user.Id)), hasMore ?? chat.HasMoreMessages(user, id, RecentLimit),
            checkpoint.Unread, chat.IsChannelMuted(user.Id, id), [], checkpoint.Received, checkpoint.ReadThrough,
            channel.IsDirectMessage ? chat.IsChannelMuted(user.Id, id) : !notifications.IsServerMuted(user) && user.NotifRoomMode == NotificationMode.Individual && notifications.IsChannelMutedIndividually(user, id, false), changes.ContentVersion(id), !users.IsAdmin(user.Id) && (channel.HistoryLimit != HistoryLimit.Unlimited || channel.SinceJoined), changes.HistoryVersion(id));
    }

    public ReaderConversation? Conversation(User user, Guid id, int? limit = null)
    {
        lock (chat.GetChannelLock(id))
        {
            var metadata = Metadata(user, id);
            if (metadata == null)
                return null;
            var page = chat.GetMessagesPaginated(id, limit ?? RecentLimit, isAdmin: users.IsAdmin(user.Id), userId: user.Id);
            return metadata with
            {
                HasMore = page.HasMore,
                Messages = page.Messages.Select(m => Message(m, user.Id)).ToArray()
            };
        }
    }

    public ReaderMessage Message(ChatMessage message, Guid? viewerId = null)
    {
        ReaderReaction[] reactions;
        lock (message.Reactions)
            reactions = message.Reactions.GroupBy(r => r.Emoji)
                .Select(g => new ReaderReaction(g.Key, g.Select(r => r.Username).Order().ToArray())).ToArray();
        var author = users.GetById(message.UserId);
        var target = message.ReplyToMessageId is { } targetId ? chat.GetMessageById(message.ChannelId, targetId) : null;
        var viewer = viewerId is { } id ? users.GetById(id) : null;
        ReaderReply? reply = null;
        if (target != null && viewer != null && chat.CanReadMessage(viewer, target))
        {
            var targetAuthor = users.GetById(target.UserId);
            reply = new(target.Id, targetAuthor != null ? Summary(targetAuthor) : new(target.UserId, target.Username, target.Username, null, AvatarColor.GetGradientCss(target.Username)),
                string.IsNullOrEmpty(target.Content) && target.HasMedia ? "Click to see attachment" : target.Content);
        }
        return new(message.Id, viewerId == message.UserId ? message.OperationId : null, author != null ? Summary(author) : new(message.UserId, message.Username,
            message.Username, null, AvatarColor.GetGradientCss(message.Username)), message.Content, DateTime.SpecifyKind(message.Timestamp, DateTimeKind.Utc),
            message.IsEdited, message.ReplyToMessageId,
            message.ImageUrls.Select(url => new ReaderImage(ImageService.GetMediumUrl(url), ImageService.GetLargeUrl(url))).ToArray(),
            message.VideoUrls.ToArray(), message.GifAttachments.Count, reactions,
            message.GifAttachments.Select(a => gifs.GetEntry(a.GifEntryId)).OfType<GifEntry>().Select(e => OfflineContent.Gif(e, gifs, viewerId ?? Guid.Empty, users.GetById(e.UploadedByUserId ?? Guid.Empty)?.EffectiveDisplayName)).ToArray(),
            LinkPreviewService.ExtractUrls(message.Content).Take(5).Select(url =>
            {
                var preview = previewSettings.Enabled && !message.HasMedia
                    ? previews.GetPreview(message.Id, url) : previews.GetCachedPreview(url);
                var cached = media.GetCachedMedia(url);
                if (cached == null && preview?.HasContent != true && preview?.CachedMediaUrl == null)
                    return null;
                // Enrich media on disk hits too: dimensions reserve portrait
                // players before metadata loads, and the sidecar title survives empty OG scrapes.
                return new LinkPreview
                {
                    Url = url,
                    Title = string.IsNullOrEmpty(preview?.Title) ? cached?.Title : preview.Title,
                    Description = preview?.Description,
                    ImageUrl = string.IsNullOrEmpty(preview?.ImageUrl) ? cached?.Thumbnail : preview.ImageUrl,
                    SiteName = preview?.SiteName,
                    Failed = preview?.Failed ?? false,
                    CachedMediaUrl = cached?.LocalUrl ?? preview?.CachedMediaUrl,
                    MediaType = cached?.MediaType ?? preview?.MediaType,
                    CachedPosterUrl = cached?.PosterUrl ?? preview?.CachedPosterUrl,
                    MediaDurationSeconds = cached?.DurationSeconds ?? preview?.MediaDurationSeconds,
                    MediaWidth = cached is { Width: > 0, Height: > 0 } ? cached.Width : preview?.MediaWidth,
                    MediaHeight = cached is { Width: > 0, Height: > 0 } ? cached.Height : preview?.MediaHeight
                };
            }).OfType<LinkPreview>().ToArray(), reply);
    }

    public (string Epoch, long Sequence, ReaderConversation? Conversation, ReaderMessage? Message) Capture(User user, Guid id, Guid? messageId, bool full = false)
    {
        lock (chat.GetChannelLock(id))
        {
            var conversation = full ? Conversation(user, id) : Metadata(user, id);
            var message = messageId is { } target ? chat.GetMessageById(id, target) : null;
            return (Epoch, Stamp(), conversation,
                conversation != null && message != null && chat.CanReadMessage(user, message) ? Message(message, user.Id) : null);
        }
    }

    // Expensive media/emoji projection is shared; only reply permission and favorite flags vary by viewer.
    public ReaderMessage ForViewer(ReaderMessage projected, ChatMessage message, User viewer)
    {
        var target = message.ReplyToMessageId is { } id ? chat.GetMessageById(message.ChannelId, id) : null;
        ReaderReply? reply = null;
        if (target != null && chat.CanReadMessage(viewer, target))
        {
            var author = users.GetById(target.UserId);
            reply = new(target.Id, author != null ? Summary(author) : new(target.UserId, target.Username, target.Username, null, AvatarColor.GetGradientCss(target.Username)),
                string.IsNullOrEmpty(target.Content) && target.HasMedia ? "Click to see attachment" : target.Content);
        }
        return projected with
        {
            OperationId = viewer.Id == message.UserId ? message.OperationId : null,
            Reply = reply,
            Gifs = message.GifAttachments.Count == 0 ? projected.Gifs :
            message.GifAttachments.Select(a => gifs.GetEntry(a.GifEntryId)).OfType<GifEntry>()
                .Select(e => OfflineContent.Gif(e, gifs, viewer.Id, users.GetById(e.UploadedByUserId ?? Guid.Empty)?.EffectiveDisplayName)).ToArray()
        };
    }

    private static object DateSettings(User user)
    {
        var zone = LocaleResolver.ResolveTimeZone(user.TimeZone) ?? TimeZoneInfo.Utc;
        var format = LocaleResolver.GetFormat(user.DateFormat);
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        try
        {
            culture = LocaleResolver.SanitizeCulture(new System.Globalization.CultureInfo(LocaleResolver.GetCultureOverride(user.DateFormat) ?? user.Locale ?? ""));
        }
        catch { }
        var id = zone.Id;
        if (TimeZoneInfo.TryConvertWindowsIdToIanaId(id, out var iana))
            id = iana;
        return new
        {
            zone = id,
            offsetMinutes = zone.BaseUtcOffset.TotalMinutes,
            format.Time,
            format.DateInYear,
            format.FullDate,
            culture.DateTimeFormat.DateSeparator,
            culture.DateTimeFormat.TimeSeparator,
            culture.DateTimeFormat.AMDesignator,
            culture.DateTimeFormat.PMDesignator
        };
    }

    public ReaderSnapshot Header(User user)
    {
        var channels = Channels(user);
        var limit = Math.Min(RecentLimit, Math.Max(1, 20000 / Math.Max(1, channels.Length)));
        return new ReaderSnapshot(2, "", Epoch, 0, Summary(user), users.IsAdmin(user.Id), user.Theme ?? "discord-dark",
            user.FontSize, user.TimeZone, user.DateFormat, branding.ProjectName, limit,
            true, limits.MaxTextLength, users.GetAllUsers().Where(u => u.Id == user.Id || chat.HasActiveSession(u.Username) || channels.Any(c => c.IsDirectMessage && c.CanAccess(u.Id))).OrderBy(u => u.Username).Select(Summary).ToArray(), [], limits.MaxOperationsPerBatch, limits.MaxBatchBytes, limits.MaxFilesPerMessage, limits.AllowedExtensions, limits.MaxUploadBytes, limits.HistoryPageSize, limits.HistoryMaxMessages, limits.ReadBatch, limits.TypingTimeoutMs, limits.AwayAfterMs, DateSettings(user));
    }
}
