using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Yap.Helpers;
using Yap.Models.Accounts;
using Yap.Models.Notifications;
using Yap.Services.Accounts;
using Yap.Services.Media;
using Yap.Services.Notifications;
using Yap.Services.Presence;

namespace Yap.Endpoints;

/// <summary>
/// The signed-in person's own account: everything the Settings page edits (ST-04 to ST-20), the devices (AU-19,
/// AU-20), the login link and the secret code (AU-11, AU-13), and the mutes (NT-16 to NT-22). Every change saves at
/// once (ST-02) and reaches the person's other devices through the <c>me</c> hub message.
/// </summary>
public static class AccountEndpoints
{
    private const long MaxAvatarBytes = 10 * 1024 * 1024;   // ST-04

    public static void MapAccount(this RouteGroupBuilder api)
    {
        var account = api.MapGroup("/account");

        // ---- profile and appearance -----------------------------------------------------------------------

        account.MapPatch("", (AccountPatch body, ClaimsPrincipal me, UserService users) =>
        {
            var user = users.GetById(me.Id());
            if (user is null) return Results.Unauthorized();
            // A field that is absent from the body keeps its value; a blank string clears it. The limits are the services' (ST-05 to ST-10).
            string? error = null;
            if (body.DisplayName is not null || body.Bio is not null || body.Location is not null)
                error ??= users.UpdateProfile(user.Id, body.DisplayName is null ? user.DisplayName : Blank(body.DisplayName), user.ProfilePictureUrl,
                    body.Bio is null ? user.Bio : Blank(body.Bio), body.Location is null ? user.Country : Blank(body.Location));
            if (body.Theme is not null) error ??= users.UpdateTheme(user.Id, body.Theme);
            if (body.FontSize is not null) error ??= users.UpdateFontSize(user.Id, body.FontSize);
            if (body.TimeZone is not null || body.Locale is not null || body.DateFormat is not null)
                users.UpdateLocale(user.Id, body.TimeZone ?? user.TimeZone, body.Locale ?? user.Locale, body.DateFormat ?? user.DateFormat);
            if (body.SmartLoginOptOut is { } optOut) users.SetSmartLoginOptOut(user.Id, optOut);
            return error is null ? Results.NoContent() : Results.Problem(error, statusCode: 400);
        });

        // Lax cookies are not sent on cross-site form posts, which is the protection a form upload needs here.
        account.MapPut("/avatar", async (IFormFile file, ClaimsPrincipal me, UserService users, ImageService images) =>
        {
            if (file.Length is 0 or > MaxAvatarBytes || !file.ContentType.StartsWith("image/"))
                return Results.Problem("Choose an image up to 10 MB", statusCode: 400);
            var user = users.GetById(me.Id());
            if (user is null) return Results.Unauthorized();
            await using var stream = file.OpenReadStream();
            var url = await images.GenerateProfilePictureAsync(stream, user.Id);
            if (url is null) return Results.Problem("Choose an image up to 10 MB", statusCode: 400);
            users.UpdateProfile(user.Id, user.DisplayName, url, user.Bio, user.Country);
            return Results.Ok(new { avatarUrl = url });
        }).DisableAntiforgery();

        account.MapDelete("/avatar", (ClaimsPrincipal me, UserService users, ImageService images) =>
        {
            var user = users.GetById(me.Id());
            if (user is null) return Results.Unauthorized();
            images.DeleteProfilePicture(user.Id);
            users.UpdateProfile(user.Id, user.DisplayName, null, user.Bio, user.Country);
            return Results.NoContent();
        });

        account.MapGet("/location", (HttpContext http, GeoLocationService geo) =>
            geo.Lookup(IpHelper.GetClientIp(http)) is { Country.Length: > 0 } info
                ? Results.Ok(new { location = info.Country })
                : Results.NoContent());   // ST-06: Detect only when the server can find the country

        // The Time & Date cards: the orders and clocks with the language's guess first, and the cultures whose
        // separators the person can pick when the language and the zone's country differ (ST-19, ST-20).
        account.MapGet("/locale-options", (ClaimsPrincipal me, UserService users) =>
        {
            var user = users.GetById(me.Id());
            if (user is null) return Results.Unauthorized();
            var (order, clock, culture) = LocaleResolver.ParseDateFormat(user.DateFormat);
            var cultures = LocaleResolver.GetAvailableCultures(user.Locale, user.TimeZone);
            return Results.Ok(new
            {
                dateOrders = LocaleResolver.GetOrderedDateOrders(user.Locale).Select(o => o.Id),
                clocks = LocaleResolver.GetOrderedClockStyles(user.Locale).Select(c => c.Id),
                cultures = cultures.Select(c => new { name = c.Name, nativeName = c.NativeName }),
                current = new { order, clock, culture = culture ?? cultures.FirstOrDefault()?.Name },
            });
        });

        // ---- devices (AU-19, AU-20) --------------------------------------------------------------------------

        account.MapGet("/devices", (ClaimsPrincipal me, string? device, PresenceService presence, UserService users) =>
            Results.Ok(new DevicesDto(presence.SessionsOf(me.Id())
                .GroupBy(s => s.DeviceId)
                .Select(g => new DeviceDto(g.Any(s => s.IsMobile), g.First().ClientIp, g.Max(s => s.LastHeartbeatAt), g.Key == device))
                .OrderByDescending(d => d.Current).ThenByDescending(d => d.LastActiveAt)
                .ToList(), users.SignOutOthersAllowedAt(me.Id(), device))));

        account.MapPost("/devices/sign-out-others", async (SignOutOthersRequest body, ClaimsPrincipal me, HttpResponse response,
            UserService users, PresenceService presence, PushSubscriptionStore push, IHubContext<ChatHub> hub) =>
        {
            var user = users.GetById(me.Id());
            if (user is null) return Results.Unauthorized();
            // A device in its first hour cannot do this (AU-20): the bot's message about a new sign-in reaches that
            // device too, and a person who got in through smart login must not sign the owner out. The client
            // shows the button disabled; the check here is the one that counts. The id in the body is the only thing
            // that tells the devices of one account apart (they share the cookie), so it must stay known to its own
            // device alone: see DeviceDto.
            if (users.SignOutOthersAllowedAt(user.Id, body.DeviceId) is { } allowedAt && allowedAt > DateTime.UtcNow)
                return Results.Problem("Available one hour after this device signed in", statusCode: 403);

            // The other devices are told FIRST, before the token changes. A connection on long polling sends a new
            // request, with its cookie, each time one is answered, and after the rotation that request is a 401: the
            // device loses its connection with no word and learns of the sign-out from the failure. With the rotation
            // first, the 401 came before "signedOut" was sent in 9 runs of 480 of the test of AU-20 (2026-11-11; a
            // probe showed the 401 5 to 23 ms after the POST). Told now, the message leaves with the request that is
            // already waiting. A WebSocket sends no new request, so it never had this order problem.
            foreach (var session in presence.SessionsOf(user.Id).Where(s => s.DeviceId != body.DeviceId))
                await hub.Clients.Client(session.ConnectionId).SendAsync("signedOut");

            var token = users.RotateToken(user.Id);                    // every other cookie fails the lookup from now on
            if (token is null) return Results.Problem("Failed", statusCode: 500);
            AuthCookie.Set(response, token);                            // this browser keeps its session; its other tabs share the cookie
            users.ForgetKnownIps(user.Id);
            users.ForgetOtherDevices(user.Id, body.DeviceId);           // the others come back as new devices, with the hour
            string? passphrase = null;
            if (users.HasPassword(user.Username))                       // a leaked code dies with the other devices
            {
                passphrase = UserService.GeneratePassphrase();
                users.SetPassword(user.Id, passphrase);
            }
            foreach (var sub in push.GetSubscriptions(user.Username).Where(s => s.Endpoint != body.PushEndpoint).ToList())
                await push.RemoveOwnAsync(user.Username, sub.Endpoint);     // NT-24

            // Also a connection that opened after the telling above: its cookie is dead now, and it is not this device.
            foreach (var session in presence.SessionsOf(user.Id).Where(s => s.DeviceId != body.DeviceId))
                presence.End(session);
            return Results.Ok(new { passphrase });
        });

        // ---- the login link (AU-11, ST-12) -------------------------------------------------------------------

        account.MapGet("/link", (ClaimsPrincipal me, AccessLinkService links) =>
            links.GetActiveForUser(me.Id()) is { } link ? Results.Ok(LinkDto.From(link, links, me.Id())) : Results.NoContent());

        account.MapPost("/link", (ClaimsPrincipal me, AccessLinkService links) =>
            Results.Ok(LinkDto.From(links.CreateForUser(me.Id(), me.Id()), links, me.Id())));   // a new link revokes the old one

        account.MapDelete("/link", (ClaimsPrincipal me, AccessLinkService links) =>
        {
            if (links.GetActiveForUser(me.Id()) is { } link) links.Revoke(link.Id);
            return Results.NoContent();
        });

        account.MapPut("/link/expiry", (ExpiryRequest body, ClaimsPrincipal me, AccessLinkService links) =>
        {
            if (links.GetActiveForUser(me.Id()) is not { } link) return Results.NotFound();
            links.SetExpiry(link.Id, body.ExpiresAt);
            return Results.NoContent();
        });

        // ---- the secret code (AU-13, ST-14) ------------------------------------------------------------------
        // Retired since 2026-10-18: an account keeps the code it has, can replace it and can disable it, but
        // nothing creates a new one. The login link does this job, and its code is typed on the verification
        // page the same way (AU-12). Sign-out-others above still rotates an existing code (AU-20).

        account.MapGet("/passphrase", (ClaimsPrincipal me, UserService users) =>
            users.GetPassword(me.Id()) is { } code ? Results.Ok(new { passphrase = code }) : Results.NoContent());

        account.MapPost("/passphrase", (ClaimsPrincipal me, UserService users) =>
        {
            if (users.GetPassword(me.Id()) is null) return Results.Problem("Secret codes are retired. Use your login link.", statusCode: 410);
            var code = UserService.GeneratePassphrase();
            users.SetPassword(me.Id(), code);
            return Results.Ok(new { passphrase = code });
        });

        account.MapDelete("/passphrase", (ClaimsPrincipal me, UserService users) =>
        {
            users.SetPassword(me.Id(), null);
            return Results.NoContent();
        });

        // ---- mutes (NT-16 to NT-22) --------------------------------------------------------------------------

        account.MapPut("/mutes", (MutesPatch body, ClaimsPrincipal me, NotificationSettingsService mutes) =>
        {
            var id = me.Id();
            if (body.Server is { } server) mutes.SetServerMute(id, server.Muted, server.Muted ? server.Until : null);
            if (body.DmMode is { } dm) mutes.SetDmMode(id, dm);
            if (body.RoomMode is { } room) mutes.SetRoomMode(id, room);
            if (body.NewDmsMuted is { } newDms) mutes.SetNewDmsMuted(id, newDms);
            if (body.Channel is { } channel) mutes.SetChannelMuted(id, channel.ChannelId, channel.Muted);
            return Results.NoContent();
        });
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

/// <summary>Only the fields present are changed. A present empty string clears a profile field.</summary>
public sealed record AccountPatch(string? DisplayName, string? Bio, string? Location, string? Theme, int? FontSize,
    string? TimeZone, string? Locale, string? DateFormat, bool? SmartLoginOptOut);

/// <summary>A row of the device list. It has NO device id, and must not get one: the id is what a device proves its
/// age with (AU-20). With the ids in this list, a device in its first hour read the id of an older device here and
/// sent it with "sign out all other devices", and the server checked the age of the older device.</summary>
public sealed record DeviceDto(bool IsMobile, string? Ip, DateTime LastActiveAt, bool Current);

/// <summary>The device list and when this device may sign the others out: now, or the end of its first hour (AU-20).</summary>
public sealed record DevicesDto(List<DeviceDto> Devices, DateTime SignOutOthersAllowedAt);

public sealed record SignOutOthersRequest(string DeviceId, string? PushEndpoint);

public sealed record LinkDto(string Code, string Url, DateTime CreatedAt, DateTime? ExpiresAt)
{
    public static LinkDto From(AccessLink link, AccessLinkService links, Guid viewerId) => new(link.Code, links.BuildUrl(link.Code, viewerId), link.CreatedAt, link.ExpiresAt);
}

public sealed record ExpiryRequest(DateTime? ExpiresAt);

public sealed record MutesPatch(ServerMutePatch? Server, NotificationMode? DmMode, NotificationMode? RoomMode, bool? NewDmsMuted, ChannelMutePatch? Channel);

public sealed record ServerMutePatch(bool Muted, DateTime? Until);

public sealed record ChannelMutePatch(Guid ChannelId, bool Muted);
