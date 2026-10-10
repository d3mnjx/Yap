using System.Diagnostics;
using Microsoft.AspNetCore.Components.Server.Circuits;
using Yap.Helpers;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Handles circuit lifecycle events: diagnostics labeling, status save/restore around reconnects,
/// and the disconnect-grace auto-away. Idle-based auto-away lives in ChatService, driven by the
/// client-state heartbeat (chat.js probe → ReportClientStateAsync) — NOT by circuit traffic,
/// which the probe itself would keep "active" forever.
/// </summary>
public sealed class ChatCircuitHandler : CircuitHandler, IDisposable
{
    private static readonly TimeSpan DisconnectGracePeriod = TimeSpan.FromSeconds(30);

    // Inbound activities slower than this get reported to CircuitTracker and logged.
    private const double SlowInboundEventMs = 100;

    private readonly ChatService _chatService;
    private readonly UserStateService _userState;
    private readonly UserService _userService;
    private readonly CircuitTracker _circuitTracker;
    private readonly CircuitIdentity _identity;
    private readonly UserActionLogService _actionLog;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly ILogger<ChatCircuitHandler> _logger;

    // Disconnect grace: when the connection drops, wait briefly for a reconnect; if none arrives,
    // ChatService decides whether the user goes Away. CTS + Task.Delay avoids the threading
    // issues of System.Timers.Timer (which fires on the ThreadPool).
    private CancellationTokenSource? _disconnectGraceCts;
    private UserStatus? _statusBeforeDisconnect;
    private string? _circuitId;
    private string? _clientIp;

    public ChatCircuitHandler(
        ChatService chatService,
        UserStateService userState,
        UserService userService,
        CircuitTracker circuitTracker,
        CircuitIdentity circuitIdentity,
        UserActionLogService actionLog,
        IHttpContextAccessor httpContextAccessor,
        ILogger<ChatCircuitHandler> logger)
    {
        _chatService = chatService;
        _userState = userState;
        _userService = userService;
        _circuitTracker = circuitTracker;
        _identity = circuitIdentity;
        _actionLog = actionLog;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
    }

    public override Task OnCircuitOpenedAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        _circuitId = circuit.Id;
        _identity.CircuitId = circuit.Id; // components (the latency probe in ChatLayout) report telemetry against this id
        _circuitTracker.OnCircuitOpened(circuit.Id);

        // Capture client IP from the initial HTTP request (available during circuit setup)
        var httpContext = _httpContextAccessor.HttpContext;
        if (httpContext != null)
        {
            _clientIp = IpHelper.GetClientIp(httpContext);
        }

        // Label the circuit for the admin diagnostics table. A non-WebSocket connection means
        // SignalR fell back to SSE/long-polling — the top suspect when one client feels laggy.
        _circuitTracker.SetUser(circuit.Id, _userState.Username, _clientIp, httpContext?.WebSockets.IsWebSocketRequest);

