# One Slow Phone Blocked Everyone

### How Yap's real-time events went from a custom hub, through parallel dispatch with timeouts, to plain Action delegates

A chat app has one core promise. One user sends a message, and every other screen shows it now. [Yap](https://github.com/urza/Yap) is a small self-hosted chat application built with Blazor Server (.NET 10). We tried three architectures for that promise over the life of the project. The first was a custom SignalR hub. The second awaited async events across all connected users, and it produced lags of several seconds. The third is the one we kept, and it is the simplest of the three: plain C# `Action` events on a singleton, where the sender never waits for anyone.

This article walks through the history, because the failures explain the final design. All code shown is real code from the repository, past or present.

## Era 1: WebAssembly and a custom hub (July 2025)

The first commit was a four-project .NET Aspire solution. A Blazor WebAssembly client, a server project with a custom SignalR `ChatHub` and REST controllers, a static-serve project, and the Aspire host. This is the architecture most tutorials give you for a chat app, and it worked.

It was also too much machinery for a small self-hosted app. Four projects to build and deploy. CORS between the client and the server. A `/api/config` discovery endpoint so the client could find its server. Two `wwwroot` folders. JavaScript interop for simple features like tab notifications. Five days in, we wrote a migration plan titled "exercise for another day" and let the repo sleep for five months.

The lesson from this era was about complexity, not latency. The custom hub itself was fine. Everything around it was the cost.

## Era 2: the Blazor Server rewrite and the first event design (December 2025)

In December we rewrote the app as a single Blazor Server project and deleted the custom hub. Blazor Server already keeps one persistent SignalR connection per user, the circuit. Every UI update travels over it. A custom hub next to it would duplicate the transport, so the design became: reuse the circuit, and connect users through a singleton service.

`ChatService` is a singleton. Every user's components (scoped, one set per circuit) subscribe to its events. The first version of those events looked reasonable:

```csharp
public event Func<ChatMessage, Task>? OnMessageReceived;
public event Func<string, bool, Task>? OnUserChanged;
public event Func<Task>? OnUsersListChanged;
public event Func<Task>? OnTypingUsersChanged;
```

And the dispatch looked innocent:

```csharp
await OnMessageReceived.Invoke(message);
```

This line hides the problem. `OnMessageReceived` is a multicast delegate with one handler per connected user. `Invoke` on a multicast delegate calls the handlers one by one, in sequence. Each handler hops onto its user's circuit and repaints that user's screen. Every handler ran on the sender's call path before the next one started.

With three users this was invisible. With more users on real connections, the send call slowed down with every subscriber. The lag was baked into the design from day one of this era. We just could not see it yet on localhost.

## Era 3: the fight (January 2026)

### Round 1: dispatch in parallel

The first fix (commit `74789ab`, January 20) replaced the sequential chain with an `InvokeParallelAsync` helper. All handlers ran concurrently under `Task.WhenAll`. Each handler got its own try/catch, so one broken circuit could not break the others. We also added instrumentation in the same commit: a warning when any dispatch took over 100 ms, and a `/api/diagnostics` endpoint that counted circuits and event subscribers.

This helped, and the instrumentation mattered more than the fix. The warnings kept firing.

### Round 2: the slowest handler still wins

`Task.WhenAll` completes when the slowest handler completes. The commit message of the next fix (`64d0fe3`, January 24) states the failure plainly: a slow or disconnected mobile client blocked the entire dispatch for about 60 seconds, the Blazor circuit timeout. One phone in a dead spot froze the send path for the whole room.

The fix was a 5-second timeout per handler:

```csharp
var handlerTask = handler(arg);
var completedTask = await Task.WhenAny(handlerTask, Task.Delay(HandlerTimeout));

if (completedTask != handlerTask)
{
    _logger.LogWarning("Event handler timed out after {Timeout}s in {Caller}", ...);
    // Don't await the slow handler - let it complete in background
}
```

Now the worst case was 5 seconds instead of 60. That is a better number and still a terrible chat experience. We were tuning a design instead of questioning it.

### Round 3: trace the whole flow

In early February (commit `841b7f5`) we stopped patching and traced one complete send, step by step, into a 472-line analysis (the file is gone; `git show 841b7f5:docs/message-send-flow-analysis.md` has it). The scenario: Alice uploads an image, Bob and Charlie watch the room. The trace found where the seconds went:

- Alice's circuit stayed blocked through the entire chain: DB persist, typing dispatch, message dispatch, unread dispatch. She could not type or click until all of it finished.
- The message dispatch was bounded by the slowest circuit, because each handler ran 3 to 4 JavaScript interop round trips (scroll, visibility checks) inside the awaited handler. On a healthy connection each trip costs 1 to 5 ms. On a slow phone, 50 to 100 ms.
- Unread counts dispatched per user in a sequential loop. Twenty users meant twenty awaited dispatches, one after another.
- Some handlers raised further events inside the outer dispatch. Nested awaits inside awaits.

The pattern behind all four findings is the same. The design coupled the sender's latency to every receiver's latency. Parallelism and timeouts shrank the coupling. Only a different design could remove it.

## Era 4: the current architecture (February 2026, unchanged since)

The settlement (commit `3259b58`, "refactored events to be simpler") inverted the responsibility. The service stopped caring when screens repaint. Across seven files the refactor added 245 lines and deleted 356, and most of the deleted lines were the dispatch machinery from era 3.

### The design

Events became plain `Action` delegates. Raising one is a synchronous method call that queues work and returns:

```csharp
// ChatService.cs — the events are the whole fan-out API
public event Action<ChatMessage>? OnMessageReceived;
public event Action<ChatMessage>? OnMessageUpdated;
public event Action<Guid, Guid>? OnMessageDeleted;   // messageId, channelId
public event Action<ChatMessage>? OnReactionChanged;
public event Action<string, UserStatus>? OnUserStatusChanged;
public event Action<Guid, Guid>? OnUnreadChanged;    // userId, channelId
```

The send path does its own work, raises the events, and moves on:

```csharp
// ChatService.SendMessageAsync — state first, then notify, never wait
var affectedUserIds = await IncrementUnreadCountsAsync(channelId, userId);

if (wasTyping)
    OnTypingUsersChanged?.Invoke(channelId);

OnMessageReceived?.Invoke(message);
NotifyUnreadChanged(channelId, affectedUserIds);
```

Each component subscribes with an `async void` handler. The handler hops onto its own circuit with `InvokeAsync` and protects itself:

```csharp
// RoomChat.razor — one subscriber, self-contained
ChatService.OnMessageReceived += HandleMessageReceived;

private async void HandleMessageReceived(ChatMessage message)
{
    if (message.ChannelId == channelId)
    {
        try
        {
            await InvokeAsync(() =>
            {
                messages.Add(message);
                StateHasChanged();
            });
            if (ShouldMarkReadOnReceive())
                await ChatService.MarkChannelAsReadAsync(UserId, channelId, silent: true, ...);
            await InvokeAsync(ScrollToBottomAsync);
        }
        catch (Exception ex)
        {
            if (ex is ObjectDisposedException or InvalidOperationException)
                Logger.LogWarning("HandleMessageReceived: {Message}", ex.Message);
            else
                Logger.LogError(ex, "Error in HandleMessageReceived");
        }
    }
}
```

`async void` is normally a warning sign in C#. Here it is the point. The service invokes the handler synchronously, the handler starts its async work, and control returns to the service at the first await. The service cannot observe the handler's completion, which is exactly the decoupling we needed. The try/catch is mandatory for the same reason: nobody upstream can catch for you.

### What the flow looks like now

```
Alice's circuit        ChatService (singleton)     Bob's circuit       Charlie's circuit
───────────────        ───────────────────────     ─────────────       ─────────────────
send message ────────► persist to DB
                       update unread counts
                       raise OnMessageReceived ──► handler starts ──► handler starts
                       raise OnUnreadChanged        │                  │
     ◄──────────────── return (sender is free)      │                  │
own echo renders                                    │                  │
                                                    ▼                  ▼
                                          InvokeAsync on own   InvokeAsync on own
                                          circuit, render,     circuit, render,
                                          scroll               scroll
                                          (at Bob's pace)      (at Charlie's pace)
```

The sender waits only for the server's own work: the persist and the in-memory updates. Production telemetry puts that at 71 ms or less, including the SQLite write. Every receiver renders at the pace of their own connection. A phone in a tunnel delays only its own screen. Compare the properties of the three dispatch designs:

| | Sequential await (Dec) | WhenAll + timeout (Jan) | Action, fire and forget (Feb) |
|---|---|---|---|
| Sender waits for receivers | all of them, in order | the slowest, up to 5 s | never |
| One dead circuit affects others | blocks everyone | delays everyone 5 s | affects nobody |
| Failure isolation | try/catch in dispatcher | try/catch in dispatcher | each handler protects itself |
| Dispatch machinery in ChatService | none | ~150 lines | none |

### The rules that keep it working

The design is simple, and it stays simple only if a few rules hold. They are worth stating, because each one guards against a specific regression:

- The service mutates state before it raises the event. Subscribers may render immediately, and the first render must already see correct data.
- Handlers touch their component only inside `InvokeAsync`. The event arrives on the raiser's thread, and Blazor state belongs to the circuit's dispatcher.
- Every handler catches its own exceptions. `ObjectDisposedException` and `InvalidOperationException` mean the circuit died mid-render. That is normal in a chat app and logs as a warning, not an error.
- Components unsubscribe in `DisposeAsync`, before any awaits. A leaked subscription keeps a dead circuit's handler on the singleton forever.
- A handler that must call back into `ChatService` uses the `silent` flavor of the method, so it does not raise nested events from inside an event.

## What we learned

The custom hub was never the problem, and neither was Blazor Server. The problem in every slow version was the same coupling: the sender's call chain included the receivers' rendering. Parallel dispatch reduced the coupling. Timeouts capped it. Only removing it worked, and removing it also deleted the most complex code in the service.

The instrumentation from round 1 outlived every fix it was built to diagnose. The dispatch-time warnings, the circuit counts, and the subscriber counts are still in the diagnostics endpoint today, and they later carried the [responsiveness work](article-responsiveness-in-blazor-server.md) that measured a 904 ms round trip for our remote users. Measure first still holds. So does the quieter lesson: when you patch the same design for the third time, trace the whole flow and question the design.
