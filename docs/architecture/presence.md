# Presence

Who is online, away or offline, who types, and when a join or leave line appears. The spec page is [presence.md](../spec/presence.md) (PR-01 to PR-25). This page says how `Services/Presence/PresenceService` produces those rules from hub connections, and what sits around it.

## What presence is made of

Three kinds of fact, kept apart because they change for different reasons.

| Fact | Lives in | Changes when |
| --- | --- | --- |
| **Chosen status**: online, away, invisible | `User.Status`, owned by UserService, persisted (PR-01, PR-02) | the person picks it in the status menu, on any device |
| **Sessions**: one per hub connection | PresenceService, memory only | a tab connects, drops, closes, sends a heartbeat, opens a conversation |
| **Automatic away**: a flag per person | PresenceService, memory only | the sweep sets it, input clears it (PR-10, PR-13) |

From these, PresenceService computes the **effective status** that other people see. In code it is the enum `EffectiveStatus` with the values Online, Away and Offline. It is not called `Presence`, because that name is the namespace.

| Chosen | Sessions | Auto-away | Effective |
| --- | --- | --- | --- |
| any | none | | offline |
| invisible | some | | offline (PR-05) |
| away | some | | away |
| online | some | no | online |
| online | some | yes | away (PR-04) |

The bot has one permanent session registered at startup, so it is always online (PR-09).

## The session

```cs
// Services/Presence/Session.cs (sketch)
public sealed class Session
{
    public required string ConnectionId { get; init; }     // SignalR connection id
    public required Guid UserId { get; init; }
    public required string Username { get; init; }
    public required string DeviceId { get; init; }         // from local storage; tabs on one device share it (AU-19)
    public required bool IsMobile { get; init; }           // User-Agent at connect (PR-25)
    public string Browser { get; init; }                   // User-Agent family, and the system below (AD-41)
    public string Os { get; init; }
    public bool Pwa { get; init; }                         // the hub URL said pwa=1: the installed app (AD-41)
    public required string ClientIp { get; init; }
    public required string Transport { get; init; }        // WebSockets, ServerSentEvents, LongPolling (AD-26)
    public DateTime ConnectedAt { get; init; }

    public DateTime? ClosedAt { get; set; }      // the client closed the connection: tab closed, sign-out, reload
    public DateTime? DroppedAt { get; set; }     // the connection was lost: network, sleep, closed laptop
    public bool Connected => ClosedAt is null && DroppedAt is null;

    public bool Visible { get; set; }            // from the heartbeat
    public DateTime LastInputAt { get; set; }    // now minus the heartbeat's idle seconds
    public DateTime LastHeartbeatAt { get; set; }
    public Guid? Viewing { get; set; }           // the open conversation, for diagnostics and typing

    public LatencyStats Latency { get; } = new(); // RTT and send-to-appear: last, average, max, slow events
    public LoadReport? Load { get; set; }         // the boot report of the page load that opened this connection (AD-41)
}
```

Two time stamps for two ways to disconnect, because the spec treats them differently. SignalR tells them apart: `OnDisconnectedAsync` gets `null` when the client closed the connection, and an exception when the transport failed or the keep-alive timed out.

## The sweep

Blazor had a timer per circuit. Here one timer runs every 10 seconds over all sessions, which the spec allows (PR-10, PR-13: "within 10 seconds"). The rules, in the order they run:

```cs
// Services/Presence/PresenceService.cs (sketch of the sweep)
void Sweep(DateTime now)
{
    lock (_gate)
    {
        foreach (var s in _sessions.Values.ToList())
        {
            if (s.ClosedAt is { } closed && now - closed > TimeSpan.FromSeconds(30)) Remove(s);   // PR-17: a reload shows nothing
            else if (s.DroppedAt is { } dropped && now - dropped > TimeSpan.FromMinutes(5)) Remove(s); // PR-16
        }
        foreach (var userId in _sessions.Values.Select(s => s.UserId).Distinct())
        {
            var mine = _sessions.Values.Where(s => s.UserId == userId).ToList();
            var connected = mine.Where(s => s.Connected).ToList();
            bool anyVisible = connected.Any(s => s.Visible && now - s.LastHeartbeatAt < TimeSpan.FromSeconds(35));
            bool allIdle = connected.All(s => now - s.LastInputAt > TimeSpan.FromMinutes(5)
                                           || now - s.LastHeartbeatAt > TimeSpan.FromSeconds(90));
            bool droppedAWhile = mine.Any(s => s.DroppedAt is { } d && now - d > TimeSpan.FromSeconds(30));

            if ((connected.Count == 0 && droppedAWhile) || (allIdle && !anyVisible) || (droppedAWhile && !anyVisible))
                SetAutoAway(userId, true);    // PR-10, PR-15; only when the chosen status is online (PR-12)
        }
    }
}
```

