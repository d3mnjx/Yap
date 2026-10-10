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

    public Task ConnectionUp(string sessionId)
    {
        lock (_connectionGate)
        {
            CancelDisconnect(sessionId);
            SetSessionConnected(sessionId, true);
            // Visibility and activity come from the browser, not the transport reconnect.
            return Task.CompletedTask;
        }
    }

    public Task ConnectionDown(string sessionId, bool closed = false)
    {
        lock (_connectionGate)
        {
            if (closed)
                return RemoveUserAsync(sessionId);
            if (!_users.TryGetValue(sessionId, out var session) || _disconnects.ContainsKey(sessionId))
                return Task.CompletedTask;
            SetPageVisibility(sessionId, false);
            SetSessionConnected(sessionId, false);
            SetSessionViewing(sessionId, null);
            var pending = new Disconnect(_connectionClock.GetUtcNow(),
                session.CircuitId == null ? _presenceOptions.HubRetention : _presenceOptions.CircuitRetention);
            _disconnects.Add(sessionId, pending);
            pending.Timer = _connectionClock.CreateTimer(_ => ApplyDisconnect(sessionId, pending), null,
                _presenceOptions.DisconnectGrace, Timeout.InfiniteTimeSpan);
            return Task.CompletedTask;
        }
    }

    private void ApplyDisconnect(string sessionId, Disconnect pending)
    {
        lock (_connectionGate)
        {
            if (!_disconnects.TryGetValue(sessionId, out var current) || !ReferenceEquals(current, pending))
                return;
            try
            {
                var remaining = pending.Retention - (_connectionClock.GetUtcNow() - pending.At);
                // Presence mutations stay inside the gate so a reconnect cannot race expiry.
                if (remaining <= TimeSpan.Zero)
                    RemoveUser(sessionId);
                else
                {
                    pending.Timer!.Change(remaining, Timeout.InfiniteTimeSpan);
                    TrySetAutoAwayAfterDisconnect(sessionId);
                }
            }
            catch (Exception error) { _logger.LogError(error, "Disconnect lifecycle failed for {SessionId}", sessionId); }
        }
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
        }
    }
}
