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
public sealed class OfflineHub(UserService users, OfflineSnapshotService snapshots, OfflineChangeSignal changes, OfflineLiveService live, ChatConfigService branding, OfflineSync sync) : Hub
{
    private User CurrentUser() => users.AuthenticateByToken(Context.GetHttpContext()?.Request.Cookies[AuthMiddleware.CookieName] ?? "")
        ?? throw new HubException("AUTH_REQUIRED");
    public Task Join(string ticket, UserStatus chosen, bool visible, bool mobile, double idleSeconds)
        => live.Join(Context.ConnectionId, CurrentUser(), ticket, chosen, visible, mobile, idleSeconds, Context.GetHttpContext()?.Items["ClientIp"] as string);
    public Task Report(bool visible, double idleSeconds, Guid? channelId)
        => live.Report(Context.ConnectionId, CurrentUser(), visible, idleSeconds, channelId);
    public Task SetStatus(UserStatus status) => live.SetStatus(Context.ConnectionId, CurrentUser(), status);
    public Task Typing(Guid channelId, bool active) => live.Typing(Context.ConnectionId, CurrentUser(), channelId, active);
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await live.Leave(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async IAsyncEnumerable<object> WatchLive([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? previous = null, previousTyping = null, typingText = null, header = null;
        int count = -1;
        while (!cancellationToken.IsCancellationRequested)
        {
            var user = CurrentUser();
            var view = live.View(Context.ConnectionId, user);
            var signature = JsonSerializer.Serialize(view);
            if (signature != previous || view.Typing.Length > 0)
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
            await Task.Delay(500, cancellationToken);
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
        await foreach (var value in WatchLive(cancellationToken))
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
        ReaderSnapshot? previous = null;
        while (!cancellationToken.IsCancellationRequested)
        {
            var next = changes.Next;
            var current = snapshots.Snapshot(CurrentUser());
            var update = sync.Changes(current, previous, known, knownState);
            // Even an unchanged subscription has an explicit baseline, so the first real
            // arrival is never mistaken for quiet reconnect catch-up by the browser.
            if (update != null || previous == null)
                yield return update ?? new ChatUpdate(2, current.User.Id, current.ServerEpoch, current.Sequence, null, [], [], []);
            previous = current;
            try
            {
                await next.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            catch (TimeoutException) { }
            // A short coalescing interval bounds bursts without adding a tenth of a second
            // to every arrival on an otherwise idle connection.
            await Task.Delay(15, cancellationToken);
        }
    }

    public async IAsyncEnumerable<ReaderSnapshot> Watch([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var token = Context.GetHttpContext()?.Request.Cookies[AuthMiddleware.CookieName] ?? "";
        string? revision = null;
        while (!cancellationToken.IsCancellationRequested)
        {
            // Capture wake-up before reading so a mutation during the snapshot cannot be missed.
            var next = changes.Next;
            var user = users.AuthenticateByToken(token);
            if (user == null)
                throw new HubException("AUTH_REQUIRED");
            var snapshot = snapshots.Snapshot(user);
            if (snapshot.Revision != revision)
            {
                revision = snapshot.Revision;
                yield return snapshot;
            }
            try
            {
                await next.WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
            }
            catch (TimeoutException) { }
            // Coalesce bursts of legacy/bot events without delaying reconnection's initial snapshot.
            await Task.Delay(100, cancellationToken);
        }
    }
}
