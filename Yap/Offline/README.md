# Chat transport and synchronization

This folder is the server interface for the browser chat client, during ordinary online use and recovery after an outage. The `Offline` name refers to that client's offline capability; local drafts, queues and caches live in [`wwwroot/chat-client`](../wwwroot/chat-client/).

The folder groups related HTTP/SignalR adapters and projections inside the existing ASP.NET application. Business rules and durable acceptance stay in the shared chat/media services. Login, Settings and Admin retain their Blazor surfaces.

## Types and responsibilities

| Type | Purpose |
| --- | --- |
| [ChatRoutes](ChatRoutes.cs) | Identifies shell, API and hub paths for middleware policy. |
| [OfflineEndpoints](OfflineEndpoints.cs) | Maps the shell and `/api/chat` routes; applies authentication, no-store responses and account-bound antiforgery protection for writes. Delegates sends, mutations, reads and history to shared services. |
| [OfflineContent](OfflineContent.cs) | Adds catalog, emoji, GIF and completed-upload routes to the protected API group. Resolves media references for message acceptance through existing services. |
| [OfflineSnapshotService](OfflineSnapshotService.cs) | Builds each user's authorized recent windows and safe DTOs, with a content revision and server epoch/sequence for reconciliation. Also projects individual messages/conversations. |
| [OfflineSync](OfflineSync.cs) | Compares authorized projections and builds protocol-2 bootstrap, compact acknowledgements and stream deltas. `SyncMessage`, `ConversationUpdate` and `ChatUpdate` define the wire packets. |
| [OfflineChangeSignal](OfflineChangeSignal.cs) | Listens once to shared chat events, coalesces stream wake-ups and tracks conversation content/history versions. Signals contain no private message data. |
| [OfflineHub](OfflineHub.cs) | Serves `/hubs/chat`: `WatchChanges` streams deltas, `WatchActivity` joins and streams changed presence/typing fields, and hub methods report activity/status/typing. Revalidates the account while streams run. |
| [OfflineLiveService](OfflineLiveService.cs) | Owns connection tickets and transient session bookkeeping, coordinating presence and typing with `ChatService`. |
| [OfflineLiveCleanup](OfflineLiveService.cs) | Periodically sweeps disconnected sessions, applying auto-away and eventual removal even when no client sends further activity. |

`Reader*` records in `OfflineSnapshotService.cs` define the client-facing snapshot shapes. `LivePerson`/`LiveView` describe transient live state; the private `Session` record holds its connection lifecycle. Nested records in the endpoint/content classes define request bodies. These transport types deliberately avoid serializing persistence entities and credentials.

## How the pieces work together

```mermaid
flowchart LR
    Browser <-->|HTTP| Endpoints[OfflineEndpoints]
    Endpoints --> Chat[ChatService]
    Chat --> Persistence[ChatPersistenceService]
    Chat -->|change events| Signal[OfflineChangeSignal]
    Signal -->|wake WatchChanges| Hub[OfflineHub]
    Endpoints --> Snapshots[OfflineSnapshotService]
    Hub --> Snapshots
    Hub --> Sync[OfflineSync]
    Endpoints --> Sync
    Sync -->|Compact authority| Browser
```

1. **Connect and read.** Bootstrap validates the cookie and supplies an account-bound antiforgery token and short-lived live-session ticket. It returns summaries and the active recent window; matching cached revisions omit unchanged message bodies. Missing windows fill in the background. `OfflineSnapshotService` constructs the authorized state and `OfflineSync` shapes the wire response. Snapshot construction reads the shared services; this folder does not maintain a second message database.
2. **Accept a write.** `OfflineEndpoints` passes the authenticated operation to `ChatService.Text`, `.Actions` or `.Reads`. Message/mutation receipts are persisted through `ChatPersistenceService`; the HTTP response includes compact current authority for the browser to reconcile. `OfflineContent` resolves account-owned uploads or trusted GIF selections when needed.
3. **Notify connected clients.** Shared chat mutations wake `OfflineHub.WatchChanges` through `OfflineChangeSignal`. Each stream compares its own authorized snapshots and transmits only changes; a periodic timeout also catches preferences and revalidates authentication. History versions invalidate older cached pages on mutations while allowing ordinary arrivals to preserve them.
4. **Track live activity.** Hub calls use `OfflineLiveService` to join/report/change status/type. `WatchActivity` registers the session and selected conversation in the streaming call, then publishes changed live fields separately from messages. Report/Typing are ordered sends without a reply dependency; explicit status selection awaits confirmation. Disconnect handling clears visibility/typing immediately; `OfflineLiveCleanup` applies the grace period and removes retained sessions later.

## Wiring and boundaries

[`Program.cs`](../Program.cs) registers `OfflineSnapshotService` and `OfflineSync` as scoped, `OfflineChangeSignal` and `OfflineLiveService` as singletons, and `OfflineLiveCleanup` as a hosted service. `MapOfflineChat()` maps the shell, HTTP routes and hub. Middleware uses `ChatRoutes` for API/hub policy and validates hub handshakes; API filters and hub methods enforce their respective request/stream boundaries.

Proxy compatibility is permissive by default: forwarded public URLs do not require an address allowlist, and chat requests do not compare browser Origin with the internal URL. API writes require account-bound antiforgery tokens; API writes and hub requests reject browser-marked cross-site traffic while accepting missing metadata. Optional proxy restrictions and the trust trade-off are described in the [deployment guide](../../GHCR-DEPLOYMENT-GUIDE.md#https-reverse-proxies-and-caches).

Keep authorization, receipt compatibility and snapshot ordering intact when changing these adapters. Persistent messages/receipts belong to the shared services; browser drafts/outbox belong to the client; connection presence/typing belongs to the live service. A wake-up requests an authorized projection comparison. The old `Watch`/`WatchLive` and snapshot HTTP responses remain for documents already open during a shell upgrade; new clients send `X-Yap-Chat-Protocol: 2`.

For the wider design, see [architecture](../../docs/offline-client-architecture.md), [offline behavior](../../docs/offline-behavior.md) and [features/parity](../../docs/feature-parity-inventory.md). [Testing instructions](../../tests/browser/README.md) cover the server contract harness and browser recovery checks.

The illustrated [communication guide](../../docs/offline-communication.html) follows startup and maps features and code to HTTP, the chat hub and retained Blazor Server circuits.
