using Yap.Middleware;
using Yap.Models;
using Yap.Services;

namespace Yap.Endpoints;

public static class PushEndpoints
{
    public static void MapPushEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/push");

        group.MapGet("/vapid-public-key", (PushNotificationService pushService, ILogger<Program> logger) =>
        {
            var publicKey = pushService.GetPublicKey();
            logger.LogDebug("VAPID public key requested, configured={IsConfigured}", publicKey != null);
            return publicKey != null
                ? Results.Ok(new { publicKey })
                : Results.NotFound(new { error = "VAPID not configured" });
        });

        group.MapPost("/subscribe", async (HttpContext context, PushSubscriptionStore store, UserService userService, ILogger<Program> logger) =>
        {
            var token = context.Request.Cookies[AuthMiddleware.CookieName];
            var user = !string.IsNullOrEmpty(token) ? userService.AuthenticateByToken(token) : null;
            if (user == null || (context.Request.Headers.TryGetValue("X-Yap-Chat-User", out var expectedUser) && expectedUser != user.Id.ToString()))
            {
                logger.LogDebug("Push subscribe rejected: no valid auth cookie");
                return Results.Unauthorized();
            }

            var body = await context.Request.ReadFromJsonAsync<PushSubscribeRequest>();
            if (body == null || string.IsNullOrEmpty(body.Endpoint))
                return Results.BadRequest(new { error = "Invalid subscription" });

            logger.LogDebug("Push subscribe for {Username}, endpoint={Endpoint}", user.Username, body.Endpoint[..Math.Min(50, body.Endpoint.Length)]);

            await store.SaveSubscriptionAsync(user.Username, new PushSubscriptionInfo
            {
                Endpoint = body.Endpoint,
                P256dh = body.P256dh ?? "",
                Auth = body.Auth ?? ""
            });

            return Results.Ok(new { success = true });
        });

        group.MapPost("/unsubscribe", async (HttpContext context, PushSubscriptionStore store, UserService userService, ILogger<Program> logger) =>
        {
            var token = context.Request.Cookies[AuthMiddleware.CookieName];
            var user = !string.IsNullOrEmpty(token) ? userService.AuthenticateByToken(token) : null;
            if (user == null || (context.Request.Headers.TryGetValue("X-Yap-Chat-User", out var expectedUser) && expectedUser != user.Id.ToString()))
            {
                logger.LogDebug("Push unsubscribe rejected: no valid auth cookie");
                return Results.Unauthorized();
            }

            var body = await context.Request.ReadFromJsonAsync<PushUnsubscribeRequest>();
            if (body == null || string.IsNullOrEmpty(body.Endpoint))
                return Results.BadRequest(new { error = "Invalid request" });

            logger.LogDebug("Push unsubscribe for {Username}, endpoint={Endpoint}", user.Username, body.Endpoint[..Math.Min(50, body.Endpoint.Length)]);

            await store.RemoveSubscriptionAsync(body.Endpoint);
            return Results.Ok(new { success = true });
        });

        // Delivery receipt from the service worker's push handler. Anonymous by design: it fires
        // while the app is closed, where the auth cookie may be absent or expired in SW context.
        // The subscription endpoint URL is itself a high-entropy secret — presenting one proves
        // the caller received a push for it; unknown endpoints get 404.
        group.MapPost("/delivered", async (HttpContext context, PushSubscriptionStore store) =>
        {
            var body = await context.Request.ReadFromJsonAsync<PushDeliveredRequest>();
            if (body == null || string.IsNullOrEmpty(body.Endpoint))
                return Results.BadRequest(new { error = "Invalid request" });

            return store.MarkDelivered(body.Endpoint)
                ? Results.Ok(new { success = true })
                : Results.NotFound();
        });
    }

    private record PushSubscribeRequest(string Username, string Endpoint, string? P256dh, string? Auth);
    private record PushUnsubscribeRequest(string Endpoint);
    private record PushDeliveredRequest(string Endpoint, string? Tag, bool? Shown);
}
