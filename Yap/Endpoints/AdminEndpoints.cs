using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Yap.Helpers;
using Yap.Configuration;
using Yap.Models.Accounts;
using Yap.Models.Admin;
using Yap.Models.Chat;
using Yap.Models.Gifs;
using Yap.Services.Accounts;
using Yap.Services.Admin;
using Yap.Services.Chat;
using Yap.Services.Gifs;
using Yap.Services.Media;
using Yap.Services.Notifications;
using Yap.Services.Persistence;
using Yap.Services.Presence;

namespace Yap.Endpoints;

/// <summary>
/// The administration page's data and actions (docs/spec/admin.md). Every route is behind the admin policy, which
/// answers 404 to everyone else. Reads compose from the services; actions call one service each.
/// </summary>
public static class AdminEndpoints
{
    public static void MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/admin").RequireAuthorization(YapCookieAuthHandler.AdminPolicy);

        // ---- Users (AD-04 to AD-07) ------------------------------------------------------------------------

        admin.MapGet("/users", async (UserService users, PresenceService presence, SystemBotService bot, UserActionLogService log, GeoLocationService geo) =>
        {
            var lastActions = await log.GetLastActionPerUserAsync();
            var recentIps = await log.GetRecentIPsPerUserAsync();
            var all = users.GetAllUsers().OrderByDescending(u => u.LastSeenAt ?? u.CreatedAt).ToList();
            var rows = all.Select(u => new AdminUserDto(u.Id,
                u.Username, u.DisplayName, u.ProfilePictureUrl, users.IsAdmin(u.Id), bot.IsBotUser(u.Username),
                presence.StatusPill(u.Id), u.PwaInstalledAt, u.CreatedAt,
                lastActions.TryGetValue(u.Id.ToString(), out var last) ? new LastActionDto(last.Action, last.Date) : null,
                u.TimeZone, u.Locale,
                (recentIps.GetValueOrDefault(u.Id.ToString()) ?? []).Select(ip => new IpDto(ip, geo.CountryOf(ip), null)).ToList())).ToList();

            // Themes in order of use; a theme the registry no longer knows counts as the default (AD-07).
            var effective = all.Select(u => ThemeRegistry.IsKnown(u.Theme) ? u.Theme! : ThemeRegistry.DefaultId).ToList();
            var themes = ThemeRegistry.All
                .Select(t => new ThemeUseDto(t.Id, t.Name, t.PreviewBg, t.PreviewAccent, effective.Count(id => id == t.Id)))
                .OrderByDescending(t => t.Count).ToList();
            return Results.Ok(new { users = rows, themes, total = all.Count });
        });

        admin.MapGet("/users/{username}", async (string username, UserService users, PushSubscriptionStore push, UserActionLogService log, GeoLocationService geo) =>
        {
            var user = users.GetByUsername(username);
            if (user is null) return Results.NotFound();
            var (ips, agents) = await log.GetUserConnectionDetailsAsync(user.Id.ToString());
            var theme = ThemeRegistry.IsKnown(user.Theme) ? user.Theme! : ThemeRegistry.DefaultId;
            return Results.Ok(new
            {
                pushSubscriptions = push.GetSubscriptions(user.Username).Count(),
                pwaInstalledAt = user.PwaInstalledAt,
                theme = new { chosen = user.Theme, effective = theme, name = ThemeRegistry.All.First(t => t.Id == theme).Name },
                ips = ips.Select(i => new IpDto(i.IP, geo.CountryOf(i.IP), i.LastSeen)).ToList(),
                userAgents = agents.Select(a => new { userAgent = a.UserAgent, lastSeen = a.LastSeen }).ToList(),
            });
        });

        // ---- Danger zone (AD-38 to AD-40) ---------------------------------------------------------------------

        // Oldest first, so the admin reads the list from the surest case down. Not under /users/: a person may be
        // named "inactive", and the literal segment would shadow their detail route.
        admin.MapGet("/inactive", (int? days, AccountDeletionService deletion) =>
            Results.Ok(new { users = deletion.Inactive(Math.Max(1, days ?? AccountDeletionService.DefaultInactiveDays))
                .Select(u => new InactiveUserDto(u.Username, u.DisplayName, u.ProfilePictureUrl, AccountDeletionService.LastActiveAt(u))).ToList() }));