        _logger.LogDebug("Circuit {CircuitId} opened", circuit.Id);
        return base.OnCircuitOpenedAsync(circuit, cancellationToken);
    }

    public override async Task OnConnectionUpAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        _circuitTracker.OnConnectionUp(circuit.Id);
        if (_userState.SessionId is { } connectedSession) _chatService.SetSessionConnected(connectedSession, true);
        CancelDisconnectGraceTimer();

        // Re-label on every connection-up: the username can hydrate after circuit open, and a
        // reconnect may arrive on a different transport than the original connection.
        _circuitTracker.SetUser(circuit.Id, _userState.Username, _clientIp,
            _httpContextAccessor.HttpContext?.WebSockets.IsWebSocketRequest);

        // Deliberately NO SetPageVisibility(true) here: a reconnect says nothing about visibility.
        // Hidden tabs reconnect after every deploy/blip and fire no visibilitychange to correct a
        // blind "visible" assert — which then suppresses push for the whole account. The probe
        // heartbeat reports the real state within ~10s.

        // User reconnected - restore their previous status if no other sessions changed it
        if (!string.IsNullOrEmpty(_userState.SessionId) && _statusBeforeDisconnect.HasValue)
        {
            var currentStatus = _chatService.GetUserStatus(_userState.Username!);
            if (currentStatus == _statusBeforeDisconnect.Value)
            {
                // Nothing drifted — do NOT re-assert. SetUserStatusAsync counts as a manual
                // change and wipes the auto-away restore record, so a user who was auto-Away
                // when the connection dropped came back permanently Away: activity could never
                // restore them, open DMs stopped clearing unread, and push fired mid-chat.
                _logger.LogDebug("Connection restored for {Username}, status {Status} unchanged",
                    _userState.Username, currentStatus);
            }
            else if (currentStatus == null || currentStatus == UserStatus.Invisible)
            {
                _logger.LogDebug("Connection restored for {Username}, restoring status to {Status}",
                    _userState.Username, _statusBeforeDisconnect.Value);

                await _chatService.SetUserStatusAsync(_userState.SessionId, _statusBeforeDisconnect.Value);
                _userState.Status = _statusBeforeDisconnect.Value;
            }
            else
            {
                // Another session changed the status — sync the local CHOSEN status, but never
                // copy an auto-Away into UserState.Status: it's [PersistentState], and a resumed
                // circuit would rejoin with Away as the chosen status, no restore record
                // (see ChatHeader.HandleUserStatusChanged).
                if (!_chatService.IsAutoAway(_userState.Username!))
                    _userState.Status = currentStatus.Value;
                _logger.LogDebug("Connection restored for {Username}, keeping current status {Status} (changed by another session)",
                    _userState.Username, currentStatus.Value);
            }
            _statusBeforeDisconnect = null;

            _actionLog.Log(_userState.UserId?.ToString(), UserActionLog.KnownActions.CIRCUIT_RECONNECT,
                info: _userState.Username, ip: _clientIp);
        }

        await base.OnConnectionUpAsync(circuit, cancellationToken);
    }

    public override async Task OnConnectionDownAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        _circuitTracker.OnConnectionDown(circuit.Id);

        // If the user doesn't reconnect within the grace period, ChatService decides whether they
        // go Away. This avoids the bug where users stay green for hours after disconnecting.
        StartDisconnectGraceTimer();

        // Save status for potential restore on reconnect.
        // Don't change user status here — circuit close handles cleanup via RemoveUserAsync.
        if (!string.IsNullOrEmpty(_userState.SessionId) && !string.IsNullOrEmpty(_userState.Username))
        {
            // A disconnected circuit can't be "foreground" — clear this session's page-visibility so a
            // dropped/closed device stops suppressing push to the user's other devices (e.g. phone).
            // Otherwise PageVisible stays true for the whole disconnected-circuit retention window (~4h).
            _chatService.SetPageVisibility(_userState.SessionId, false);
            _chatService.SetSessionConnected(_userState.SessionId, false);

            // If the user is auto-Away right now, save the CHOSEN status underneath instead —
            // restoring the auto-Away itself on reconnect would re-apply it as a manual status
            // (no restore record) and strand the user Away.
            var currentStatus = _chatService.GetUserStatus(_userState.Username);
            if (currentStatus.HasValue && currentStatus != UserStatus.Invisible)
            {
                _statusBeforeDisconnect = _chatService.GetStatusBeforeAutoAway(_userState.Username) ?? currentStatus;
                _logger.LogDebug("Connection lost for {Username}, saving status {Status} for restore",
                    _userState.Username, _statusBeforeDisconnect);
            }

            if (_userState.UserId.HasValue)
            {
                await _userService.UpdateLastSeenAsync(_userState.UserId.Value);
            }

            _actionLog.Log(_userState.UserId?.ToString(), UserActionLog.KnownActions.CIRCUIT_DISCONNECT,
                info: _userState.Username, ip: _clientIp);
        }

        await base.OnConnectionDownAsync(circuit, cancellationToken);
    }

    public override async Task OnCircuitClosedAsync(Circuit circuit, CancellationToken cancellationToken)
    {
        _circuitTracker.OnCircuitClosed(circuit.Id);
        CancelDisconnectGraceTimer();

        if (!string.IsNullOrEmpty(_userState.SessionId) && !string.IsNullOrEmpty(_userState.Username))
        {
            // Remove this session from ChatService
            await _chatService.RemoveUserAsync(_userState.SessionId);

            // If no other sessions remain, user status was already cleaned up by RemoveUserAsync.
            // If other sessions exist, status is preserved.
            _logger.LogDebug("Circuit closed for {Username}, session removed", _userState.Username);
        }

        await base.OnCircuitClosedAsync(circuit, cancellationToken);
    }

    /// <summary>
    /// Intercepts ALL inbound circuit activity (UI events, JS interop calls) to time slow events.
    /// Deliberately NOT treated as user activity: inbound traffic includes the latency probe and
    /// JS interop acks, which would keep any open tab "active" forever. Presence (idle, restore,
    /// auto-away) is driven by the client-state heartbeat in ChatService.ReportClientStateAsync.
    /// </summary>
    public override Func<CircuitInboundActivityContext, Task> CreateInboundActivityHandler(
        Func<CircuitInboundActivityContext, Task> next)
    {
        return async context =>
        {
            var start = Stopwatch.GetTimestamp();

            await next(context);

            // Server-side processing time for this activity (dispatch + handler + renders; network
            // excluded). Compared with the client RTT probe this separates "slow link" from "busy
            // server". Information level on purpose — visible at prod's default log level.
            var elapsedMs = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            if (elapsedMs >= SlowInboundEventMs && _circuitId is not null)
            {
                _circuitTracker.ReportSlowEvent(_circuitId, elapsedMs);
                _logger.LogInformation("Slow inbound event: {ElapsedMs:F0}ms circuit={CircuitId} user={Username}",
                    elapsedMs, _circuitId, _userState.Username);
            }
        };
    }

    private void StartDisconnectGraceTimer()
    {
        _disconnectGraceCts?.Cancel();
        _disconnectGraceCts?.Dispose();
        _disconnectGraceCts = new CancellationTokenSource();
        _ = DisconnectGraceAsync(_disconnectGraceCts.Token);
    }

    private void CancelDisconnectGraceTimer()
    {
        _disconnectGraceCts?.Cancel();
        _disconnectGraceCts?.Dispose();
        _disconnectGraceCts = null;
    }

    /// <summary>
    /// Waits out the grace period after a connection drop; if the circuit hasn't reconnected
    /// (which cancels this), asks ChatService to flip the user Away unless one of their other
    /// devices is a live foreground client. UserState.Status syncs via ChatHeader's status event.
    /// </summary>
    private async Task DisconnectGraceAsync(CancellationToken token)
    {
        try
        {
            await Task.Delay(DisconnectGracePeriod, token);

            if (!string.IsNullOrEmpty(_userState.SessionId))
                await _chatService.TrySetAutoAwayAfterDisconnectAsync(_userState.SessionId);
        }
        catch (OperationCanceledException)
        {
            // Reconnected or circuit closed, ignore
        }
    }

    public void Dispose()
    {
        _disconnectGraceCts?.Cancel();
        _disconnectGraceCts?.Dispose();
    }
}
