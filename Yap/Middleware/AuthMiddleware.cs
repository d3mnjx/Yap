using Yap.Helpers;
using Yap.Models;
using Yap.Services;

namespace Yap.Middleware;

/// <summary>
/// Validates auth token from cookie and populates UserStateService.
/// This runs before Blazor starts, enabling deep linking to work correctly.
/// </summary>
public class AuthMiddleware
{
    private readonly RequestDelegate _next;
    public const string CookieName = "yap_auth";

    public AuthMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, UserService userService, UserStateService userState)
    {
        var token = context.Request.Cookies[CookieName];

        if (!string.IsNullOrEmpty(token))
        {
            var user = userService.AuthenticateByToken(token);
            if (user != null)
            {
                userState.UserId = user.Id;
                userState.Username = user.Username;
                userState.DisplayName = user.DisplayName;
                userState.ProfilePictureUrl = user.ProfilePictureUrl;
                userState.Theme = user.Theme;
                userState.FontSize = user.FontSize;
                // Date/time format is an explicit cross-device preference — load it here so a
                // fresh circuit on any device starts with the saved value. Without this it stays
                // null, and ChatBase would re-guess it from the browser locale and persist that
                // guess, silently overwriting the user's chosen format. (TimeZone/Locale are
                // intentionally NOT loaded — they're auto-detected per device.)
                userState.DateFormat = user.DateFormat;
                userState.Status = UserStatus.Online;

                // Re-issue the cookie on plain document loads. This silently upgrades
                // cookies minted before the SameSite=Lax change below (a Strict cookie
                // is withheld on installed-PWA launch navigations, so those users landed
                // on the login page and re-registered under new names) and slides the
                // one-year expiry for active users. /auth/* is excluded so signin/signout
                // stay the only cookie writers on their own responses.
                if (HttpMethods.IsGet(context.Request.Method)
                    && !context.Request.Path.StartsWithSegments("/auth")
                    // The offline shell is anonymous cacheable HTML, never a cookie-refresh response.
                    && !Yap.Offline.ChatRoutes.IsShell(context.Request.Path)
                    && context.Request.Headers.Accept.ToString().Contains("text/html"))
                {
                    SetAuthCookie(context, token);

                    // Also refresh smart-login's IP memory here: long-lived cookie sessions
                    // never re-login, so page loads are where their current network shows up.
                    userService.RecordKnownIp(user.Id, IpHelper.GetClientIp(context));

                    // Retained Blazor sessions also remember only their own address.
                    userService.RecordLoginOrigin(user.Id, $"{context.Request.Scheme}://{context.Request.Host}");
                }
            }
        }

        await _next(context);
    }

    /// <summary>
    /// Sets the auth cookie with secure options.
    /// </summary>
    public static void SetAuthCookie(HttpContext context, string token)
    {
        context.Response.Cookies.Append(CookieName, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            // Lax, not Strict: launching an installed PWA or tapping a push notification
            // is an app-initiated navigation, and browsers withhold Strict cookies from
            // those — every PWA launch looked signed-out (prod incident: one user made
            // seven accounts). Lax still keeps the cookie off cross-site POSTs and
            // subresource requests, which is the CSRF protection that matters here.
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromDays(365), // Long-lived for "remember me" behavior
            Path = "/"
        });
    }

    /// <summary>
    /// Clears the auth cookie.
    /// </summary>
    public static void ClearAuthCookie(HttpContext context)
    {
        context.Response.Cookies.Delete(CookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Lax, // keep in lockstep with SetAuthCookie
            Path = "/"
        });
    }
}