        // One route for one account and for the sweep: the client sends the names it showed the admin, so what was
        // confirmed is what goes. A refusal (the admin, the bot) stops the whole request before anything is deleted;
        // a name that is gone already is skipped, it may have been deleted from another tab.
        admin.MapPost("/users/delete", async (DeleteUsersRequest body, UserService users, PresenceService presence,
            AccountDeletionService deletion, IHubContext<ChatHub> hub) =>
        {
            var targets = (body.Usernames ?? []).Select(users.GetByUsername).OfType<User>().DistinctBy(u => u.Id).ToList();
            if (targets.Select(deletion.Refusal).FirstOrDefault(r => r is not null) is { } refusal)
                return Results.Problem(refusal, statusCode: 400);
            var deleted = 0;
            foreach (var user in targets)
            {
                foreach (var session in presence.SessionsOf(user.Id))
                    await hub.Clients.Client(session.ConnectionId).SendAsync("signedOut");   // the login page now, not after a failed reconnect
                if (await deletion.DeleteAsync(user.Id) is null) deleted++;
            }
            return Results.Ok(new { deleted });
        });

        // ---- Debug (AD-08) ----------------------------------------------------------------------------------

        admin.MapPost("/generate", (GenerateRequest body, ClaimsPrincipal me, ChatService chat) =>
        {
            var count = Math.Clamp(body.Count, 1, 5000);
            var generated = chat.GenerateTestMessages(body.ChannelId, me.Id(), me.Username(), count, TimeSpan.FromHours(Math.Max(1, body.Hours)));
            return generated == 0 ? Results.Problem("Unknown room", statusCode: 404) : Results.Ok(new { generated, hours = body.Hours });
        });

        // ---- Bot (AD-09) ------------------------------------------------------------------------------------

        admin.MapGet("/bot", (SystemBotService bot, UserService users) =>
        {
            var user = bot.BotUserId is { } id ? users.GetById(id) : null;
            return Results.Ok(new
            {
                username = bot.BotUsername,
                displayName = user?.DisplayName ?? bot.BotUsername,
                avatarUrl = user?.ProfilePictureUrl,
                customAvatar = user?.ProfilePictureUrl is { } url && url != SystemBotService.DefaultAvatarUrl,
                welcomeMessage = bot.WelcomeMessage,
                phoneMessage = bot.PhoneMessage,
                linkMessage = bot.LinkMessage,
                returnAfterHours = bot.ReturnAfterHours,
            });
        });

        admin.MapPut("/bot", async (BotRequest body, SystemBotService bot) =>
        {
            if (body.DisplayName is { Length: > 32 }) return Results.Problem("A display name has at most 32 characters.", statusCode: 400);
            if (body.WelcomeMessage is { Length: > 1000 } || body.PhoneMessage is { Length: > 1000 } || body.LinkMessage is { Length: > 1000 })
                return Results.Problem("A part of the welcome message has at most 1000 characters.", statusCode: 400);
            if (body.ReturnAfterHours is < 0 or > SystemBotService.MaxReturnAfterHours)
                return Results.Problem($"The return notice waits between 0 and {SystemBotService.MaxReturnAfterHours} hours.", statusCode: 400);
            if (body.DisplayName is { } name) bot.UpdateDisplayName(name.Trim());
            await bot.UpdateSettingsAsync(body.WelcomeMessage?.Trim(), body.PhoneMessage?.Trim(), body.LinkMessage?.Trim(), body.ReturnAfterHours);
            return Results.NoContent();
        });

