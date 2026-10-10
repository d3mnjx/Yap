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
                // Settings saves these together. Load all account preferences so a fresh
                // Blazor circuit cannot clear the locale while changing the date or clock.
                userState.TimeZone = user.TimeZone;
                userState.Locale = user.Locale;
                userState.DateFormat = user.DateFormat;
                userState.Status = UserStatus.Online;

                // Sliding renewal belongs only to OfflineEndpoints.Session (bootstrap/session),
                // throttled by AuthCookieRenewal. Shell HTML must never carry Set-Cookie.
                // Retained Blazor pages still record their own network and login origin here.
                if (HttpMethods.IsGet(context.Request.Method)
                    && !context.Request.Path.StartsWithSegments("/auth")
                    && !Yap.Offline.ChatRoutes.IsShell(context)
                    && context.Request.Headers.Accept.ToString().Contains("text/html"))
                {
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
    public static void SetAuthCookie(HttpContext context, string token, DateTimeOffset? issuedAt = null)
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
            Expires = (issuedAt ?? DateTimeOffset.UtcNow).AddDays(365),
            MaxAge = TimeSpan.FromDays(365), // Long-lived for "remember me" behavior
            Path = "/"
        });
    }

    /// <summary>
    /// Clears the auth cookie.
    /// </summary>
    public static void ClearAuthCookie(HttpContext context)
    {
        context.Response.Cookies.Delete(AuthCookieRenewal.CookieName, new CookieOptions { Path = "/", Secure = true, HttpOnly = true, SameSite = SameSiteMode.Lax });
        context.Response.Cookies.Delete(CookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Lax, // keep in lockstep with SetAuthCookie
            Path = "/"
        });
    }
}
