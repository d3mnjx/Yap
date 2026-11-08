using System.Security.Cryptography;
using System.Text.Json;
using WebPush;
using Yap.Configuration;
using Yap.Services.Chat;

namespace Yap.Services.Notifications;

/// <summary>
/// Delegating handler that logs HTTP request/response details for push notifications.
/// </summary>
public class PushLogHandler : DelegatingHandler
{
    private readonly ILogger _logger;

    public PushLogHandler(ILogger logger) : base(new SocketsHttpHandler
    {
        // The push HttpClient is a singleton (lives for the app's lifetime). Recycle pooled
        // connections so a silently-dropped keep-alive to a push endpoint can't hang the next
        // send — stale pooled connections caused 100s timeouts that delayed badge updates.
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        ConnectTimeout = TimeSpan.FromSeconds(10),
        // A subscription's endpoint is the client's word: the push service is public, the server's own network is not (SSRF).
        ConnectCallback = NetworkSecurityHelper.ConnectToPublicAddress
    })
    {
        _logger = logger;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        _logger.LogDebug("Push HTTP {Method} {Url}", request.Method, request.RequestUri);

        var response = await base.SendAsync(request, cancellationToken);

        _logger.LogDebug("Push HTTP {StatusCode} ({StatusInt}) from {Url}",
            response.StatusCode, (int)response.StatusCode, request.RequestUri);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogWarning("Push HTTP error body: {Body}", body);
        }

        return response;
    }
}

/// <summary>
/// Service for sending push notifications to users.
/// Used to notify users of DMs when they're not actively using the app.
/// </summary>
public class PushNotificationService
{
    private readonly VapidDetails? _vapidDetails;
    private readonly WebPushClient _webPushClient;
    private readonly PushSubscriptionStore _subscriptionStore;
    private readonly NotificationAudit _audit;
    private readonly ILogger<PushNotificationService> _logger;
    private readonly bool _isConfigured;
    private readonly PushKeyStatus _keyStatus;
    private readonly string? _keyStatusDetail;
    private readonly ServerConfig _config;

    public PushNotificationService(
        IConfiguration configuration,
        ServerConfig config,
        PushSubscriptionStore subscriptionStore,
        NotificationAudit audit,
        ILogger<PushNotificationService> logger)
    {
        _subscriptionStore = subscriptionStore;
        _audit = audit;
        _logger = logger;
        _config = config;

        var httpClient = new HttpClient(new PushLogHandler(logger))
        {
            // Push sends should be fast (push services respond in ~1s). The 100s default let a single
            // stale connection delay a notification — and the badge it carries — by up to 100 seconds.
            Timeout = TimeSpan.FromSeconds(20)
        };
        _webPushClient = new WebPushClient(httpClient);

        // Load VAPID keys from configuration
        var subject = configuration["Vapid:Subject"];
        var publicKey = configuration["Vapid:PublicKey"];
        var privateKey = configuration["Vapid:PrivateKey"];

        // Check if VAPID is properly configured
        if (!string.IsNullOrEmpty(subject) &&
            !string.IsNullOrEmpty(publicKey) &&
            !string.IsNullOrEmpty(privateKey) &&
            !publicKey.Contains("GENERATE_YOUR_OWN"))
        {
            // Verify the public key is the cryptographic pair of the private key BEFORE enabling push.
            // A mismatched pair signs JWTs the push service rejects as BadJwtToken — silently, on every
            // send. This turns months of invisibly-broken notifications into a loud startup error.
            if (KeypairPairs(publicKey, privateKey, out var detail))
            {
                _vapidDetails = new VapidDetails(subject, publicKey, privateKey);
                _isConfigured = true;
                _keyStatus = PushKeyStatus.Valid;
                _keyStatusDetail = detail;
                _logger.LogInformation("Push notifications configured with VAPID ({Detail}).", detail);
            }
            else
            {
                _isConfigured = false;
                _keyStatus = PushKeyStatus.Invalid;
                _keyStatusDetail = detail;
                _logger.LogError(
                    "PUSH DISABLED — VAPID keypair is invalid: {Detail}. The configured public and private keys " +
                    "are not a pair, so every push would be rejected (BadJwtToken). Regenerate a matched pair " +
                    "(WebPush.VapidHelper.GenerateVapidKeys()) and set both Vapid:PublicKey and Vapid:PrivateKey.",
                    detail);
            }
        }
        else
        {
            _isConfigured = false;
            _keyStatus = PushKeyStatus.NotConfigured;
            _logger.LogWarning("Push notifications not configured - VAPID keys missing or placeholder values");
        }
    }