        // The bot's picture, by the same rules as a person's own (ST-04). Lax cookies are not sent on cross-site
        // form posts, which is the protection a form upload needs here.
        admin.MapPut("/bot/avatar", async (IFormFile file, SystemBotService bot) =>
        {
            if (file.Length is 0 or > 10 * 1024 * 1024 || !file.ContentType.StartsWith("image/")) return Results.Problem("Choose an image up to 10 MB", statusCode: 400);
            await using var stream = file.OpenReadStream();
            var url = await bot.SetAvatarAsync(stream);
            return url is null ? Results.Problem("Choose an image up to 10 MB", statusCode: 400) : Results.Ok(new { avatarUrl = url });
        }).DisableAntiforgery();

        admin.MapDelete("/bot/avatar", (SystemBotService bot) => { bot.ResetAvatar(); return Results.NoContent(); });

        // ---- Settings (AD-10 to AD-14) ----------------------------------------------------------------------

        admin.MapGet("/settings", (RegistrationGateService gate, LinkPreviewSettingsService previews, GifAdminSettingsService gifSettings, GifService gifs,
            ServerConfig config, PersistenceWriter writer) => Results.Ok(new
        {
            registrationClosed = gate.RegistrationClosed,
            requireApproval = gate.RequireApproval,
            smartLogin = gate.SmartMode,
            linkPreviews = previews.Enabled,
            mediaCaching = previews.MediaCachingEnabled,
            mediaCachingAvailable = MediaCacheService.IsAvailable,   // AD-12: the switch is disabled without yt-dlp
            gifRating = gifSettings.KlipyRating,
            gifProviderConfigured = gifs.IsConfigured,
            uploadUrl = config.UploadUrl,
            beaconUrl = config.Ipv4BeaconUrl,
            persistence = writer.Enabled,                            // AD-03
            pending = gate.GetPendingUsers().Select(p => new PendingDto(p.Username, p.RequestedAt)).ToList(),
        }));

        admin.MapPut("/settings", async (SettingsRequest body, RegistrationGateService gate, LinkPreviewSettingsService previews, GifAdminSettingsService gifSettings) =>
        {
            if (body.RegistrationClosed is { } closed) await gate.SetRegistrationClosedAsync(closed);
            if (body.RequireApproval is { } approval) await gate.SetRequireApprovalAsync(approval);
            if (body.SmartLogin is { } smart) await gate.SetSmartModeAsync(smart);
            if (body.LinkPreviews is { } links) await previews.SetEnabledAsync(links);
            if (body.MediaCaching is { } caching)
            {
                if (caching && !MediaCacheService.IsAvailable) return Results.Problem("yt-dlp not found on this system.", statusCode: 400);
                await previews.SetMediaCachingEnabledAsync(caching);
            }
            if (body.GifRating is { } rating) await gifSettings.SetKlipyRatingAsync(rating);
            return Results.NoContent();
        });

        admin.MapPost("/pending/{username}/approve", (string username, RegistrationGateService gate) => { gate.ApproveUser(username); return Results.NoContent(); });
        admin.MapPost("/pending/{username}/reject", (string username, RegistrationGateService gate) => { gate.RejectUser(username); return Results.NoContent(); });

        // ---- Invites and login links (AD-15 to AD-17) --------------------------------------------------------

        admin.MapGet("/links", (ClaimsPrincipal me, AccessLinkService links, UserService users) =>
        {
            var all = links.GetAll();
            return Results.Ok(new
            {
                open = all.Where(l => !l.IsClaimed && l.IsActive).OrderByDescending(l => l.CreatedAt).Select(l => AdminLinkDto.From(l, links, users, me.Id())).ToList(),
                users = all.Where(l => l.IsClaimed && !l.IsRevoked).OrderByDescending(l => l.IsActive).ThenByDescending(l => l.CreatedAt).Select(l => AdminLinkDto.From(l, links, users, me.Id())).ToList(),
            });
        });

