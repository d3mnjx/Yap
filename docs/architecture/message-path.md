# Message path

How one text message travels from the sender's tap to every screen. This is the most used path in Yap, so it sets the pattern for every other action. The [sketch](sketch.md) gives the principles, the [wire contract](wire-contract.md) the exact shapes.

## The path in one picture

<figure class="diagram">
<svg viewBox="0 0 860 560" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, Segoe UI, system-ui, sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/>
    </marker>
    <marker id="arr-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/>
    </marker>
  </defs>
  <style>
    .lane { stroke: var(--line-strong); stroke-dasharray: 4 4; }
    .head { fill: currentColor; font-weight: 600; font-size: 14px; text-anchor: middle; }
    .msg { stroke: var(--accent); stroke-width: 1.6; marker-end: url(#arr); fill: none; }
    .bg { stroke: var(--muted); stroke-width: 1.4; stroke-dasharray: 5 4; marker-end: url(#arr-muted); fill: none; }
    .lbl { fill: currentColor; text-anchor: middle; }
    .lbl tspan.mono { font-family: IBM Plex Mono, ui-monospace, monospace; font-size: 12px; }
    .note { fill: var(--surface-2); stroke: var(--line); rx: 4; }
    .note-t { fill: currentColor; font-size: 12px; }
    .step { fill: var(--accent); font-weight: 600; font-size: 12px; }
  </style>

  <text x="130" y="28" class="head">Client A (sender)</text>
  <text x="430" y="28" class="head">Server</text>
  <text x="730" y="28" class="head">Client B (reader)</text>
  <line x1="130" y1="40" x2="130" y2="540" class="lane"/>
  <line x1="430" y1="40" x2="430" y2="540" class="lane"/>
  <line x1="730" y1="40" x2="730" y2="540" class="lane"/>

  <!-- 1 local send -->
  <rect x="40" y="56" width="180" height="46" class="note"/>
  <text x="48" y="72" class="step">1</text>
  <text x="62" y="72" class="note-t">Tap Send. Outbox row written,</text>
  <text x="62" y="88" class="note-t">pending row painted, draft cleared.</text>

  <!-- 2 POST -->
  <path d="M130 130 H 424" class="msg"/>
  <text x="277" y="124" class="lbl"><tspan class="step">2 </tspan><tspan class="mono">POST /api/channels/{id}/messages</tspan></text>
  <text x="277" y="146" class="lbl"><tspan class="mono">{ clientId, text, replyToId }</tspan></text>

  <!-- 3 ChatService -->
  <rect x="340" y="166" width="180" height="62" class="note"/>
  <text x="348" y="182" class="step">3</text>
  <text x="362" y="182" class="note-t">ChatService.SendAsync</text>
  <text x="362" y="198" class="note-t">permission, dedupe by clientId,</text>
  <text x="362" y="214" class="note-t">append, unread deltas, stop typing.</text>

  <!-- 4 message events -->
  <path d="M436 262 H 724" class="msg"/>
  <path d="M424 262 H 136" class="msg"/>
  <text x="580" y="256" class="lbl"><tspan class="step">4 </tspan><tspan class="mono">message</tspan> (hub, room group or both DM users)</text>
  <text x="277" y="256" class="lbl"><tspan class="mono">message</tspan> with our clientId</text>

  <!-- 5 unread -->
  <path d="M436 300 H 724" class="msg"/>
  <text x="580" y="294" class="lbl"><tspan class="step">5 </tspan><tspan class="mono">unread</tspan> (channelId, count) to each affected user</text>
  <text x="277" y="294" class="lbl" fill="var(--muted)">nothing: own messages never count (NT-02)</text>

  <!-- 6 persist -->
  <rect x="340" y="318" width="180" height="46" class="note"/>
  <text x="348" y="334" class="step">6</text>
  <text x="362" y="334" class="note-t">Enqueue message and read states for the</text>
  <text x="362" y="350" class="note-t">one background writer. Nobody waits.</text>

  <!-- 7 response -->
  <path d="M424 396 H 136" class="msg"/>
  <text x="277" y="390" class="lbl"><tspan class="step">7 </tspan><tspan class="mono">200 Message</tspan> (in memory; the outbox row can go)</text>

  <!-- 8 A reconciles -->
  <rect x="40" y="414" width="180" height="62" class="note"/>
  <text x="48" y="430" class="step">8</text>
  <text x="62" y="430" class="note-t">Outbox row deleted on 200.</text>
  <text x="62" y="446" class="note-t">Pending row became the real row</text>
  <text x="62" y="462" class="note-t">at 4 or 7, whichever came first.</text>

  <!-- 9 B reads -->
  <rect x="640" y="318" width="180" height="62" class="note"/>
  <text x="648" y="334" class="step">9</text>
  <text x="662" y="334" class="note-t">Open room: row appended, view</text>
  <text x="662" y="350" class="note-t">follows or pill shows (TL-10, TL-16).</text>
  <text x="662" y="366" class="note-t">Other room: badge from 5 (NT-09).</text>
  <path d="M724 430 H 436" class="msg"/>
  <text x="580" y="424" class="lbl"><tspan class="step">10 </tspan><tspan class="mono">markRead</tspan> if visible, not away, at bottom (NT-07)</text>
  <path d="M436 462 H 724" class="msg"/>
  <text x="580" y="456" class="lbl"><tspan class="mono">unread</tspan> (channelId, 0) to all of B's devices</text>

  <!-- background -->
  <path d="M430 480 V 500" class="bg"/>
  <rect x="300" y="500" width="260" height="40" class="note"/>
  <text x="310" y="516" class="note-t">Background, after the response: link previews</text>
  <text x="310" y="532" class="note-t">(then a <tspan class="mono">previews</tspan> event), push to offline readers.</text>
</svg>
<figcaption>One HTTP request, one hub event per reader, one unread event per affected person. The reader makes no request to receive. The only reader request is the optional mark-read.</figcaption>
</figure>

## Step by step

### 1. The tap, on the sender's device

Send acts locally (GEN-01, IB-24). The composer builds the row, stores it, paints it and clears the draft, all before any network call. The outbox is the only write path, online or offline (design notes, "The outbox"). The row carries a `clientId` that the server uses to deduplicate, and the client uses to match the echo.

```js
// composer.js (sketch)
async function send(channelId, text, replyToId) {
  const row = { clientId: crypto.randomUUID(), channelId, text, replyToId,
                attachments: [], createdAt: Date.now(), state: 'queued' };
  timeline.addPending(row);          // faded full row at the end, view to bottom (IB-25, TL-14)
  composer.clear();                  // one line again, reply bar closed (IB-05, IB-27)
  await outbox.add(row);             // IndexedDB; survives reload and app close (OF-08)
  sender.wake();                     // the loop runs in the one tab that holds the Web Lock
}
```

### 2. The request

The sender loop takes the oldest queued row that is ready and posts it. Attachments upload beside the loop, at most three files at one time, and a row with attachments is ready when its last file is uploaded; a text message has none and is ready at once, so it does not wait for the uploads of a row before it (IB-28). The request is the same with or without an open hub connection, so there is one code path for online, offline and after a restart. A room is addressed by its id and a direct message by its partner (`POST /api/dm/{username}/messages`): a message queued offline for a person whose direct message was never opened on the device has no channel id (OF-08), and the server finds or creates the channel. On a network error the loop stops until a wake-up, and also on a 502, 503 or 504, the answer of a reverse proxy for a server that restarts: `online`, hub reconnected, tab visible, new row. On a 4xx the row is marked failed with the server's reason (GEN-02, MR-71).

```js
// sender.js (sketch)
async function sendOne(row) {
  const res = await api.post(`/api/channels/${row.channelId}/messages`,
                             { clientId: row.clientId, text: row.text, replyToId: row.replyToId });
  if (res.ok) { await outbox.remove(row.clientId); timeline.confirm(await res.json()); return 'sent'; }
  if (res.status >= 400 && res.status < 500) { await outbox.fail(row.clientId, await api.reason(res)); return 'failed'; }
  return 'stop';                      // network error or 5xx: wait for a wake-up
}
```

### 3. The server accepts

The endpoint is thin. It reads the user from the cookie principal, validates the body, and hands the work to ChatService. ChatService does, in this order and under the channel lock only for the append: the permission check (IB-62, 403 with the reason), the dedupe lookup (a repeat `clientId` returns the existing message, 200), the append, the unread deltas (NT-03: connected people and people with the room unmuted, minus the sender; the other person for a DM), and the typing clear through PresenceService (IB-59).

```cs
// Endpoints/MessagesEndpoints.cs (sketch)
group.MapPost("/api/channels/{channelId:guid}/messages",
    async (Guid channelId, SendMessageRequest body, ClaimsPrincipal user, ChatService chat) =>
{
    if (body.Text is { Length: > 4000 }) return Results.Problem("Message is too long.", statusCode: 400);
    var result = await chat.SendAsync(channelId, user.Id(), body);   // dedupes by (user, clientId)
    return result.Match(
        message => Results.Ok(MessageDto.From(message)),
        refusal => Results.Problem(refusal.Reason, statusCode: refusal.Status));
});
```

### 4 and 5. The events

ChatService raises `OnMessageReceived` and one `OnUnreadChanged` per affected person as soon as memory is updated. The broadcaster maps the message to its wire shape once and sends it to the room's group, or to both people of a direct message. Then it sends each person their new count.

```cs
// Endpoints/ChatHubBroadcaster.cs (sketch)
chat.OnMessageReceived += message =>
{
    var dto = MessageDto.From(message);
    _ = channel.IsDm
        ? hub.Clients.Users(channel.ParticipantIds).SendAsync("message", dto)
        : hub.Clients.Group($"channel:{message.ChannelId}").SendAsync("message", dto);
};
chat.OnUnreadChanged += (userId, channelId, count) =>
    _ = hub.Clients.User(userId.ToString()).SendAsync("unread", channelId, count);
```

### 6 and 7. The queued write, and the response

Yap has two places where a message exists. The first is ChatService's memory: the list per channel, in the one running server process. This is the source of truth. Every reader is served from it, every event comes from it, and the server runs without a database at all when persistence is off (AU-06, AD-03). The second is the SQLite database, when persistence is on. It is a copy of the memory, written after the memory changes, and read only once, at startup, to refill the memory. That read has bounds (`ChatSettings:Persistence:Load`): the newest `MaxMessagesPerChannel` messages of each conversation, none older than `MaxDays`. 0 means no bound, and absent keys mean no bound. Rows beyond the bounds stay in the database and are never in memory, so no reader sees them, the admin included, and the startup log counts them. A reply to such a message shows as unavailable (MR-35). The per-room history windows (TL-05) apply on top.

ChatService does not write that copy itself and does not wait for it. It enqueues the message on the one ordered persistence queue, marks the recipients' read states as changed, and returns at once. The endpoint answers 200 with the message. One background writer drains the queue, in order, one transaction per drain, and writes the changed read states after it, the latest state per person and channel, at most every two seconds: a room of a thousand changes the same thousand rows on every message, and writing each change was the first limit the 2026-10-18 load test hit. The request path never touches the database, so the response is as fast as the event, and every database concern lives in the writer.

So the event and the response mean the same thing: the message is in memory and everyone has it. The sender's client turns the pending row into a real row on the first of the two, and deletes its outbox row on the 200. A crash between the memory change and the drain loses that message. The design notes accept this. Today's code already swallows failed writes and returns success, so no guarantee that existed is lost. When persistence is off, the queue is a no-op.

### 8. The sender's screen

Client A receives the `message` event with its own `clientId`, usually before the 200. The pending row becomes the real row in place: no jump, no flicker, same position (MR-69). The send wait of AD-26 runs from step 1 to the own row rendered on the 200, and it goes out with the next heartbeat; `ApiLatencyFilter` times the server's part of the same send. When the 200 arrives, the outbox row is deleted. Both the event and the response carry the message, and both are handled by the same `timeline.confirm(message)`, which is idempotent on `clientId`. This order independence matters: when the hub is reconnecting, the event is lost but the response still arrives; when the request is slow, the event is faster.

The sender's other devices receive the message like any reader. They receive no `unread` for it (NT-02).

### 9 and 10. The reader's screen

Client B receives the `message` event only when it has that room open, or when it is one of the two people of a direct message. The timeline appends the row, groups it under the previous header when the rules allow (MR-01), and follows the bottom or shows the pill (TL-10, TL-16). For a room B has not open, B receives only `unread`, and the sidebar row, the mailbox, the tab title and the app badge all derive from that one event (NT-09 to NT-12).

When the page is visible, the person is not away and the view is at the bottom, B invokes `markRead` (NT-07). The server clears the count and sends `unread 0` to all of B's devices. Between the two events, another device of B shows the count for a moment. NT-07 says the message never shows a count on any device; the server cannot know "at the bottom", so this short flash is the accepted simplification.

### Background

After the response, the server queues link previews for a message without media (MR-19), and a `previews` event follows when a card is ready (MR-22). A card is kept in memory and in `Data/link-cards/`, so a page of history carries it whatever its age; a good card is never fetched again, and a link with no card is tried again after an hour. It also dispatches push notifications to people who are not online and visible (NT-25, NT-26). Neither is on the latency path.

## What is on the path

| Side | Part | Role |
| --- | --- | --- |
| client | `ui/composer.js` | builds the row, paints pending, clears the draft |
| client | `offline/outbox.js`, `sender.js` | the one write path and its loop |
| client | `api.js` | fetch, credentials, reason text |
| server | `Endpoints/MessagesEndpoints.cs` | validate, call, map the result |
| server | `Services/Chat/ChatService.cs` | permission, dedupe, append, unread, events, persist |
| server | `Services/Presence/PresenceService.cs` | who is connected (NT-03), stop typing |
| server | `Services/Persistence/PersistenceWriter.cs` | drains the ordered write queue to SQLite, off the request path |
| server | `Endpoints/ChatHubBroadcaster.cs` | events to groups and users |
| server | `Models/Chat/MessageDto.cs` | the one mapping to the wire shape, also used by `open` and `older` |
| client | `hub.js`, `store.js` | receive, apply |
| client | `ui/timeline.js`, `ui/message.js`, `ui/frame.js` | append, confirm, badge |

## Latency budget

For a reader on the other side of the globe, the message appears after half of A's round trip to the server, plus the server's work, plus half of B's round trip. The server's work is a dictionary lookup, a list append, a few counter updates, one enqueue and one JSON serialisation. The database is not on the path. For the sender, the message becomes real after one round trip. Nothing on this path waits for the disk, for a lock held during I/O, or for a second request.
