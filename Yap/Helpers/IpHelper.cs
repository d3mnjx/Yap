using System.Net;
using Yap.Services.Accounts;

namespace Yap.Helpers;

/// <summary>
/// The client's address as the server believes it. A forwarded header counts only when the connection comes from
/// a proxy in ChatSettings:TrustedProxies: the forwarded-headers middleware (Program.cs, <see cref="TrustedProxies"/>)
/// then rewrites RemoteIpAddress and removes the entries it consumed. An X-Forwarded-For that is still on the
/// request was sent by a peer the server does not trust, and the address is unknown then. Smart login, the memory
/// of known addresses and the IPv4 beacon all prefer "unknown" to a value the caller chose: with the header taken
/// at face value, a username and a guessed address were enough to sign in as someone else (AU-09).
///
/// Cloudflare is the one proxy that needs no listing. When the hop after the trusted proxies is a Cloudflare
/// address (<see cref="CloudflareIps"/>), the visitor is CF-Connecting-IP: Cloudflare sets that header itself and
/// overwrites any value the visitor sent. A proxy between Cloudflare and this server (Caddy, nginx) passes the
/// header through unchanged, so it needs no Cloudflare configuration of its own. From any other peer the header
/// is ignored, because anyone can send it.
/// </summary>
public static class IpHelper
{
    public static string? GetClientIp(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } ip) return null;
        if (ViaCloudflare(context) is { } visitor) return Format(visitor);
        // ForwardedFor, not UntrustedForwardedFor: that one tests for Cloudflare first, and the line above did it.
        if (ForwardedFor(context) is not null) return null;
        return Format(ip);
    }

    /// <summary>The X-Forwarded-For still on the request, or null. A value means no trusted proxy consumed it, and
    /// the request did not come through Cloudflare either (Cloudflare sets X-Forwarded-For too, and it is trusted
    /// by its address). CF-Connecting-IP from anyone else, and X-Real-IP, are never read.</summary>
    public static string? UntrustedForwardedFor(HttpContext context) =>
        ViaCloudflare(context) is not null ? null : ForwardedFor(context);

    private static string? ForwardedFor(HttpContext context)
    {
        var value = context.Request.Headers["X-Forwarded-For"].ToString();
        return value.Length == 0 ? null : value;
    }

    /// <summary>The visitor behind Cloudflare, or null when the last hop was not a Cloudflare address.</summary>
    private static IPAddress? ViaCloudflare(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } peer) return null;
        // Tests build a bare HttpContext without services: then there is no Cloudflare and nothing changes.
        if (context.RequestServices?.GetService(typeof(CloudflareIps)) is not CloudflareIps cloudflare || !cloudflare.Contains(peer)) return null;
        return IPAddress.TryParse(context.Request.Headers["CF-Connecting-IP"].ToString().Trim(), out var visitor) ? Unmapped(visitor) : null;
    }

    private static string Format(IPAddress ip)
    {
        ip = Unmapped(ip);
        return IPAddress.IsLoopback(ip) ? "127.0.0.1" : ip.ToString();   // ::1 and 127.0.0.1 are one machine and one string
    }

    /// <summary>An IPv4 address that Kestrel reports in its IPv6-mapped form (::ffff:1.2.3.4), as plain IPv4.</summary>
    public static IPAddress Unmapped(IPAddress address) => address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
}