        admin.MapPost("/links", (CreateLinkRequest body, ClaimsPrincipal me, AccessLinkService links, UserService users, SystemBotService bot) =>
        {
            if (body.UserId is { } userId)
            {
                var user = users.GetById(userId);
                if (user is null || bot.IsBotUser(user.Username)) return Results.Problem("Unknown user", statusCode: 404);
                var link = links.CreateForUser(user.Id, me.Id(), body.ExpiresAt);   // replaces the person's link; the bot tells them
                _ = bot.NotifyLinkReplacedByAdminAsync(user, link);
                return Results.Ok(AdminLinkDto.From(link, links, users, me.Id()));
            }
            if (body.Note is { Length: > 64 }) return Results.Problem("A note has at most 64 characters.", statusCode: 400);
            return Results.Ok(AdminLinkDto.From(links.CreateInvite(me.Id(), string.IsNullOrWhiteSpace(body.Note) ? null : body.Note.Trim(), body.ExpiresAt), links, users, me.Id()));
        });

        admin.MapDelete("/links/{id:guid}", (Guid id, AccessLinkService links) => { links.Revoke(id); return Results.NoContent(); });
        admin.MapPut("/links/{id:guid}/expiry", (Guid id, ExpiryRequest body, AccessLinkService links) => { links.SetExpiry(id, body.ExpiresAt); return Results.NoContent(); });

        // ---- Logs, Media, Visitors (AD-18 to AD-20); database-only features (AD-03) ---------------------------

        admin.MapGet("/logs", async (string? action, string? user, int? skip, UserActionLogService log, UserService users, PersistenceWriter writer) =>
        {
            if (!writer.Enabled) return Results.Ok(new { available = false, rows = Array.Empty<object>() });
            string? uid = null;
            if (!string.IsNullOrWhiteSpace(user))
            {
                var match = users.GetByUsername(user.Trim());
                if (match is null) return Results.Ok(new { available = true, rows = Array.Empty<object>() });
                uid = match.Id.ToString();
            }
            var rows = await log.GetLogsAsync(uid, string.IsNullOrWhiteSpace(action) ? null : action, skip ?? 0, 100);
            return Results.Ok(new
            {
                available = true,
                rows = rows.Select(r => new { r.Date, username = Guid.TryParse(r.UserUid, out var g) ? users.GetById(g)?.Username ?? r.UserUid : r.UserUid, r.Action, r.IP, r.Info }).ToList(),
            });
        });

        admin.MapGet("/media", async (string? type, string? user, int? skip, MediaUploadLogService media, GifService gifs, PersistenceWriter writer) =>
        {
            if (!writer.Enabled) return Results.Ok(new { available = false });
            var (files, bytes, images, videos, voices) = await media.GetStatsAsync();
            var rows = await media.GetLogsAsync(string.IsNullOrWhiteSpace(user) ? null : user, string.IsNullOrWhiteSpace(type) ? null : type, skip ?? 0, 100);
            return Results.Ok(new
            {
                available = true,
                stats = new { ffmpeg = VideoService.IsAvailable, totalFiles = files, totalBytes = bytes, images, videos, voices },
                rows = rows.Select(r => MediaRow(r, gifs)).ToList(),
            });
        });

        // One upload (AD-19). Without `force`, an upload a message still shows answers 409 with the count in the
        // text, so the page asks the admin before the message loses its picture. A GIF row goes the GIFs tab's way:
        // out of every library, its file kept while a message shows it (AD-23).
        admin.MapDelete("/media/{id:int}", async (int id, ClaimsPrincipal me, MediaCleanupService cleanup, bool force = false) =>
        {
            var (outcome, uses, bytes) = await cleanup.DeleteAsync(me.Id(), id, force);
            return outcome switch
            {
                MediaCleanupService.DeleteOutcome.Deleted => Results.Ok(new { bytes }),
                MediaCleanupService.DeleteOutcome.InUse => Results.Problem($"Used in {uses} message{(uses == 1 ? "" : "s")}.", statusCode: 409),
                MediaCleanupService.DeleteOutcome.NotAnUpload => Results.Problem("Not an upload.", statusCode: 400),
                _ => Results.Problem("Upload unknown", statusCode: 404),
            };
        });

        // The uploads no message shows any more (AD-19): a count first, then the delete. `database` scans the whole
        // saved history, not only the messages in memory (AD-03: the start may load the newest messages only).
        admin.MapGet("/media/unreferenced", async (MediaCleanupService cleanup, bool database = false) =>
            Results.Ok(await cleanup.UnreferencedAsync(database)));
        admin.MapPost("/media/prune", async (PruneRequest body, MediaCleanupService cleanup) =>
            Results.Ok(await cleanup.PruneAsync(body.Database)));

