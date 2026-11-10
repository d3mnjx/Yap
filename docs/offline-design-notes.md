# Offline chat: design notes for the next implementation

Written 2026-10-14. These notes guide whoever implements offline behaviour in the new chat client. They are not the product spec. The spec (`docs/spec/`, planned) says what the user gets. These notes say how to get there with the least machinery.

## The principle

Yap is a chat for friends. It is not a critical system and it does not guarantee correctness. A message that is lost once a month is acceptable. A design that adds a subsystem to prevent that loss is not.

The user's words: the chat, when offline, must be readable with what it already has. Queuing messages while offline is nice to have. If a queued message fails to send, that is okay. Discord queues messages while offline and still never delivers them after a long outage. That is the level to aim for.

Design for the common case: a short loss of connection on a phone, a tunnel, a lift, a switch between Wi-Fi and mobile data. Do not add machinery for the rare case.

## Two separate promises

1. **Reading.** The client shows what it already has. History comes from the server. There is no local copy of history that must be kept correct.
2. **Sending.** The client accepts a message while offline, shows it as pending, and sends it when the connection returns. This needs a queue, nothing more.

Keep the two apart in code. The queue never feeds the reading side; the server does.

## The outbox

One IndexedDB store, the outbox. One row per unsent message:

| Field | Meaning |
| --- | --- |
| `clientId` | A UUID the client makes at send time. The server dedupes by it. |
| `conversation` | Room id or DM partner. |
| `text` | The message text. |
| `attachments` | The picked files as Blobs. Each is replaced by its upload id once uploaded. |
| `createdAt` | When the user pressed Send. |
| `state` | `queued` or `failed`. |

Send appends a row and paints the pending message in the timeline. That is the whole write path. The pending row shows faded, in the place where it was typed, until the server accepts it.

## The sender

Two things run, both driven by events, never by a timer.

The uploads. The files of the queued rows upload, oldest row first, at most three at one time over all rows. A browser opens six connections to one host over HTTP/1.1. Without the limit, the chunks of a slow upload fill them, and the POST of a text message waits for a free one.

The post loop:

1. Take the oldest `queued` row that is ready. A row with attachments is ready when its last file is uploaded. A row that is not ready is passed over, so a text sent after a video does not wait for the video.
2. POST the message with its `clientId` and the results of its uploads.
3. On 2xx, delete the row. The live update from the server paints the real message.
4. On a network error, stop. Do nothing until a wake-up. A 502, 503 or 504 counts as one: a reverse proxy answers so while the server behind it restarts. A 520 to 527 or a 530 counts as one too: Cloudflare answers so when it gets no answer from the server.
5. On a 4xx, set `state = failed` and stop trying that row.

An upload that nobody answers stops the uploads in the same way: no upload starts until a wake-up. The post loop and the uploads do not wait for each other.

Wake-ups: the `online` event, a SignalR reconnect, the tab becoming visible, a new row appended. No poll, no backoff table, no attempt counter, no persisted next-attempt time.