`Remove` deletes the session. When it was the person's last one, the person's auto-away flag goes too, and the effective status becomes offline. Every change of effective status raises one event; a change that leaves the effective status equal raises nothing, so a second tab, a reload or a dropped tab while the desktop is visible are silent.

Auto-away ends outside the sweep: a heartbeat that reports input within the last 30 seconds clears the flag at once (PR-13), and so does a status pick.

## The lock

Everything that reads or changes `_sessions` and the auto-away flags runs under one `Lock` (`System.Threading.Lock`, .NET 9+). Hub methods run concurrently on thread-pool threads, one per connection, and the sweep runs on a timer thread. The dictionary alone could be a `ConcurrentDictionary`, but that is not the problem. The decisions are the problem: "this is the person's first session, so it is a join", "this was the last one, so it is a leave", "every session is idle, so set away", "the effective status changed, so raise one event". Each is a read of several sessions followed by a write. Two tabs connecting in the same millisecond must produce one join, not two and not none. A reload is a disconnect and a connect a few hundred milliseconds apart and must produce nothing. The lock makes each transition atomic, and it makes the events come out in the order the transitions happened.

Two rules keep it harmless. Nothing inside the lock does I/O or calls out: no hub sends, no event handlers, no database. A transition collects the changes it caused in a local list, leaves the lock, then raises them. And the work inside is microseconds over a few hundred objects, so contention is not measurable at Yap's size.

The alternative without a lock is an actor: one loop owns the state, every change is a command on a channel, like the persistence writer, and readers get an immutable snapshot that the loop republishes after each command. Ordering comes for free and no thread ever waits. It is a real design, and it is the right one when the state is large or the transitions do I/O. Here neither is true, and it adds a command type per operation, a snapshot republished on every heartbeat, and asynchronous reads for callers that only want "who is connected". A lock is one field and one keyword; the actor is a subsystem. ChatService already guards its message lists the same way, so a reader of the codebase meets one pattern.

## The hub lifecycle around it

```cs
// Endpoints/ChatHub.cs (sketch, presence parts)
public override async Task OnConnectedAsync()
{
    var http = Context.GetHttpContext()!;
    presence.Connect(new Session
    {
        ConnectionId = Context.ConnectionId,
        UserId = Context.User!.Id(), Username = Context.User!.Identity!.Name!,
        DeviceId = http.Request.Query["device"]!, IsMobile = UserAgent.IsMobile(http),
        ClientIp = IpHelper.Get(http), Transport = http.Features.Get<IHttpTransportFeature>()!.TransportType.ToString(),
        ConnectedAt = DateTime.UtcNow, LastInputAt = DateTime.UtcNow, LastHeartbeatAt = DateTime.UtcNow, Visible = true,
    });
}

public override Task OnDisconnectedAsync(Exception? exception)
    => presence.Disconnect(Context.ConnectionId, closedByClient: exception is null);

public long Heartbeat(bool visible, int idleSeconds, int? lastRttMs, WaitSample[]? samples)
{
    presence.Heartbeat(Context.ConnectionId, visible, idleSeconds, lastRttMs, samples);
    return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public Task SetStatus(UserStatus status) => presence.SetChosenStatus(Context.User!.Id(), status);
public void Typing(Guid channelId, bool on) => presence.SetTyping(Context.ConnectionId, channelId, on);
```

`Connect` is a join when the person had no session (PR-17), and returns that, so the hub writes the JOIN row of the action log (AD-18) with the address and the browser it alone knows. For a join, `Connect` also raises `OnJoined`. The hub stamps `LastSeenAt` after the call, not before: `OnJoined` is where the bot reads it as the end of the previous visit, for the return notice (PR-18). `Disconnect` only stamps `ClosedAt` or `DroppedAt`; the sweep does the rest. The hub also tells PresenceService the open conversation from `openRoom`, `openDm` and `leave`, for the diagnostics table and for typing.

The heartbeat is the single source of liveness, as it is today. The client sends it every 10 seconds while visible and every 60 seconds while hidden, and at once when the tab becomes visible or hidden or the hub reconnects. The hidden beat matters: the server reads the flag for unread counts (NT-07), for push, and for the away sweep. It carries the idle time since the last input, the previous round trip and the waits the client measured since the last beat (AD-26): send, open, older, start and reconnect, each as a name and milliseconds. A hidden tab sends no round trip; its throttled timers would measure the throttle. The return value lets the client measure the round trip.

## Events out

PresenceService raises four events. The broadcaster turns three of them into hub events.