        admin.MapGet("/visitors", async (string? action, int? skip, UserActionLogService log, GeoLocationService geo, PersistenceWriter writer) =>
        {
            if (!writer.Enabled) return Results.Ok(new { available = false });
            var (visits, failures, uniqueIps, today) = await log.GetVisitorStatsAsync();
            var rows = await log.GetVisitorLogsAsync(string.IsNullOrWhiteSpace(action) ? null : action, skip ?? 0, 100);
            return Results.Ok(new
            {
                available = true,
                stats = new { visits, failures, uniqueIps, today },
                rows = rows.Select(r => new { r.Date, r.IP, country = geo.CountryOf(r.IP), r.Action, r.Url, r.Info, reason = VisitorReason(r.Info), r.UserAgent }).ToList(),
            });
        });

        // ---- GIFs (AD-21 to AD-23) --------------------------------------------------------------------------

        admin.MapGet("/gifs", (ClaimsPrincipal me, GifService gifs, UserService users) =>
        {
            var entries = gifs.GetAllEntries();
            var favorites = gifs.GetFavoriteCounts();
            return Results.Ok(new
            {
                stats = new
                {
                    ffmpeg = VideoService.IsAvailable,
                    totalBytes = entries.Sum(e => e.FileSizeBytes),
                    custom = entries.Count(e => e.SourceProviderId is null),
                    provider = entries.Count(e => e.SourceProviderId is not null),
                },
                serverFolders = gifs.GetServerFolders(),
                entries = entries.OrderByDescending(e => e.CreatedAt).Select(e => new
                {
                    card = GifEndpoints.Card(e, me.Id(), gifs, users),
                    source = e.SourceProviderId ?? "custom",
                    format = Path.GetExtension(e.GifUrl ?? e.Mp4Url ?? e.WebmUrl ?? "")?.TrimStart('.').ToLowerInvariant() is { Length: > 0 } ext ? ext : "?",
                    uses = e.UseCount,
                    favorites = favorites.GetValueOrDefault(e.Id),
                    e.CreatedAt,
                }).ToList(),
            });
        });

        admin.MapPut("/gifs/{id:guid}/server", (Guid id, ServerGifRequest body, GifService gifs) =>
            gifs.SetServerGif(id, body.On, body.Folder) ? Results.NoContent() : Results.Problem("GIF unavailable", statusCode: 404));

        admin.MapDelete("/gifs/{id:guid}", (Guid id, ClaimsPrincipal me, GifService gifs) => gifs.DeleteEntry(me.Id(), id, force: true) switch
        {
            GifDeleteResult.Deleted => Results.Ok(new { note = "Deleted." }),
            GifDeleteResult.SoftDeleted => Results.Ok(new { note = "Removed from everyone's libraries; the file stays while messages use it." }),
            _ => Results.Problem("GIF unavailable", statusCode: 404),
        });

        admin.MapGet("/gifs/export", (HttpContext ctx, GifService gifs) => GifEndpoints.StreamPackAsync(ctx, gifs, userId: null, "yap-server-gifs.zip"));

        // ---- Diagnostics (AD-24 to AD-28) -------------------------------------------------------------------

        // The server's standing notices for the admin page (the proxy that is not trusted, ProxyWatch) and the proxy
        // section of the Settings tab: the Cloudflare ranges, and this very request as the server sees it, so the
        // admin can tell a working chain from a wrong one by looking at their own address.
        admin.MapGet("/status", (HttpContext http, ProxyWatch proxy, CloudflareIps cloudflare) => Results.Ok(new
        {
            proxy = proxy.Status(),
            cloudflare = cloudflare.Status(),
            you = new
            {
                address = IpHelper.GetClientIp(http),
                peer = http.Connection.RemoteIpAddress is { } peer ? IpHelper.Unmapped(peer).ToString() : null,
                viaCloudflare = http.Connection.RemoteIpAddress is { } p && cloudflare.Contains(p),
                scheme = http.Request.Scheme,
            },
        }));