    /// <summary>
    /// Confirms the configured VAPID public key is the cryptographic pair of the private key by signing
    /// a probe with the private key and verifying it with the public key — exactly the check the push
    /// service performs. Returns false (with a human-readable reason) for any mismatch or malformed key.
    /// </summary>
    private static bool KeypairPairs(string publicKey, string privateKey, out string detail)
    {
        try
        {
            var pub = FromBase64Url(publicKey);   // 0x04 || X(32) || Y(32)
            var d = FromBase64Url(privateKey);    // 32-byte scalar
            if (pub.Length != 65 || pub[0] != 0x04)
            {
                detail = $"public key is not a 65-byte uncompressed P-256 point (got {pub.Length} bytes)";
                return false;
            }
            if (d.Length != 32)
            {
                detail = $"private key is not a 32-byte scalar (got {d.Length} bytes)";
                return false;
            }

            var q = new ECPoint { X = pub[1..33], Y = pub[33..65] };
            // Importing D alongside Q validates Q == D·G on most platforms (throws if not); the
            // sign+verify below is the backstop for any platform that skips that import-time check.
            using var signer = ECDsa.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = d, Q = q });
            using var verifier = ECDsa.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = q });
            var probe = "yap-vapid-startup-selfcheck"u8.ToArray();
            var ok = verifier.VerifyData(probe, signer.SignData(probe, HashAlgorithmName.SHA256), HashAlgorithmName.SHA256);
            detail = ok ? "keypair verified" : "public key is not the cryptographic pair of the private key";
            return ok;
        }
        catch (Exception ex)
        {
            detail = $"keypair check failed ({ex.GetType().Name}: {ex.Message})";
            return false;
        }
    }

    private static byte[] FromBase64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; }
        return Convert.FromBase64String(s);
    }

    /// <summary>
    /// Gets the VAPID public key for client-side subscription.
    /// </summary>
    public string? GetPublicKey() => _vapidDetails?.PublicKey;

    /// <summary>
    /// Whether push notifications are properly configured.
    /// </summary>
    public bool IsConfigured => _isConfigured;

    /// <summary>
    /// Health of the configured VAPID keypair, surfaced on the admin page.
    /// </summary>
    public PushKeyStatus KeyStatus => _keyStatus;

    /// <summary>Human-readable detail for <see cref="KeyStatus"/> (e.g. why the keypair was rejected).</summary>
    public string? KeyStatusDetail => _keyStatusDetail;

    /// <summary>
    /// Number of push subscriptions registered for a user (diagnostic + Settings display).
    /// </summary>
    public int GetSubscriptionCount(string username) =>
        _subscriptionStore.GetSubscriptions(username).Count();

    /// <summary>
    /// Send a push notification to a specific user.
    /// </summary>
    /// <remarks>
    /// Mute is NOT evaluated here. Whether a channel notifies at all is decided upstream by
    /// NotificationSettingsService, which suppresses the badge and the unread count along with the
    /// banner. That leaves this method free to deliver the Settings test push unconditionally,
    /// which is what makes it a usable "is this device alive?" check.
    /// </remarks>
    public async Task<PushSendResult> SendToUserAsync(string username, PushPayload payload)
    {
        if (!_isConfigured || _vapidDetails == null)
        {
            _audit.RecordPushResult(username, 0, 0, 0, muted: false, note: "push not configured");
            _logger.LogDebug("Push not configured, skipping notification to {Username}", username);
            return new PushSendResult(0, 0, 0);
        }

        var subscriptions = _subscriptionStore.GetSubscriptions(username).ToList();
        if (subscriptions.Count == 0)
        {
            _audit.RecordPushResult(username, 0, 0, 0, muted: false, note: "no subscriptions");
            _logger.LogDebug("No push subscriptions for user {Username}", username);
            return new PushSendResult(0, 0, 0);
        }

        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        int sent = 0, failed = 0;
        var notes = new List<string>();
        foreach (var sub in subscriptions)
        {
            try
            {
                var pushSubscription = new PushSubscription(sub.Endpoint, sub.P256dh, sub.Auth);
                await _webPushClient.SendNotificationAsync(pushSubscription, json, _vapidDetails);
                _logger.LogDebug("Push sent to {Username} at {Endpoint}", username, sub.Endpoint[..Math.Min(50, sub.Endpoint.Length)]);
                sent++;
            }
            catch (WebPushException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Gone ||
                                               ex.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                // Subscription expired or invalid - remove it
                _logger.LogInformation("Removing expired push subscription for {Username}", username);
                await _subscriptionStore.RemoveSubscriptionAsync(sub.Endpoint);
                notes.Add("removed expired subscription");
                failed++;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send push to {Username}", username);
                notes.Add($"send failed: {ex.GetType().Name}");
                failed++;
            }
        }

        _audit.RecordPushResult(username, sent, failed, subscriptions.Count, muted: false,
            notes.Count > 0 ? string.Join("; ", notes) : null);
        _logger.LogDebug("Push to {Username}: sent={Sent} failed={Failed} total={Total}", username, sent, failed, subscriptions.Count);
        return new PushSendResult(sent, failed, subscriptions.Count);
    }

    /// <summary>
    /// Send a DM notification to a user.
    /// </summary>
    public Task<PushSendResult> SendDmNotificationAsync(string toUsername, string fromUsername, string messagePreview, int unreadCount, string? fromDisplayName = null)
    {
        _logger.LogDebug("SendDmNotification: to={To} from={From} unreadCount={UnreadCount} preview={Preview}",
            toUsername, fromUsername, unreadCount, messagePreview.Length > 30 ? messagePreview[..27] + "..." : messagePreview);

        var payload = new PushPayload
        {
            Title = $"DM from {fromDisplayName ?? fromUsername}",   // NT-27
            Body = messagePreview.Length > 100 ? messagePreview[..97] + "..." : messagePreview,
            Icon = "/icon-192.png",
            Badge = "/icon-192.png",
            Tag = $"dm-{fromUsername}",
            Url = $"/dm/{Uri.EscapeDataString(fromUsername)}",
            UnreadCount = unreadCount
        };

        return SendToUserAsync(toUsername, payload);
    }

    /// <summary>
    /// Send a room notification to a user who has that room unmuted.
    /// </summary>
    public Task<PushSendResult> SendRoomNotificationAsync(string toUsername, string roomName, Guid roomId,
        string fromUsername, string messagePreview, int unreadCount, string? fromDisplayName = null)
    {
        _logger.LogDebug("SendRoomNotification: to={To} room={Room} from={From} unreadCount={UnreadCount}",
            toUsername, roomName, fromUsername, unreadCount);

        // The sender goes in the body, not the title: the title has to say which room this is, or a
        // phone showing three stacked banners tells you nothing about where to look.
        var body = $"{fromDisplayName ?? fromUsername}: {messagePreview}";   // NT-27

        var payload = new PushPayload
        {
            Title = $"#{roomName}",
            Body = body.Length > 100 ? body[..97] + "..." : body,
            Icon = "/icon-192.png",
            Badge = "/icon-192.png",
            Tag = $"room-{roomId}",
            Url = $"/room/{roomId}",
            UnreadCount = unreadCount
        };

        return SendToUserAsync(toUsername, payload);
    }

    /// <summary>
    /// Sends a test notification to all of a user's devices. Used from Settings as an
    /// "is this subscription alive?" check — the device that buzzes is alive. Ignores every mute
    /// setting on purpose: a delivery test that a mute could silence would prove nothing.
    /// </summary>
    public Task<PushSendResult> SendTestAsync(string username)
    {
        var payload = new PushPayload
        {
            Title = $"{_config.ProjectName} test notification",   // the name under the installed app's icon
            Body = "If you can see this, notifications work on this device.",
            Icon = "/icon-192.png",
            Badge = "/icon-192.png",
            Tag = "yap-test",
            Url = "/",
            UnreadCount = 0
        };

        return SendToUserAsync(username, payload);
    }
}

/// <summary>
/// Health of the configured VAPID keypair.
/// </summary>
public enum PushKeyStatus
{
    /// <summary>No VAPID keys configured (or placeholder values).</summary>
    NotConfigured,
    /// <summary>Public key is the verified cryptographic pair of the private key.</summary>
    Valid,
    /// <summary>Keys are present but malformed or not a matching pair — push is disabled.</summary>
    Invalid
}

/// <summary>
/// Result of a push send attempt across all of a user's devices.
/// </summary>
public record PushSendResult(int Sent, int Failed, int Total);

/// <summary>
/// Push notification payload sent to the service worker.
/// </summary>
public record PushPayload
{
    public string Title { get; init; } = "";
    public string Body { get; init; } = "";
    public string Icon { get; init; } = "/icon-192.png";
    public string Badge { get; init; } = "/icon-192.png";
    public string Tag { get; init; } = "chat";
    public string Url { get; init; } = "/";
    public int UnreadCount { get; init; }
}
