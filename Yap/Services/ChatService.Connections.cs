namespace Yap.Services;

public partial class ChatService : IDisposable
{
    // Lifecycle transitions and timer callbacks share a gate. A cancelled callback may already
    // be queued, so it must also match the exact disconnect record before touching presence.
    private readonly object _connectionGate = new();
    private readonly Dictionary<string, Disconnect> _disconnects = new();
    private sealed class Disconnect(DateTimeOffset at, TimeSpan retention)
    {
        public DateTimeOffset At { get; } = at;
        public TimeSpan Retention { get; } = retention;
        public ITimer? Timer
        {
            get; set;
        }
    }

    // Only state mutation runs under the gate. Projection and bot/UI callbacks can be
    // expensive (or re-enter ChatService), so publish the captured notifications afterward.
    private void ChangeConnections(Action<List<Action>> change)
    {
        var notifications = new List<Action>();
        lock (_connectionGate)
            change(notifications);
        foreach (var notify in notifications)
            try
            {
                notify();
            }
            catch (Exception error) { _logger.LogError(error, "Presence notification failed"); }
    }

    private void PeopleChanged(List<Action> notifications) => notifications.Add(() =>
    {
        _changes.Touch(OfflineChangeKind.People);
        OnUsersListChanged?.Invoke();
    });

    private readonly Dictionary<string, PresenceChange> _presenceChanges = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _announcedUsers = new(StringComparer.OrdinalIgnoreCase);
    private sealed class PresenceChange(bool joined)
    {
        public bool Joined { get; } = joined;
        public ITimer? Timer
        {
            get; set;
        }
    }

    private void SchedulePresenceChange(string username, bool joined)
    {
        if (_presenceChanges.TryGetValue(username, out var previous) && previous.Joined == joined)
            return;
        if (_presenceChanges.Remove(username, out previous))
            previous.Timer?.Dispose();
        // A quick reload cancels the pending leave. A short first visit never announces
        // a join followed by a leave. The session list itself always changes immediately.
        if (_announcedUsers.Contains(username) == joined)
            return;
        var pending = new PresenceChange(joined);
        _presenceChanges[username] = pending;
        pending.Timer = _connectionClock.CreateTimer(_ => ChangeConnections(notifications =>
        {
            if (!_presenceChanges.TryGetValue(username, out var current) || !ReferenceEquals(current, pending))
                return;
            _presenceChanges.Remove(username);
            pending.Timer?.Dispose();
            if (joined)
                _announcedUsers.Add(username);
            else
                _announcedUsers.Remove(username);
            notifications.Add(() => OnUserChanged?.Invoke(username, joined));
        }), null, _presenceOptions.DisconnectGrace, Timeout.InfiniteTimeSpan);
    }

    public Task ConnectionUp(string sessionId)
    {
        ChangeConnections(notifications =>
        {
            CancelDisconnect(sessionId);
            SetSessionConnected(sessionId, true, notifications);
            if (_users.TryGetValue(sessionId, out var session))
                SchedulePresenceChange(session.Username, true);
            // Visibility and activity come from the browser, not the transport reconnect.
        });
        return Task.CompletedTask;
    }

    public Task ConnectionDown(string sessionId, bool closed = false)
    {
        ChangeConnections(notifications =>
        {
            if (closed)
            {
                RemoveUser(sessionId, notifications);
                return;
            }
            if (!_users.TryGetValue(sessionId, out var session) || _disconnects.ContainsKey(sessionId))
                return;
            _users[sessionId] = session with
            {
                PageVisible = false,
                Connected = false,
                ViewingChannel = null,
                ReadingChannelId = null
            };
            PeopleChanged(notifications);
            var pending = new Disconnect(_connectionClock.GetUtcNow(),
                session.CircuitId == null ? _presenceOptions.HubRetention : _presenceOptions.CircuitRetention);
            _disconnects.Add(sessionId, pending);
            pending.Timer = _connectionClock.CreateTimer(_ => ApplyDisconnect(sessionId, pending), null,
                _presenceOptions.DisconnectGrace, Timeout.InfiniteTimeSpan);
        });
        return Task.CompletedTask;
    }

    private void ApplyDisconnect(string sessionId, Disconnect pending)
    {
        try
        {
            ChangeConnections(notifications =>
            {
                if (!_disconnects.TryGetValue(sessionId, out var current) || !ReferenceEquals(current, pending))
                    return;
                var remaining = pending.Retention - (_connectionClock.GetUtcNow() - pending.At);
                if (remaining <= TimeSpan.Zero)
                    RemoveUser(sessionId, notifications);
                else
                {
                    pending.Timer!.Change(remaining, Timeout.InfiniteTimeSpan);
                    TrySetAutoAwayAfterDisconnect(sessionId, notifications);
                }
            });
        }
        catch (Exception error) { _logger.LogError(error, "Disconnect lifecycle failed for {SessionId}", sessionId); }
    }

    private void CancelDisconnect(string sessionId)
    {
        if (_disconnects.Remove(sessionId, out var pending))
            pending.Timer?.Dispose();
    }

    public void Dispose()
    {
        lock (_connectionGate)
        {
            foreach (var pending in _disconnects.Values)
                pending.Timer?.Dispose();
            _disconnects.Clear();
            foreach (var pending in _presenceChanges.Values)
                pending.Timer?.Dispose();
            _presenceChanges.Clear();
            _announcedUsers.Clear();
        }
    }
}