| Event | Hub event | To | Meaning |
| --- | --- | --- | --- |
| `OnPresenceChanged(username, EffectiveStatus, PresenceChange)` | `presence` | everyone | `kind` is `join` (first session), `leave` (last session gone), or `change` (status pick, auto-away, invisible toggle). The client shows lobby lines for join and leave only (MR-73), never for change, so an invisible toggle makes no line (PR-05). |
| `OnTypingChanged(channelId, username, on)` | `typing` | the room's group, or the other DM person | The client drops a typist 3.5 s after the last `on`. A send sends `off` through ChatService (IB-59). |
| `OnChosenStatusChanged(userId, status)` | `me` | the person's devices | The menu marks the chosen status on every device (PR-01). |

Invisible people produce no `presence` event with any value other than offline, so they never appear to join or leave. The chip of an invisible person is grey because their own `presence` event says offline; their menu still marks Invisible from `me` (PR-05, SH-11).

`OnJoined(username)` is the fourth event. `Connect` raises it for a join, which is by sessions (PR-17), so an invisible person raises it too. It has no hub event. SystemBotService is the one listener: it sends the welcome message to the person and the join or return message to the admin (AU-26, PR-18). The bot does not use the `join` kind of `OnPresenceChanged`, because an invisible person never produces it.

## What asks PresenceService

| Caller | Question | Rule |
| --- | --- | --- |
| ChatService, on a send | which people have a connected session | room unread counts (NT-03) |
| ChatService, on push | is this person online with a visible connected session | push suppression (NT-26) |
| ChatService, on a send | stop the sender's typing | IB-59 |
| Login | has this account a connected session from this address | smart login (AU-09) |
| `GET /api/account/devices` | the person's sessions grouped by device | the Active Sessions card (AU-19); a dropped device stays listed until the 5 min removal |
| `POST /api/account/devices/sign-out-others` | the person's connections on other devices | close them after the `signedOut` event (AU-20) |
| the bootstrap | every effective status except offline | the people list (SH-29) |
| the admin pages | effective status including Invisible, the sessions table, the connections table | AD-04, AD-25, AD-26 |

PresenceService depends on UserService for the chosen status and on nothing else. ChatService depends on PresenceService. The broadcaster depends on both.

## The client around it

- **Input tracker.** One listener each for key, pointer, wheel and visibility records the last input time. Incoming messages are not input (PR-10).
- **Heartbeat.** One interval, re-armed at 10 s or 60 s when visibility changes, fired at once on visibility and on reconnect. It times its own invoke to measure the round trip. It also carries the named waits: `hub.report(name, ms)` queues one, at most 50. The chat page reports `open` and `start` when the server's rows are on screen, the timeline `older`, the sender `send` after the own row is rendered, and the connection loop `reconnect` when the room is back in sync.
- **Status menu.** A pick recolours the chip at once and invokes `setStatus`. Without a connection the three items are dimmed (SH-13).
- **Chip colour.** From the person's own `presence` event, so automatic away shows orange while the menu, fed by `me`, still marks Online (PR-04).
- **People list and count.** From the `presence` map in the store, merged with the person's DM partners from the bootstrap (SH-29, SH-30). Invisible and offline partners are grey and not counted.
- **Lobby lines.** For `join` and `leave` kinds only, with a text from the configured lists (MR-73). Not stored.
- **Typing.** Send `on` at the first non-blank input and at most every 2 s after, `off` on send, blank draft, leave, hidden tab (IB-59). Show typists of the open conversation with the configured texts, viewer left out (PR-21).

## Diagnostics

The sessions table (AD-25) is a dump of the session objects: user, device and address, transport, connected, visible, effective status, viewing, last input, last heartbeat, age. A row with `Visible` true and `Connected` false shows in the warning colour. The latency table (AD-26) is one `LatencyStats` per person, kept in PresenceService since the restart, with the `Latency` of each live session under it and a ring of the last 50 removed sessions. A stat is one `Wait` (rtt, send, post, open, older, start, reconnect) with last, average, maximum and count; the record is replaced whole on each sample, so the admin endpoint reads it outside the lock. A hub filter times every inbound invocation and `ApiLatencyFilter` times the message send; both count calls over 100 ms as slow events. The send lands on the person only, because the request carries no connection id. The load-time table (AD-41) is the `Load` of each live session and of the ring of closed ones: one `LoadReport` per page load, six phases in ms from the navigation start plus the file counts, sent once by the chat page over the connection the load opened.

## Spec notes met here

- PR-14 says a person who closes the last tab "shows as offline at once". PR-17 says the leave is "30 seconds after the person closes the last tab" and that a reload therefore shows nothing. The two cannot both hold. This design follows PR-17, because a reload must not produce a leave and a join line. Proposed spec fix: PR-14 reads "shows as offline 30 seconds later, without an away phase; a return within that time shows nothing".
- Today's code keys typing by username, so one tab's `off` ends typing for all tabs of the person. The sketch keys it by connection and shows the person as typing while any connection types.