        admin.MapGet("/diagnostics", (ChatService chat, PresenceService presence, DiagnosticsCollectorService collector, NotificationAudit audit,
            PushNotificationService push, PersistenceWriter writer, SystemBotService bot, ILoggerFactory loggers, int seconds = 86_400, int step = 1) =>
        {
            var snapshots = collector.GetSeries(seconds, step);   // the chart's range (AD-28), bucketed by `step` seconds
            // The effective level, whatever config source set it: one line per database command at Information.
            var sqlLogged = loggers.CreateLogger("Microsoft.EntityFrameworkCore.Database.Command").IsEnabled(LogLevel.Information);
            return Results.Ok(new
            {
                latest = collector.GetLatest(),
                series = snapshots.Select(s => new { s.Timestamp, s.UniqueUsers, s.UserSessions, s.ActiveConnections, s.DisconnectedConnections, s.TotalMessages }).ToList(),
                sessions = presence.All().OrderBy(s => s.Username).ThenBy(s => s.ConnectedAt).Select(s => SessionRow(s, presence, chat)).ToList(),
                recentlyClosed = presence.RecentlyClosed().Select(s => SessionRow(s, presence, chat)).ToList(),
                users = presence.LatencyByUser().Select(u => new { u.UserId, u.Username, latency = u.Latency }).ToList(),   // AD-26: the waits per person
                push = new
                {
                    keyStatus = push.KeyStatus,
                    detail = push.KeyStatusDetail,
                    decisions = audit.GetPushDecisions().Where(d => !bot.IsBotUser(d.To)).ToList(),
                    results = audit.GetPushResults().Where(r => !bot.IsBotUser(r.To)).ToList(),
                },
                unread = audit.GetUnreadChanges().Where(u => !bot.IsBotUser(u.User)).ToList(),
                writer = new { enabled = writer.Enabled, depth = writer.Depth, lastError = writer.LastError, lastErrorAt = writer.LastErrorAt, sqlLogged },
                events = chat.GetDiagnostics().EventSubscribers,
            });
        });

        // One-second samples of the server under load (CPU, memory, GC, thread pool, hub rates, writer depth). The
        // admin Diagnostics tab polls a range up to seven days, bucketed by `step` seconds so the chart stays at a few
        // hundred points; the load-test orchestrator polls a few seconds at a time. `latest` is always the real last second.
        admin.MapGet("/load", (LoadMetrics load, int seconds = 60, int step = 1) =>
        {
            var series = load.Last(seconds, step);
            return Results.Ok(new { latest = load.Last(1).LastOrDefault(), series });
        });
    }

    // No s.DeviceId here, and the page shows none. A device proves its age with its own id (AU-20), so an id that
    // another device can read is a way to sign that device's owner out: a new device of an admin account read the
    // id of an older one from this answer. The same rule as for the device list (AccountEndpoints.DeviceDto).
    private static object SessionRow(Session s, PresenceService presence, ChatService chat) => new
    {
        s.ConnectionId, s.UserId, s.Username, s.IsMobile, s.Browser, s.Os, s.Pwa, s.ClientIp, s.ClientIpv4, s.Transport, s.ConnectedAt, s.Connected, s.ClosedAt, s.DroppedAt,
        s.Visible, s.LastInputAt, s.LastHeartbeatAt,
        status = presence.EffectiveOf(s.UserId),
        viewing = s.Viewing is { } id && chat.GetChannel(id) is { } c ? (c.IsDirectMessage ? $"DM: {c.Participant1} ↔ {c.Participant2}" : $"#{c.Name}") : null,
        ghost = s.Visible && !s.Connected,   // AD-25: counts as visible with no connection
        s.Latency,
        s.Load,   // AD-41: the boot report of the page load, when one came
    };

    // The preview and the link of one upload row (AD-19), by file type.
    private static object MediaRow(Yap.Models.Media.MediaUploadLog r, GifService gifs)
    {
        var stem = Path.GetFileNameWithoutExtension(r.StoredFileName);
        string? thumb = null, link = null;
        switch (r.FileType)
        {
            case "image": thumb = $"/uploads/{stem}_800px.webp"; link = $"/uploads/{r.StoredFileName}"; break;
            case "video": thumb = $"/uploads/{stem}_poster.webp"; link = r.CompressDurationMs.HasValue ? $"/uploads/{stem}.mp4" : $"/uploads/{r.StoredFileName}"; break;
            case "voice": link = $"/uploads/{r.StoredFileName}"; break;   // no picture: the page shows a small player on the link
            case "gif":
                if (Guid.TryParse(stem, out var id) && gifs.GetEntry(id) is { } e) { thumb = e.PreviewUrl ?? e.GifUrl ?? e.RemoteGifUrl; link = e.GifUrl ?? e.RemoteGifUrl; }
                break;
        }
        return new { r.Id, r.Date, r.Username, r.OriginalFileName, r.FileType, r.FileSize, r.CompressDurationMs, thumb, link };
    }

    // The failure codes the sign-in service writes, as the Visitors tab shows them (AD-20).
    private static string? VisitorReason(string? info)
    {
        if (string.IsNullOrEmpty(info)) return null;
        var code = info.Split(':', 2)[0];
        return code switch
        {
            "wrong_passphrase" => "Wrong passphrase",
            "multi_device_blocked" => "Multi-device blocked",
            "registration_closed" => "Registration closed",
            "bot_username" => "Bot username",
            "ip_mismatch" => "IP mismatch",
            "approval_not_consumed" or "approval_pending" => "Approval pending",
            _ => code,
        };
    }
}

