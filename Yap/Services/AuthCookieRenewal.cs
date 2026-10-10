using System.Globalization;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Yap.Middleware;

namespace Yap.Services;

// A protected, token-bound timestamp travels with the browser's cookie jar. It survives
// reconnects/restarts and is shared by tabs, unlike an HTTP connection ID or hub session.
public sealed class AuthCookieRenewal(IDataProtectionProvider protection, TimeProvider clock)
{
    public const string CookieName = "yap_auth_renewed";
    private readonly IDataProtector protector = protection.CreateProtector("Yap.AuthCookieRenewal.v1");

    public void Refresh(HttpContext http, string token)
    {
        var now = clock.GetUtcNow();
        var fingerprint = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)));
        if (http.Request.Cookies.TryGetValue(CookieName, out var marker))
            try
            {
                var parts = protector.Unprotect(marker).Split(':');
                if (parts.Length == 2 && parts[1] == fingerprint
                    && long.TryParse(parts[0], CultureInfo.InvariantCulture, out var seconds))
                {
                    var age = now - DateTimeOffset.FromUnixTimeSeconds(seconds);
                    if (age >= TimeSpan.Zero && age < TimeSpan.FromHours(1)) return;
                }
            }
            catch (Exception error) when (error is CryptographicException or ArgumentException) { }
        AuthMiddleware.SetAuthCookie(http, token, now);
        http.Response.Cookies.Append(CookieName,
            protector.Protect(now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture) + ":" + fingerprint),
            new CookieOptions
            {
                HttpOnly = true,
                Secure = true,
                SameSite = SameSiteMode.Lax,
                Path = "/",
                MaxAge = TimeSpan.FromDays(365),
                Expires = now.AddDays(365)
            });
    }
}
