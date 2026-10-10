using System.Collections.Concurrent;
using Microsoft.AspNetCore.DataProtection;
using Yap.Models;
using Yap.Services;

namespace Yap.Offline;

/// <summary>
/// A username and its current effective presence status for the live user list.
/// </summary>
public record LivePerson(string Username, string Status);
/// <summary>
/// Transient presence and selected-conversation typing state for one connected client.
/// </summary>
public record LiveView(string Status, string ChosenStatus, int OnlineCount, LivePerson[] Users, Guid? ChannelId, string[] Typing);

/// <summary>
/// Coordinates connection-owned presence, visibility and typing through the shared chat service;
/// this transient state is never replayed from offline storage.
/// </summary>
public sealed class OfflineLiveService(ChatService chat, IDataProtectionProvider protection, UserService users, ChatLimits limits)
{
    private readonly ITimeLimitedDataProtector tickets = protection.CreateProtector("Yap.Chat.Live.v1").ToTimeLimitedDataProtector();
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    /// <summary>
    /// Tracks one connected transport's owner, selected conversation and typing expiry.
    /// </summary>
    private record Session(Guid UserId, string Username, Guid? Channel = null, DateTime TypingUntil = default);
    private static string Key(string connection) => "chat:" + connection;
    public string Ticket(User user) => tickets.Protect(user.Id.ToString(), TimeSpan.FromMinutes(2));

    public async Task Join(string connection, User user, string ticket, UserStatus chosen, bool visible, bool mobile, double idleSeconds, string? clientIp = null)
    {
        if (!Enum.IsDefined(chosen) || tickets.Unprotect(ticket) != user.Id.ToString())
            throw new InvalidOperationException("Invalid live session ticket");
        await gate.WaitAsync();
        try
        {
            if (sessions.ContainsKey(connection))
                return;
            sessions[connection] = new(user.Id, user.Username);
            await chat.AddUserAsync(Key(connection), user.Id, user.Username, chosen, mobile, clientIp: clientIp, pageVisible: visible);
            await chat.ConnectionUp(Key(connection));
            await chat.ReportClientStateAsync(Key(connection), visible, idleSeconds);
            // A fresh connection replaces retained disconnected sessions for this account.
            // Add first so their removal cannot reset a manually chosen status.
            foreach (var old in chat.GetSessionsForUser(user.Username)
                .Where(s => !s.Connected && s.SessionId.StartsWith("chat:", StringComparison.Ordinal)))
                await chat.ConnectionDown(old.SessionId, closed: true);
        }
        finally { gate.Release(); }
    }
    private Session Require(string connection, User user)
    {
        if (!sessions.TryGetValue(connection, out var session) || session.UserId != user.Id || !chat.HasSession(Key(connection)))
            throw new InvalidOperationException("Live session unavailable");
        return session;
    }
    private async Task Stop(string connection, Session session)
    {
        sessions[connection] = session with
        {
            TypingUntil = default
        };
        if (session.Channel is { } channel && !sessions.Any(pair => pair.Key != connection && pair.Value.UserId == session.UserId && pair.Value.Channel == channel && pair.Value.TypingUntil > DateTime.UtcNow))
            await chat.StopTypingAsync(channel, session.Username);
    }
    public async Task Report(string connection, User user, bool visible, double idleSeconds, Guid? channelId, bool validatedView = true)
    {
        await gate.WaitAsync();
        try
        {
            var session = Require(connection, user);
            var now = DateTime.UtcNow;
            if (reports.TryGetValue(connection, out var previous) && previous.Visible == visible && previous.Channel == channelId
                && (previous.Idle >= 300) == (idleSeconds >= 300) && now - previous.At < TimeSpan.FromMilliseconds(250))
                return;
            reports[connection] = (now, visible, idleSeconds, channelId);
            if (channelId is { } id && chat.GetChannel(id)?.CanAccess(user.Id) != true)
                channelId = null;
            if (session.Channel != channelId || !visible)
                await Stop(connection, session);
            sessions[connection] = sessions[connection] with
            {
                Channel = channelId
            };
            var channel = channelId is { } current ? chat.GetChannel(current) : null;
            chat.SetSessionViewing(Key(connection), channel == null ? null : channel.IsDirectMessage ? "DM: " + channel.GetOtherParticipant(user.Username) : "#" + channel.Name, validatedView ? channelId : null);
            await chat.ReportClientStateAsync(Key(connection), visible, idleSeconds);
        }
        finally { gate.Release(); }
    }
    public async Task SetStatus(string connection, User user, UserStatus status)
    {
        Require(connection, user);
        if (!Enum.IsDefined(status))
            throw new InvalidOperationException("Invalid status");
        if ((chat.GetStatusBeforeAutoAway(user.Username) ?? chat.GetUserStatus(user.Username)) == status)
            return;
        await chat.SetUserStatusAsync(Key(connection), status);
    }
    public async Task Typing(string connection, User user, Guid channelId, bool active)
    {
        await gate.WaitAsync();
        try
        {
            var session = Require(connection, user);
            var channel = chat.GetChannel(channelId);
            if (session.Channel != channelId || channel?.CanAccess(user.Id) != true || !channel.CanWrite(user.Id, chat.IsAdmin(user.Id)))
                throw new InvalidOperationException("Conversation unavailable for typing");
            if (!active || !chat.IsSessionPageVisible(Key(connection)))
            {
                await Stop(connection, session);
                return;
            }
            sessions[connection] = session with
            {
                TypingUntil = DateTime.UtcNow.AddMilliseconds(limits.TypingTimeoutMs)
            };
            await chat.StartTypingAsync(channelId, user.Username);
        }
        finally { gate.Release(); }
    }
    private LivePerson[] people = [];
    private readonly ConcurrentDictionary<string, System.Threading.Channels.Channel<LiveView>> listeners = new();
    private readonly ConcurrentDictionary<string, (LiveView View, DateTime At)> lastViews = new();
    private readonly ConcurrentDictionary<string, (DateTime At, bool Visible, double Idle, Guid? Channel)> reports = new();

