using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.SignalR;
using Yap.Middleware;
using Yap.Services;
using Yap.Models;
using System.Text.Json;

namespace Yap.Offline;

/// <summary>
/// Connects authenticated browsers to incremental authority streams and transient presence/typing
/// operations over SignalR.
/// </summary>
public sealed class OfflineHub(UserService users, OfflineSnapshotService snapshots, OfflineLiveService live, ChatConfigService branding, OfflineFanout fanout) : Hub
{
    private User CurrentUser() => users.AuthenticateByToken(Context.GetHttpContext()?.Request.Cookies[AuthMiddleware.CookieName] ?? "")
        ?? throw new HubException("AUTH_REQUIRED");
    public Task Join(string ticket, UserStatus chosen, bool visible, bool mobile, double idleSeconds)
        => live.Join(Context.ConnectionId, CurrentUser(), ticket, chosen, visible, mobile, idleSeconds, Context.GetHttpContext()?.Items["ClientIp"] as string);
    public Task Report(bool visible, double idleSeconds, Guid? channelId)
        => Permit("report") ? live.Report(Context.ConnectionId, CurrentUser(), visible, idleSeconds, channelId) : Task.CompletedTask;
    public Task SetStatus(UserStatus status) => !Permit("status") ? Task.CompletedTask : live.SetStatus(Context.ConnectionId, CurrentUser(), status);
    public Task Typing(Guid channelId, bool active) => !Permit("typing") ? Task.CompletedTask : live.Typing(Context.ConnectionId, CurrentUser(), channelId, active);
    // A small burst allows normal navigation/status changes; a sustained caller is limited
    // to four changes/second. State lives with the connection, not a transient Hub instance.
    private bool Permit(string operation)
    {
        lock (Context.Items)
        {
            var key = "rate:" + operation;
            var now = System.Diagnostics.Stopwatch.GetTimestamp();
            var previous = Context.Items.TryGetValue(key, out var value) ? ((long At, double Tokens))value! : (now, 12d);
            var tokens = Math.Min(12, previous.Item2 + (now - previous.Item1) * 4d / System.Diagnostics.Stopwatch.Frequency);
            Context.Items[key] = (now, tokens >= 1 ? tokens - 1 : tokens);
            return tokens >= 1;
        }
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await live.Leave(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    private async IAsyncEnumerable<object> ActivityViews([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? previous = null, previousTyping = null, typingText = null, header = null;
        int count = -1;
        var lastTyping = DateTime.MinValue;
        var user = CurrentUser();
        await foreach (var view in live.Watch(Context.ConnectionId, user, cancellationToken))
        {
            CurrentUser();
            var signature = JsonSerializer.Serialize(view);
            if (signature != previous || (view.Typing.Length > 0 && DateTime.UtcNow - lastTyping >= TimeSpan.FromSeconds(1)))
            {
                var typingSignature = view.ChannelId + ":" + string.Join(",", view.Typing);
                if (typingSignature != previousTyping)
                {
                    previousTyping = typingSignature;
                    typingText = view.Typing.Length == 0 ? "" : snapshots.IsDirectMessage(view.ChannelId)
                        ? string.Join(", ", view.Typing) + " is typing..." : branding.GetRandomTypingIndicator(view.Typing.ToList(), user.Username);
                }
                if (count != view.OnlineCount)
                {
                    count = view.OnlineCount;
                    header = branding.GetRandomOnlineUsersHeader(count);
                }
                previous = signature;
                lastTyping = DateTime.UtcNow;
                yield return new
                {
                    view.Status,
                    view.ChosenStatus,
                    view.OnlineCount,
                    view.Users,
                    view.ChannelId,
                    typingText,
                    header
                };
            }
        }
    }

    // Registration and initial viewing state share the stream request. Neither needs a
    // separate client round trip before messages can start flowing.
    public async IAsyncEnumerable<object> WatchActivity(string ticket, UserStatus chosen, bool visible,
        bool mobile, double idleSeconds, Guid? channelId, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await Join(ticket, chosen, visible, mobile, idleSeconds);
        await Report(visible, idleSeconds, channelId);
        var previous = new Dictionary<string, string>();
        var people = new Dictionary<string, string>();
        await foreach (var value in ActivityViews(cancellationToken))
        {
            var element = JsonSerializer.SerializeToElement(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            var changed = new Dictionary<string, object>();
            foreach (var property in element.EnumerateObject())
            {
                var raw = property.Value.GetRawText();
                if (property.Name == "users")
                {
                    var current = property.Value.EnumerateArray().ToDictionary(p => p.GetProperty("username").GetString()!);
                    var updates = current.Where(p => people.GetValueOrDefault(p.Key) != p.Value.GetRawText()).Select(p => p.Value).ToArray();
                    var removed = people.Keys.Except(current.Keys).ToArray();
                    if (updates.Length > 0 || previous.Count == 0)
                        changed["users"] = updates;
                    if (removed.Length > 0)
                        changed["removedUsers"] = removed;
                    people = current.ToDictionary(p => p.Key, p => p.Value.GetRawText());
                }
                else if (previous.GetValueOrDefault(property.Name) != raw
                    || (property.Name == "typingText" && property.Value.GetString()?.Length > 0))
                    changed[property.Name] = property.Value;
                previous[property.Name] = raw;
            }
            if (changed.Count > 0)
                yield return changed;
        }
    }

    public async IAsyncEnumerable<ChatUpdate> WatchChanges(Dictionary<Guid, string> known, string? knownState,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        lock (Context.Items)
        {
            if (Context.Items.ContainsKey("changes-stream"))
                throw new HubException("Change stream already active");
            Context.Items["changes-stream"] = true;
        }
        try
        {
            using var subscription = fanout.Subscribe(CurrentUser(), known);
            while (!cancellationToken.IsCancellationRequested)
            {
                var read = subscription.Read(cancellationToken);
                // Revalidate idle sessions too; a revoked cookie must not leave a private stream alive.
                while (await Task.WhenAny(read, Task.Delay(10000, cancellationToken)) != read)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    CurrentUser();
                }
                CurrentUser();
                foreach (var update in await read)
                    yield return update;
            }
        }
        finally { lock (Context.Items) Context.Items.Remove("changes-stream"); }
    }
}