A wake-up during a run marks the run to go again when it ends. An upload with no progress for five seconds at a wake-up is given up: the files that are done stay done, and the file that was given up goes on from the bytes the server has in the run that follows. A socket that died with the network (a phone's Wi-Fi switched off mid-upload) may never report an error, and without this the loop would wait for it forever.

## Server side

The server dedupes by `clientId`. A bounded dictionary per user in memory, `clientId` to message id, entries expiring after a day. A repeated POST with a known `clientId` returns the existing message with 200. That is the whole idempotency story. The persistence copy of the dictionary follows the normal memory-first rule: the database is a copy, not the source.

## Reading

On connect, fetch the tail of the open conversation and the unread counts in one request. Live updates arrive as SignalR events, as before. On reconnect, fetch the tail again. Nothing to merge, no versions per record, no epoch, no digest, no reset.

History stays visible after a reload while offline. Each time the client fetches a conversation's tail, it stores that response under the conversation id. On an offline reload it paints that. One record per conversation, overwritten whole, never merged. On phones the browser kills the app often, so without this cache "readable with what it already has" would mean almost nothing.

The stored tail carries no pictures. For one day (2026-10-31) it held the emoji and pack images its rows draw, as data URLs by image URL, so that the stored paint drew the emoji in the same frame as the text. After that change every open jerked once the emoji had drawn. The probable cause: WebKit decodes a data URL image again for each `<img>` element that carries it, and the rows are rebuilt three times at every open (the bootstrap's users and emoji redraws, then the server's rows), so the emoji vanished and came back at each rebuild. An `<img>` carries the image's URL: the browser decodes it once per page and shares it, and the worker's cache answers it a frame or two after the text. The emoji boxes have fixed sizes, so a late picture moves nothing. The worker answers every emoji image, the picker's grid included, from one cache (`yap-emoji-v2`), and a repeated image from its own memory (docs/performance-notes.md, "Media").

## Tabs

Tabs do not merge each other's state. History comes from the server in every tab. The outbox is shared storage. A Web Lock makes one tab the sender:

```js
navigator.locks.request('yap-outbox-sender', () => runSenderUntilClosed());
```

Other tabs re-read the outbox when a BroadcastChannel message says it changed. A tab on an old build (the new-version notice shows) releases the lock and requests it again, at the notice and at every outbox change, so a tab on the new build moves ahead of it in the queue: an old sender does not know what a newer row carries (on 2026-10-18 it uploaded a voice recording as a plain file). That is the complete cross-tab design.

## After the tab was closed

The outbox is on disk. The next open tab sends. Where the browser has Background Sync, the service worker registers one sync tag and its handler reads the outbox and POSTs. That is optional and about thirty lines. The service worker is otherwise only for install and push, as before the rewrite.

## Failed and stale rows

A failed row shows Retry and Remove. Remove deletes the row and nothing else. No server call.

A row older than one day is marked `failed` when a tab opens. One comparison. The user removes it or retries it. This is the Discord behaviour and it is enough.

## What is not queued

Only new text messages are queued. Edits, deletes, reactions and uploads need a connection, and the UI says so when there is none. Queuing every operation is where the previous design grew its acceptance locks, its operation ids and its conflict rules. Not queuing them removes that whole class of code.

Attachments are in the offline promise. The case to serve: someone loses the connection in a tunnel with pictures already picked, presses Send, and the message goes out when the connection returns. The Blobs live in the outbox row. A row may hold at most 25 MB of attachments. Above that the client refuses to queue and the composer says "Needs a connection". The Blobs stay in the row until the message is sent. The upload state is a record of its own beside the row (key `upload:<clientId>` in the key-value store): for each file the tus upload URL, then the server's result or its refusal. It is not a field of the row, because IndexedDB writes a record whole, and a save after each file would write the Blobs again. After a reload or a crash, a file goes on from the offset that the server reports for its URL, and a finished file is not sent again. The server keeps nothing about an upload in memory: the id of an upload names its owner, and the result of a finished file is a small file that the client can read again, so a restart of the server and a lost answer cost nothing. Behind a reverse proxy a restart shows as a 502, 503 or 504 from the proxy, and behind Cloudflare as a 520 to 527 or a 530. The client takes these as no answer: the file waits with its URL, and it is not a refused file. One limit is accepted. The server expires an unfinished upload after one day, and the file then uploads again from zero. A restart in the middle of the server's work on a finished file has the same effect. A part that stays behind after "Cancel upload" (a file that was stopped and waited) also goes with the one-day expiry. Added machinery: one record, one sender step, one cap.

## What this design does not have

- No local replica of history, and so no per-record versions and no merge algorithm.
- No change tracker that numbers revisions, no digest, no overflow reset.
- No server epoch; a deploy changes nothing on the client.
- No retry policy; connectivity events are the retry.
- No operation queue; one row type, a new message.
- No second service worker and no feature probe.
- No locks on the server beyond the one ChatService already has.

## Size

The client side is a few hundred lines: the outbox store, the sender, the pending row, the lock. The server side is the dictionary and one POST handler. The previous implementation of the same promise was about 7,600 lines of client code.

## Decisions (2026-10-14)

- Attachments are in, with a 25 MB cap per queued message.
- A queued row older than one day is marked failed.
- The snapshot cache for reading after a reload is in.
