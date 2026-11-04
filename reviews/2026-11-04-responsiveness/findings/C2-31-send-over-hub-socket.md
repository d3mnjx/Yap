---
id: C2-31
title: Send messages over the warm hub socket instead of an HTTP POST
category: 2
journey: send
effort: M
confidence: low
behaviour-change: none
estimated-gain: Zero when the HTTP/2 connection is warm. After a quiet period in which the browser or the proxy closed it, a POST pays a new TCP and TLS set-up, about 2 round trips (1.8 s for the far user) before its own round trip; the hub socket is kept warm by the 10 s heartbeat. Unknown how often; depends on the idle timeouts of the browser, Caddy and Cloudflare, and on whether the WebSocket shares the HTTP/2 connection.
experiment: none
sources: [client-core-11]
files: [Yap/wwwroot/js/sender.js:111-125, Yap/wwwroot/js/hub.js:240-250, Yap/wwwroot/js/hub.js:318-321, Yap/Endpoints/ChatHub.cs:15-22]
---

## What the code does now
`flush()` posts each row over HTTP (sender.js:113-119):

```js
const url = row.partner ? `/api/dm/${encodeURIComponent(row.partner)}/messages` : `/api/channels/${row.channelId}/messages`;
const message = await api.post(url, { clientId: row.clientId, text: row.text || null, ... });
```

The ChatHub comment (ChatHub.cs:17) says: "Sending a message is HTTP, for the offline outbox". The hub socket carries a heartbeat every 10 s while visible (hub.js:318-321), so it stays open; HTTP requests are rare between sends.

## Why it costs the user time
A chat user often reads for minutes and then sends. If the HTTP connection idled out, the send waits for a new connection. The far user then sees the faded pending row for about three round trips instead of one. The outbox design does not need HTTP: the server dedupes by clientId whatever the carrier.

## The change
1. Server: a hub method `Send(SendRequest request)` (and `SendDm(partner, request)`) that calls the same `ChatService` code as the POST endpoints and returns the `MessageDto` or a `HubError`.
2. Client: in `flush()`, when `hub.connected()`, use `hub.invoke('send', ...)`; map `{ error: 'Needs a connection' }` to the existing "network error, stop the loop" branch and other errors to `fail(row, ...)`. Without a connection, or for the first post of a page before the socket is up, keep the POST.

Measure first (below). If the POST rarely opens a new connection, drop this finding.

## Risks and what could break
- The 409 branch ("the first copy is still being stored") and the refusal texts must map the same way.
- The server's "Server send" wait of AD-26 says the request carries no connection id; over the hub it would, which helps the telemetry.
- Two paths to the same service must stay in step (validation, rate limits).

## How to measure it
Journey send after 2, 5 and 10 minutes of reading on the far link. In the POST's Resource Timing entry, `connectEnd - connectStart > 0` means a new connection was made. Add that number to the `send` sample for a week and read how often it is non-zero.