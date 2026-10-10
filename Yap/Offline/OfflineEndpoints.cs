using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using System.Reflection;
using Yap.Middleware;
using Yap.Helpers;
using Yap.Services;

namespace Yap.Offline;

/// <summary>
/// Maps the browser chat shell and authenticated HTTP API, applying account-bound write protection
/// before delegating to shared services.
/// </summary>
public static class OfflineEndpoints
{
    public static void MapOfflineChat(this WebApplication app)
    {
        MapApi(app.MapGroup("/api/chat"));
        app.MapHub<OfflineHub>("/hubs/chat");
        foreach (var path in new[] { "/chat", "/lobby", "/room/{id:guid}", "/dm/{username}" })
            app.MapGet(path, (IWebHostEnvironment env) => Results.File(Path.Combine(env.WebRootPath, "chat-client", "index.html"), "text/html"));
        app.MapGet("/chat-client/component-styles.css", ComponentStyles);
    }

    private static void MapApi(RouteGroupBuilder api)
    {
        api.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            var users = context.HttpContext.RequestServices.GetRequiredService<UserService>();
            var token = context.HttpContext.Request.Cookies[AuthMiddleware.CookieName] ?? "";
            var authenticated = users.AuthenticateByToken(token);
            if (authenticated == null)
                return Results.Unauthorized();
            if (context.HttpContext.Request.Headers.TryGetValue("X-Yap-Chat-User", out var expectedUser)
                && expectedUser != authenticated.Id.ToString())
                return Results.Json(new
                {
                    code = "account_changed",
                    error = "Account changed."
                }, statusCode: 409);
            // Bind antiforgery request tokens to the cookie's actual account. If another tab
            // switches accounts between /session and POST, the old account's token must fail.
            context.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim(ClaimTypes.NameIdentifier, authenticated.Id.ToString()),
                new Claim(ClaimTypes.Name, authenticated.Username)
            }, "YapCookie"));
            if (HttpMethods.IsPost(context.HttpContext.Request.Method))
            {
                var http = context.HttpContext;
                // Proxy scheme/host rewriting must not reject legitimate writes.
                // Account-bound antiforgery remains required even without browser metadata.
                if (http.Request.Headers["Sec-Fetch-Site"] == "cross-site")
                    return Results.Json(new
                    {
                        code = "cross_site",
                        error = "Cross-site request rejected."
                    }, statusCode: 403);
                try
                {
                    await http.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(http);
                }
                catch (AntiforgeryValidationException)
                {
                    return Results.Json(new
                    {
                        code = "csrf",
                        error = "Refresh your connection before sending."
                    }, statusCode: 403);
                }
            }
            try
            {
                return await next(context);
            }
            catch (ChatSendException ex) { return Results.Json(new { code = ex.Code, error = ex.Message }, statusCode: ex.Status); }
            catch (Exception ex) when (HttpMethods.IsPost(context.HttpContext.Request.Method))
            {
                context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ChatWrites").LogError(ex, "Chat operation failed");
                return Results.Json(new
                {
                    code = "temporarily_unavailable",
                    error = "Server could not save the message. It is safe to retry."
                }, statusCode: 503);
            }
        });
        OfflineContent.Map(api);
        api.MapPost("/pwa/installed", async (HttpContext http, UserService users) => { await users.MarkPwaInstalledAsync(users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!.Id); return Results.Ok(new { }); });
        api.MapGet("/session", (HttpContext http) => Results.Ok(Session(http)));
        api.MapGet("/bootstrap", (HttpContext http, string? path, Guid? channelId, string? epoch, string? revision, Guid? knownUser, UserService users, OfflineSnapshotService snapshots, OfflineSync sync) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var session = Session(http);
            return Modern(http) ? Results.Ok(new
            {
                session,
                update = sync.Bootstrap(user, path, channelId, epoch, revision, knownUser)
            })
                : Results.Ok(snapshots.Snapshot(user));
        });
        api.MapGet("/windows/{id:guid}", (Guid id, HttpContext http, UserService users, OfflineSync sync) =>
            Results.Ok(sync.Conversation(users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!, id, full: true)));
        api.MapPost("/conversations/{id:guid}/messages", async (Guid id, SendTextRequest request, HttpContext http,
            UserService users, ChatService chat, OfflineSnapshotService snapshots, OfflineSync sync) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var hasMedia = request.UploadIds?.Length > 0 || request.GifEntryId != null;
            var receipt = await chat.SendTextAsync(user, id, request.OperationId, request.Content, request.ReplyToMessageId,
                mediaIdentity: hasMedia ? System.Text.Json.JsonSerializer.Serialize(new
                {
                    request.UploadIds,
                    request.GifEntryId
                }) : null,
                resolveMedia: hasMedia ? () => OfflineContent.ResolveMedia(http, user, request.UploadIds, request.GifEntryId) : null);
            if (Modern(http))
                return Results.Ok(new
                {
                    receipt.OperationId,
                    receipt.MessageId,
                    update = sync.Conversation(user, id, receipt.MessageId)
                });
            return Results.Ok(new
            {
                receipt.OperationId,
                receipt.MessageId,
                receipt.ChannelId,
                receipt.AcceptedAt,
                snapshot = snapshots.Snapshot(user)
            });
        });
        api.MapPost("/conversations/{id:guid}/messages/{messageId:guid}/actions", async (Guid id, Guid messageId,
            MutationRequest request, HttpContext http, UserService users, ChatService chat, OfflineSnapshotService snapshots, OfflineSync sync) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var receipt = await chat.MutateMessageAsync(user, id, messageId, request.OperationId, request.Kind, request.Content, request.Emoji, request.Active);
            if (Modern(http))
                return Results.Ok(new
                {
                    receipt.OperationId,
                    receipt.MessageId,
                    update = sync.Conversation(user, id, receipt.MessageId)
                });
            return Results.Ok(new
            {
                receipt.OperationId,
                snapshot = snapshots.Snapshot(user)
            });
        });
        api.MapPost("/conversations/{id:guid}/read", async (Guid id, ReadRequest request, HttpContext http,
            UserService users, ChatService chat, OfflineSnapshotService snapshots, OfflineSync sync) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            await chat.MarkObservedReadAsync(user.Id, id, request.Through);
            if (Modern(http))
                return Results.Ok(new
                {
                    through = request.Through,
                    update = sync.Conversation(user, id)
                });
            return Results.Ok(new
            {
                through = request.Through,
                snapshot = snapshots.Snapshot(user)
            });
        });
        // Already-queued text/actions can share one request, without delaying the first
        // operation to assemble a batch. Each operation retains its own durable receipt.
        api.MapPost("/operations", async (QueuedOperation[] operations, HttpContext http, UserService users, ChatService chat, OfflineSync sync) =>
        {
            if (operations.Length is < 1 or > 16)
                return Results.BadRequest();
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var results = new List<OperationResult>();
            foreach (var operation in operations)
            {
                try
                {
                    var receipt = operation.Kind == null
                        ? await chat.SendTextAsync(user, operation.ChannelId, operation.OperationId, operation.Content, operation.ReplyToMessageId)
                        : await chat.MutateMessageAsync(user, operation.ChannelId, operation.MessageId ?? Guid.Empty,
                            operation.OperationId, operation.Kind, operation.Content, operation.Emoji, operation.Active);
                    results.Add(new(receipt.OperationId, sync.Conversation(user, operation.ChannelId, receipt.MessageId)));
                }
                catch (ChatSendException error)
                {
                    results.Add(new(operation.OperationId, null, error.Status, error.Code, error.Message));
                }
            }
            return Results.Ok(new
            {
                results
            });
        });
        api.MapPost("/reads", async (ReadCheckpoint[] checkpoints, HttpContext http, UserService users, ChatService chat, OfflineSync sync) =>
        {
            if (checkpoints.Length > 100)
                return Results.BadRequest();
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var updates = new List<ChatUpdate>();
            foreach (var checkpoint in checkpoints.DistinctBy(c => c.ChannelId))
            {
                if (chat.GetChannel(checkpoint.ChannelId)?.CanAccess(user.Id) == true)
                    await chat.MarkObservedReadAsync(user.Id, checkpoint.ChannelId, checkpoint.Through);
                updates.Add(sync.Conversation(user, checkpoint.ChannelId));
            }
            return Results.Ok(new
            {
                updates
            });
        });
        api.MapPost("/dm/{username}", async (string username, HttpContext http, UserService users,
            ChatService chat, OfflineSnapshotService snapshots, OfflineSync sync) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var channel = await chat.OpenDirectMessageAsync(user, username);
            if (Modern(http))
                return Results.Ok(new
                {
                    channelId = channel.Id,
                    update = sync.Conversation(user, channel.Id, full: true)
                });
            return Results.Ok(new
            {
                channelId = channel.Id,
                snapshot = snapshots.Snapshot(user)
            });
        });
        api.MapGet("/sync", (HttpContext http, UserService users, OfflineSnapshotService snapshots) =>
                Results.Ok(snapshots.Snapshot(users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!)));
        api.MapGet("/conversations/{id:guid}/history", (Guid id, DateTime? before, int? limit, HttpContext http, UserService users, ChatService chat, OfflineSnapshotService snapshots) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var channel = chat.GetChannel(id);
            if (channel == null || !channel.CanAccess(user.Id))
                return Results.NotFound();
            var page = chat.GetMessagesPaginated(id, Math.Clamp(limit ?? 50, 1, 500), before, users.IsAdmin(user.Id), user.Id);
            return Results.Ok(new
            {
                messages = page.Messages.Select(m => snapshots.Message(m, user.Id)),
                page.HasMore
            });
        });
        api.MapGet("/conversations/{id:guid}/messages/{messageId:guid}", (Guid id, Guid messageId, HttpContext http, UserService users, ChatService chat, OfflineSnapshotService snapshots) =>
        {
            var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
            var message = chat.GetMessageById(id, messageId);
            return message == null || !chat.CanReadMessage(user, message) ? Results.NotFound() : Results.Ok(snapshots.Message(message, user.Id));
        });
        api.MapGet("/conversations/{id:guid}", (Guid id, HttpContext http, UserService users, OfflineSnapshotService snapshots) =>
        {
            var conversation = snapshots.Conversation(users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!, id);
            return conversation == null ? Results.NotFound() : Results.Ok(conversation);
        });
    }

    // Protocol 1 is retained while an already-open v32 document activates the new worker.
    private static bool Modern(HttpContext http) => http.Request.Headers["X-Yap-Chat-Protocol"] == "2";
    private static object Session(HttpContext http)
    {
        var services = http.RequestServices;
        var users = services.GetRequiredService<UserService>();
        var user = users.AuthenticateByToken(http.Request.Cookies[AuthMiddleware.CookieName]!)!;
        AuthMiddleware.SetAuthCookie(http, user.Token);
        users.RecordKnownIp(user.Id, IpHelper.GetClientIp(http));
        users.RecordLoginOrigin(user.Id, $"{http.Request.Scheme}://{http.Request.Host}");
        return new
        {
            userId = user.Id,
            liveTicket = services.GetRequiredService<OfflineLiveService>().Ticket(user),
            hasWayBack = users.HasPassword(user.Username) || services.GetRequiredService<AccessLinkService>().HasActiveLink(user.Id),
            csrfToken = services.GetRequiredService<IAntiforgery>().GetAndStoreTokens(http).RequestToken
        };
    }

    /// <summary>A bounded batch member; media uploads retain their separate resumable path.</summary>
    public record QueuedOperation(Guid OperationId, Guid ChannelId, string? Content, string? Kind = null,
        Guid? MessageId = null, Guid? ReplyToMessageId = null, string? Emoji = null, bool Active = false);
    /// <summary>Independent acceptance or rejection of one batch member.</summary>
    public record OperationResult(Guid OperationId, ChatUpdate? Update, int? Status = null, string? Code = null, string? Error = null);

    /// <summary>
    /// The highest arrival checkpoint observed by the client, leaving newer unseen arrivals unread.
    /// </summary>
    public record ReadRequest(long Through);
    /// <summary>An observed checkpoint in a batched background read acknowledgement.</summary>
    public record ReadCheckpoint(Guid ChannelId, long Through);
    /// <summary>
    /// A new message's stable retry identity, text, reply target and optional uploaded or selected
    /// media references.
    /// </summary>
    public record SendTextRequest(Guid OperationId, string? Content, Guid? ReplyToMessageId = null, string[]? UploadIds = null, Guid? GifEntryId = null);
    /// <summary>
    /// A message action and stable retry identity; reaction actions carry desired membership rather
    /// than a replayable toggle.
    /// </summary>
    public record MutationRequest(Guid OperationId, string Kind, string? Content, string? Emoji, bool Active);

    private static IResult ComponentStyles()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var css = assembly.GetManifestResourceNames().Where(n => n.EndsWith(".razor.css", StringComparison.Ordinal))
            .Order().Select(n =>
            {
                using var reader = new StreamReader(assembly.GetManifestResourceStream(n)!);
                var css = reader.ReadToEnd().Replace("::deep", "");
                // These components share a class name but have different scoped opacity/color rules.
                // Preserve that boundary when consuming their CSS without Blazor scope attributes.
                if (n.EndsWith("EmojiPicker.razor.css"))
                    css = css.Replace(".category-btn", ".emoji-picker .category-btn");
                if (n.EndsWith("GifPicker.razor.css"))
                    css = css.Replace(".category-btn", ".gif-picker .category-btn");
                return css;
            });
        return Results.Text(string.Join("\n", css), "text/css");
    }
}
