using System.Security.Claims;
using Yap.Configuration;
using Yap.Helpers;
using Yap.Models.Accounts;
using Yap.Models.Chat;
using Yap.Models.Notifications;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Emoji;
using Yap.Services.Gifs;
using Yap.Services.Media;
using Yap.Services.Notifications;
using Yap.Services.Presence;

namespace Yap.Endpoints;

/// <summary>
/// GET /api/bootstrap: one document with every value the client needs to draw the frame. Fetched at start and
/// after every hub connect; the client replaces its shared store with it and applies hub messages on top. The
/// device stores it and paints from the copy before any answer, so it carries everything the first paint needs,
/// the emoji image rules included. The rules are the largest part and change only with a deploy, so a client that
/// names the stamp of the rules it holds (?emojiStamp=) gets null in their place while they are current.
/// Anonymous: without a user it returns the project name and the login texts only, so the login, verify and
/// invite pages get their texts in the same first call (docs/architecture/bootstrap-and-events.md). Those pages
/// set their texts as plain text, so the emoji image rules are not in this answer: they would list every custom
/// pack to anyone who asks.
/// </summary>
public static class BootstrapEndpoints
{

    public static void MapBootstrap(this RouteGroupBuilder api)
    {
        api.MapGet("/bootstrap", (HttpContext http, ClaimsPrincipal principal,
            UserService users, ChatService chat, PresenceService presence, NotificationSettingsService mutes, GifService gifs,
            AccessLinkService links, RegistrationGateService gate, LinkPreviewSettingsService previews,
            PushNotificationService push, SystemBotService bot, ServerConfig config, EmojiImages images, string? emojiStamp) =>
        {
            if (!principal.IsSignedIn())
                return Results.Ok(new { config = new { config.ProjectName }, texts = config.LoginTexts() });

            var me = users.GetById(principal.Id());
            if (me is null) return Results.Unauthorized();

            var ip = IpHelper.GetClientIp(http);
            AuthCookie.Set(http.Response, me.Token);   // every visit extends the year (AU-18)
            users.RecordKnownIp(me.Id, ip);             // smart login remembers this network (AU-09)
            links.ObserveOrigin(me.Id, http.Request.Origin());           // this person's links use the address this person used (AU-15)

            return Results.Ok(new BootstrapDto(
                User: MeDto.From(me, users.IsAdmin(me.Id), links.HasActiveLink(me.Id)),
                Config: new ClientConfigDto(config.ProjectName, config.UploadUrl, config.MaxUploadSizeMB, VoiceService.MaxSeconds,
                    config.Ipv4BeaconUrl,
                    previews.Enabled, previews.MediaCachingEnabled,
                    new GifProviderDto(gifs.Provider.DisplayName, gifs.IsConfigured, gifs.Provider.AttributionImageUrl),
                    push.GetPublicKey(), BuildInfo.Time, gate.SmartMode, ThemeRegistry.All),
                Texts: config.Texts(),
                Rooms: chat.Rooms().Select(RoomDto.From).ToList(),
                Users: users.GetAllUsers().Select(u => UserDto.From(u, users.IsAdmin(u.Id), bot.IsBotUser(u.Username))).ToList(),
                Presence: presence.Effective(),
                Dms: chat.DmConversations(me.Id).Select(d => new DmDto(d.Channel.Id, d.Partner, d.LastMessageAt)).ToList(),
                Unread: chat.UnreadCounts(me.Id),
                Mutes: mutes.For(me.Id),
                Emoji: new EmojiStateDto(users.GetRecentEmojis(me.Username), chat.QuickReactions(me.Id)),
                FavoriteGifIds: gifs.GetFavorites(me.Id).Select(g => g.Id).ToList(),
                EmojiImages: images.Rules.Stamp == emojiStamp ? null : images.Rules));   // where emoji pictures come from (text.js useImages); null: the client's copy is current
        }).AllowAnonymous();
    }
}

public sealed record BootstrapDto(
    MeDto User, ClientConfigDto Config, TextsDto Texts, List<RoomDto> Rooms, List<UserDto> Users,
    Dictionary<string, EffectiveStatus> Presence, List<DmDto> Dms, Dictionary<Guid, int> Unread, MutesDto Mutes,
    EmojiStateDto Emoji, List<Guid> FavoriteGifIds, EmojiImagesDto? EmojiImages);

public sealed record ClientConfigDto(
    string ProjectName, string UploadUrl, int MaxUploadMB, int VoiceMaxSeconds, string BeaconUrl,
    bool LinkPreviews, bool MediaCaching, GifProviderDto GifProvider, string? VapidPublicKey, string BuildStamp, bool SmartLoginAllowed,
    IReadOnlyList<ThemeDefinition> Themes);   // the Settings theme grid (ST-08): the registry is the server's

public sealed record GifProviderDto(string Name, bool Configured, string AttributionImageUrl);

public sealed record EmojiStateDto(List<string> Recent, IReadOnlyList<string> QuickReactions);
