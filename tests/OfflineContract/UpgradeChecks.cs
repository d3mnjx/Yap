using System.Net;
using Yap.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

static class UpgradeChecks
{
    public static async Task CheckForwarding(IServiceProvider services, bool restricted)
    {
        var options = services.GetRequiredService<IOptions<ForwardedHeadersOptions>>();
        var middleware = new ForwardedHeadersMiddleware(_ => Task.CompletedTask,
            services.GetRequiredService<ILoggerFactory>(), options);
        foreach (var address in new[] { "127.0.0.1", "192.0.2.25", "192.0.2.130", "203.0.113.10" })
        {
            var trusted = !restricted || address != "203.0.113.10";
            var context = new DefaultHttpContext();
            context.Request.Scheme = "http";
            context.Request.Host = new HostString("internal-container:8080");
            context.Connection.RemoteIpAddress = IPAddress.Parse(address);
            context.Request.Headers["X-Forwarded-Proto"] = "https";
            context.Request.Headers["X-Forwarded-For"] = "198.51.100.10";
            context.Request.Headers["X-Forwarded-Host"] = "chat.example.test:8443";
            await middleware.Invoke(context);
            if (context.Request.Scheme != (trusted ? "https" : "http"))
                throw new Exception("Forwarded scheme must depend on immediate proxy trust");
            var expectedOrigin = trusted ? "https://chat.example.test:8443" : "http://internal-container:8080";
            if ($"{context.Request.Scheme}://{context.Request.Host}" != expectedOrigin)
                throw new Exception("Forwarded host and public port must follow the same proxy policy");
            var links = services.GetRequiredService<AccessLinkService>();
            links.ObserveOrigin(context);
            if (!links.BuildUrl("fixture").StartsWith(expectedOrigin + "/"))
                throw new Exception("Login links must use the validated scheme, not an untrusted raw header");
            if (context.Connection.RemoteIpAddress!.ToString() != (trusted ? "198.51.100.10" : "203.0.113.10"))
                throw new Exception("Untrusted forwarded client address must be ignored");
        }
        Console.WriteLine(restricted
            ? "PASS optional proxy allowlist accepts configured addresses/networks and loopback, ignores other senders"
            : "PASS default forwarding restores public scheme/host/port and client IP from any proxy address");
    }

    public static async Task Run(IServiceProvider services, HttpClient client)
    {
        await CheckForwarding(services, restricted: false);
        using var response = await client.GetAsync("/api/chat/session");
        var cookie = response.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("yap_auth="));
        if (!cookie.Contains("max-age=31536000") || !cookie.Contains("secure") || !cookie.Contains("httponly") || !cookie.Contains("samesite=lax")
            || response.Headers.CacheControl?.NoStore != true)
            throw new Exception("Online session must renew legacy secure cookie without caching response");
        Console.WriteLine("PASS online session renews legacy cookie lifetime with secure flags and no-store");
    }
}