    public LiveView View(string connection, User user) => BuildView(connection, user);
    private LiveView BuildView(string connection, User user, Dictionary<Guid, string[]>? typingByChannel = null)
    {
        var session = Require(connection, user);
        var status = chat.GetUserStatus(user.Username) ?? UserStatus.Online;
        var typing = session.Channel is { } channel && chat.GetChannel(channel)?.CanAccess(user.Id) == true
            ? (typingByChannel?.GetValueOrDefault(channel) ?? chat.GetTypingUsers(channel).Order().ToArray()).Where(name => name != user.Username).ToArray() : [];
        return new(status.ToString().ToLowerInvariant(), (chat.GetStatusBeforeAutoAway(user.Username) ?? status).ToString().ToLowerInvariant(), people.Length, people, session.Channel, typing);
    }
    public async IAsyncEnumerable<LiveView> Watch(string connection, User user, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var queue = System.Threading.Channels.Channel.CreateBounded<LiveView>(new System.Threading.Channels.BoundedChannelOptions(1) { FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest });
        if (!listeners.TryAdd(connection, queue))
            throw new InvalidOperationException("Activity stream already active");
        try
        {
            yield return BuildView(connection, user);
            await foreach (var view in queue.Reader.ReadAllAsync(cancellationToken))
                yield return view;
        }
        finally { listeners.TryRemove(connection, out _); lastViews.TryRemove(connection, out _); }
    }
    public void Tick()
    {
        // One shared people projection and one typing lookup per viewed channel per tick.
        var currentPeople = chat.GetAllUsersWithStatus().OrderBy(p => p.Username).Select(p => new LivePerson(p.Username, p.Status.ToString().ToLowerInvariant())).ToArray();
        if (!people.SequenceEqual(currentPeople))
            people = currentPeople;
        var typing = sessions.Values.Where(s => s.Channel.HasValue)
            .Select(s => s.Channel!.Value).Distinct().ToDictionary(id => id, id => chat.GetTypingUsers(id).Order().ToArray());
        foreach (var pair in listeners)
        {
            if (!sessions.TryGetValue(pair.Key, out var session))
                continue;
            var user = users.GetById(session.UserId);
            if (user == null)
            {
                pair.Value.Writer.TryComplete();
                continue;
            }
            try
            {
                var view = BuildView(pair.Key, user, typing);
                var now = DateTime.UtcNow;
                if (lastViews.TryGetValue(pair.Key, out var previous)
                    && ReferenceEquals(previous.View.Users, view.Users) && previous.View.Status == view.Status
                    && previous.View.ChosenStatus == view.ChosenStatus && previous.View.ChannelId == view.ChannelId
                    && previous.View.Typing.SequenceEqual(view.Typing)
                    && (view.Typing.Length == 0 || now - previous.At < TimeSpan.FromSeconds(1)))
                    continue;
                lastViews[pair.Key] = (view, now);
                pair.Value.Writer.TryWrite(view);
            }
            catch (InvalidOperationException error) { pair.Value.Writer.TryComplete(error); }
        }
    }
    public async Task Leave(string connection)
    {
        await gate.WaitAsync();
        try
        {
            if (!sessions.TryGetValue(connection, out var session))
                return;
            await Stop(connection, session);
            sessions.TryRemove(connection, out _);
            reports.TryRemove(connection, out _);
            await chat.ConnectionDown(Key(connection));
        }
        finally { gate.Release(); }
    }

    public async Task Close(string connection, User user)
    {
        await gate.WaitAsync();
        try
        {
            // The cookie/CSRF account must own this exact connection. A late unload from an
            // old tab must never close its replacement or a sibling, even after socket loss.
            var owned = chat.GetSessionsForUser(user.Username).Any(s => s.SessionId == Key(connection) && s.UserId == user.Id);
            if (!owned)
                return;
            if (sessions.TryGetValue(connection, out var session))
                await Stop(connection, session);
            sessions.TryRemove(connection, out _);
            reports.TryRemove(connection, out _);
            if (listeners.TryRemove(connection, out var listener))
                listener.Writer.TryComplete();
            lastViews.TryRemove(connection, out _);
            await chat.ConnectionDown(Key(connection), closed: true);
            RestoreSiblingTyping(user.Id);
        }
        finally { gate.Release(); }
    }
    private void RestoreSiblingTyping(Guid userId)
    {
        foreach (var other in sessions.Values.Where(s => s.UserId == userId && s.Channel != null && s.TypingUntil > DateTime.UtcNow))
            _ = chat.StartTypingAsync(other.Channel!.Value, other.Username);
    }
}

/// <summary>
/// Publishes changed presence/typing projections. Disconnect timing belongs to ChatService.
/// </summary>
public sealed class OfflinePresenceTicker(OfflineLiveService live, ILogger<OfflinePresenceTicker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                try
                {
                    live.Tick();
                }
                catch (Exception error) { logger.LogError(error, "Presence publication failed"); }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
