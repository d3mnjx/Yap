using System.Text.Json;
using System.Text.Json.Nodes;
using Yap.Helpers;
using Yap.Middleware;
using Yap.Models;
using Yap.Services;

namespace Yap.Endpoints;

/// <summary>
/// The PWA install/launch hand-off: a dynamic manifest whose start_url carries a login
/// link token, plus the /pwa-launch endpoint that redeems it.
///
/// Why: an installed PWA (iOS Add-to-Home-Screen especially) gets an isolated cookie jar,
/// so the browser's auth cookie never carries over — every iOS install's first launch
/// landed on the login screen, and users re-registered under new names. The manifest is
/// fetched by the logged-in browser at install time (link rel=manifest has
/// crossorigin="use-credentials"), which is the one moment identity can be smuggled
/// into the future PWA via its start_url.
/// </summary>
public static class PwaEndpoints
{
    public static void MapPwaEndpoints(this WebApplication app)
    {
        // Replaces the old static wwwroot/manifest.webmanifest (deleted — it would shadow
        // this route). The branding middleware in Program.cs also skips this path.
        app.MapGet("/manifest.webmanifest", (HttpContext context, UserService userService,
            LinkTokenService linkTokens, ChatConfigService chatConfig, IWebHostEnvironment env) =>
        {
            var manifest = LoadBaseManifest(env, chatConfig.ProjectName);

            var cookie = context.Request.Cookies[AuthMiddleware.CookieName];
            var user = string.IsNullOrEmpty(cookie) ? null : userService.AuthenticateByToken(cookie);
            manifest["start_url"] = user is null ? "/" : $"/pwa-launch?lt={linkTokens.Mint(user)}";
            // Explicit scope: the default would derive from start_url's directory, and a
            // "/pwa-launch?..." start_url must not narrow the app's scope.
            manifest["scope"] = "/";
            // Stable identity across token rotations. Older token-derived Android installs
            // keep launching, but may not receive manifest updates; see the deploy note.
            if (manifest["id"] == null) manifest["id"] = "/";

            // no-store: a token must never be cached, and an anonymous copy cached
            // pre-login must not be what a later install picks up.
            // Known gap, accepted: Chrome sometimes reuses an already-fetched manifest for the
            // install prompt. If that copy was fetched pre-login the install gets start_url "/".
            // Harmless on Android (the Lax cookie covers it). iOS Safari fetches the manifest at
            // Add-to-Home-Screen time, so the funnel that matters always gets a fresh token.
            context.Response.Headers.CacheControl = "no-store";
            return Results.Content(manifest.ToJsonString(), "application/manifest+json");
        });

        app.MapGet("/pwa-launch", (HttpContext context, UserService userService,
            LinkTokenService linkTokens, UserActionLogService actionLog, string? lt) =>
        {
            // Every launch after the first: the PWA already owns a cookie — it wins and
            // the token (possibly long expired) is simply ignored.
            var cookie = context.Request.Cookies[AuthMiddleware.CookieName];
            if (!string.IsNullOrEmpty(cookie) && userService.AuthenticateByToken(cookie) is not null)
                return Results.Redirect("/");

            if (!string.IsNullOrEmpty(lt) && linkTokens.Validate(lt) is { } user)
            {
                // First launch with an empty jar: plant the auth cookie *inside the PWA's
                // cookie jar* — every subsequent launch then rides it like a normal browser.
                var ip = IpHelper.GetClientIp(context);
                AuthMiddleware.SetAuthCookie(context, user.Token);
                userService.RecordKnownIp(user.Id, ip);
                actionLog.Log(user.Id.ToString(), UserActionLog.KnownActions.LOGIN,
                    info: $"pwa_handoff:{user.Username}", ip: ip ?? "unknown",
                    userAgent: context.Request.Headers.UserAgent.ToString());
            }

            // A bad/expired token intentionally reveals nothing (no login oracle) — the
            // user just falls into the normal flow, where the login link (or an older
            // account's passphrase) is the recovery.
            return Results.Redirect("/");
        });
    }

    /// <summary>
    /// Deployments brand the manifest by dropping Data/branding/manifest.webmanifest — use
    /// it as the base document so custom name/icons survive; start_url/scope stay ours.
    /// </summary>
    private static JsonObject LoadBaseManifest(IWebHostEnvironment env, string projectName)
    {
        var brandingPath = Path.Combine(env.ContentRootPath, "Data", "branding", "manifest.webmanifest");
        if (File.Exists(brandingPath))
        {
            try
            {
                if (JsonNode.Parse(File.ReadAllText(brandingPath)) is JsonObject branded)
                    return branded;
            }
            catch (JsonException)
            {
                // Malformed branding file — fall through to the built-in default rather
                // than breaking installability for every visitor.
            }
        }

        return new JsonObject
        {
            ["name"] = projectName,
            ["short_name"] = projectName,
            ["description"] = "Super minimalistic self-hosted chat",
            ["display"] = "standalone",
            ["background_color"] = "#1a1a2e",
            ["theme_color"] = "#1a1a2e",
            ["orientation"] = "any",
            ["icons"] = new JsonArray(
                new JsonObject { ["src"] = "icon.svg", ["sizes"] = "any", ["type"] = "image/svg+xml", ["purpose"] = "any" },
                new JsonObject { ["src"] = "icon-192.png", ["sizes"] = "192x192", ["type"] = "image/png", ["purpose"] = "any maskable" },
                new JsonObject { ["src"] = "icon-512.png", ["sizes"] = "512x512", ["type"] = "image/png", ["purpose"] = "any maskable" }),
            ["categories"] = new JsonArray("social", "communication"),
            ["shortcuts"] = new JsonArray(
                new JsonObject { ["name"] = "Open Chat", ["url"] = "/lobby", ["description"] = "Go to the lobby" })
        };
    }
}