public sealed record AdminUserDto(Guid Id, string Username, string? DisplayName, string? AvatarUrl, bool IsAdmin, bool IsBot, string Status,
    DateTime? PwaInstalledAt, DateTime CreatedAt, LastActionDto? LastAction, string? TimeZone, string? Locale, List<IpDto> RecentIps);
public sealed record LastActionDto(string Action, DateTime At);
public sealed record InactiveUserDto(string Username, string? DisplayName, string? AvatarUrl, DateTime LastActiveAt);
public sealed record DeleteUsersRequest(List<string>? Usernames);
public sealed record IpDto(string Ip, string? Country, DateTime? LastSeen);
public sealed record ThemeUseDto(string Id, string Name, string PreviewBg, string PreviewAccent, int Count);
public sealed record GenerateRequest(Guid ChannelId, int Count = 200, int Hours = 168);
public sealed record BotRequest(string? DisplayName, string? WelcomeMessage, string? PhoneMessage, string? LinkMessage, int? ReturnAfterHours);
public sealed record PruneRequest(bool Database);
public sealed record SettingsRequest(bool? RegistrationClosed, bool? RequireApproval, bool? SmartLogin, bool? LinkPreviews, bool? MediaCaching, KlipyRating? GifRating);
public sealed record PendingDto(string Username, DateTime RequestedAt);
public sealed record CreateLinkRequest(Guid? UserId, string? Note, DateTime? ExpiresAt);
public sealed record ServerGifRequest(bool On, string? Folder);

/// <summary>A link on the admin page. The code shows only while the admin may see it (AD-17).</summary>
public sealed record AdminLinkDto(Guid Id, string? Code, string? Url, string? Username, string? Note, DateTime CreatedAt, bool ByAdmin,
    DateTime? ExpiresAt, bool Active, bool Expired, bool Revoked, int UseCount, DateTime? LastUsedAt)
{
    public static AdminLinkDto From(AccessLink l, AccessLinkService links, UserService users, Guid viewerId) => new(
        l.Id, l.AdminCanSeeCode ? l.Code : null, l.AdminCanSeeCode ? links.BuildUrl(l.Code, viewerId) : null,
        l.UserId is { } uid ? users.GetById(uid)?.Username ?? "(deleted)" : null, l.Note, l.CreatedAt, l.CreatedById != l.UserId,
        l.ExpiresAt, l.IsActive, l.IsExpired, l.IsRevoked, l.UseCount, l.LastUsedAt);
}
