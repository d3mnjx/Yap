# ChatHub and read state

This page specifies the hub methods, the ChatService rule behind each method, and the read state. The [message path](message-path.md) specifies the send. The send uses HTTP. Every method on this page runs inside a connected session. The hub carries them (sketch, principle 3).

## The hub class

```cs
// Endpoints/ChatHub.cs (sketch)
[Authorize]
public sealed class ChatHub(ChatService chat, PresenceService presence, UserService users) : Hub
{
    // A Hub instance lives for one invocation. Per-connection state is the session in PresenceService
    // (the open conversation) and the SignalR group membership. This class stores nothing.
    Guid Me => Context.User!.Id();
    static string Group(Guid channelId) => $"channel:{channelId}";
    ...
}
```

A refusal is a normal result (GEN-02). A method that can refuse returns `HubError?`. The value `null` means success. The value `{ error: "text" }` means a refusal. The client shows the text at the place of the action. A thrown exception means a bug or an unknown target. The client then shows "Something went wrong", or goes to the lobby (SH-43).

```cs
public sealed record HubError(string Error);
```

## Open a conversation

`openRoom` and `openDm` make one round trip for a conversation switch. One call does four tasks: group membership, viewing, mark-read, and the tail. One call prevents a gap between the tail and the live events.

```cs
public async Task<Conversation> OpenRoom(Guid channelId)
{
    var channel = chat.GetRoom(channelId) ?? throw new HubException("Unknown room");   // the client goes to the lobby (SH-43)
    await Switch(channelId, joinGroup: true);
    return await Open(channel);
}

public async Task<Conversation> OpenDm(string username)
{
    var channel = chat.GetOrCreateDm(Me, username) ?? throw new HubException("Unknown user");
    await Switch(channel.Id, joinGroup: false);     // DM events go to the two users, not to a group
    return await Open(channel);
}

async Task Switch(Guid channelId, bool joinGroup)
{
    if (presence.Get(Context.ConnectionId)?.Viewing is { } previous)   // as built: the session object carries Viewing
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(previous));
    if (joinGroup) await Groups.AddToGroupAsync(Context.ConnectionId, Group(channelId));
    presence.SetViewing(Context.ConnectionId, channelId);
}

async Task<Conversation> Open(Channel channel)
{
    var viewer = users.ViewerOf(Me);                                   // id, isAdmin, createdAt: the input of the cutoff
    chat.MarkRead(Me, channel.Id, source: "open");                     // TL-03, NT-06
    var tail = chat.Tail(channel.Id, 50, viewer);                      // TL-01, TL-05
    return new Conversation(channel.Id, tail.Messages.Select(MessageDto.From), tail.HasMore, tail.Restricted,
                            presence.Typists(channel.Id, except: Me));   // read-only is derived on the client (IB-62)
}

public async Task Leave()                                              // before Settings or Admin
{
    if (presence.Get(Context.ConnectionId)?.Viewing is { } previous)   // as built: the session object carries Viewing
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(previous));
    presence.SetViewing(Context.ConnectionId, null);
}
```

An empty direct message is not in the sidebar (SH-29). `openDm` sends no event. The `dm` event goes to both persons when the channel receives its first message.

## Older messages

```cs
public Task<Page> Older(Guid channelId, DateTime beforeTimestamp, Guid beforeId)
    => Task.FromResult(chat.Older(channelId, beforeTimestamp, beforeId, 50, users.ViewerOf(Me)));
```

The cursor is the oldest loaded message. ChatService finds the message by id in the channel list. It returns the 50 messages before it. When the message is deleted, ChatService uses the timestamp instead. The id makes the cursor exact. The timestamp makes the cursor robust. Today's cursor is a timestamp only, and it can skip a message with an equal timestamp. `HasMore` is true when older messages exist above the cutoff of the viewer.

### The cutoff (TL-05)

A non-admin sees a room from the later of two moments: the start of the history window of the room, and the creation of the person's account when the "since joined" switch of the room is on. Admins have no cutoff. Direct messages have no cutoff. `Tail` and `Older` apply the cutoff. `Restricted` is true when the cutoff hides at least one message. The client then shows "Older messages are not available in this channel" (TL-09).

```cs
// Services/Chat/ChatService.cs (sketch)
static DateTime Cutoff(Channel channel, Viewer viewer)
{
    if (viewer.IsAdmin || channel.IsDm) return DateTime.MinValue;
    var window = channel.HistoryLimit.ToCutoff(DateTime.UtcNow);          // one day to three months, or MinValue
    var joined = channel.SinceJoined ? viewer.CreatedAt : DateTime.MinValue;
    return window > joined ? window : joined;
}
```

## Reactions, edits, deletes

```cs
public HubError? React(Guid messageId, string emoji) => chat.ToggleReaction(Me, MyName, messageId, emoji) is { } error ? new(error) : null;   // MR-40, MR-45

public HubError? Edit(Guid messageId, string text) => chat.Edit(Me, messageId, text);   // MR-57, MR-61
public HubError? Delete(Guid messageId) => chat.Delete(Me, messageId);                   // MR-64
public HubError? Pin(Guid channelId, Guid messageId) => chat.Pin(Me, MyName, channelId, messageId);       // MR-77
public HubError? Unpin(Guid channelId, Guid messageId) => chat.Unpin(Me, MyName, channelId, messageId);
public void EmojiUsed(string emoji) => users.RecordEmojiUse(Me, emoji);                  // IB-44
```

ChatService holds the rules. Each rule is one or two lines:

- A reaction toggles per person and per emoji. ChatService checks the emoji first: a string of 1 to 64 UTF-16 characters, with no allowlist. A system line refuses a reaction. Every person who can see the message can react. This includes a read-only room (MR-45). ChatService records the emoji use itself, for an added and for a removed reaction (MR-44, PK-07). The event carries the reactions of the message, grouped by emoji in first-use order, with usernames. The client resolves the display names for the tooltip (MR-38, MR-39).
- An edit is permitted on the author's own text rows only (MR-57). Unchanged, empty or blank text changes nothing. The method returns `null` and raises no event (MR-61). Otherwise ChatService replaces the text, sets `Edited`, queues the link previews again (MR-22), and raises `messageEdited`.
- A delete is permitted on the author's own rows only, media rows included (MR-64). ChatService removes the message from the list, decrements the GIF reference counts, and raises `messageDeleted`. Replies keep their rows. The client sets their quotes to "Original message unavailable" when it receives the event (MR-68). The server stores nothing about the deletion.
- A pin is permitted for both people of a direct message; in a room for the admin, or for whoever the room's `PinPermission` and `Pinners` allow (MR-77, AD-37). The channel row holds up to six pins, newest first, each a copy of the author, text, time and media (every picture, video and GIF, the voice note, or the first link card: `Pin`), so a pin outlives the startup load window. Every change assigns a new list, raises `pins` with the whole list, and writes the channel row. An edit of a pinned message updates the copy; a delete removes the pin (SH-48). In a restricted room the list is filtered per reader by the history cutoff (TL-05). A pin also appends a system line to the conversation (MR-80): a `ChatMessage` with `Kind = Pin`, the pinner as author, the pinned message as `ReplyToMessageId` and no content. It is stored and broadcast like a message (`AddSystemLine`), but it increments no unread count, sends no push and gets no link card. The client writes its text from the kind. An unpin writes nothing.
- Edits and deletes do not change unread counts (NT-02).

Each method changes memory, raises its event, and enqueues its write on the persistence writer. No method waits for the database.

## Read state

ChatService keeps one record per person and conversation in memory. The key is `(userId, channelId)`.

```cs
public sealed class ReadState { public int Unread; public DateTime LastReadAt; }
```

The count is raw. A mute does not stop the count (NT-04). The client decides what to show from the count and from its mutes map: a number for an unmuted conversation, a dot for a muted conversation, nothing for the open conversation (NT-09). The client computes the mailbox total and the app badge from the store (SH-09, NT-10, NT-11). The server computes a total only for the push payload, for a closed app.

### Increment on a send (NT-02, NT-03)

```cs
IEnumerable<Guid> UnreadRecipients(Channel channel, Guid sender)
{
    if (channel.IsDm) return channel.ParticipantIds.Where(id => id != sender);
    var connected = presence.ConnectedUserIds();                                // has Yap open on a device
    var unmuted = notifications.UsersWithRoomUnmuted(channel.Id);              // has this room unmuted
    var looking = presence.Looking(channel.Id);                                 // is reading this room now (NT-07)
    return connected.Union(unmuted).Where(id => id != sender && !looking.Contains(id));
}
```

`Looking` is the server's view of NT-07: a connected session on the room, visible with a heartbeat in the last 35 seconds (the away sweep's rule), input in the last five minutes, and the person not away. The scroll position is not known to the server; a person scrolled up gets the new-messages pill (TL-13) and no count. The set is built once per message, so a room of N members costs one pass over the sessions, not N.

An offline person with the room muted gets no count and no dot (the *Why* of NT-03). Generated test messages add no counts (AD-08). For each recipient, ChatService increments the count by one and raises `OnUnreadChanged(userId, channelId, count)`. The broadcaster sends `unread` to the devices of that person.

### Mark read (NT-06, NT-07, NT-08)

```cs
public void MarkRead(Guid userId, Guid channelId, string source)
{
    var state = _reads.GetOrAdd((userId, channelId), _ => new ReadState());
    int had;
    lock (state) { had = state.Unread; state.Unread = 0; state.LastReadAt = DateTime.UtcNow; }
    if (had == 0) return;                                                       // no change, no event
    OnUnreadChanged?.Invoke(userId, channelId, 0);
    audit.Read(userId, channelId, had, source, presence.StateOf(userId));      // AD-27, direct messages only
    writer.Enqueue((db, ct) => db.UpsertReadState(userId, channelId, 0, state.LastReadAt, ct));
}
```

Mark-read clears the whole conversation. There is no partial read (NT-08). The hub calls it on open (`source: "open"`). The hub also calls it when the client sends `markRead`. The client sends `markRead` only after an `unread` event gave the open conversation a count, and then when the page is visible, the person is not away, and the view is at the bottom (NT-07). A person the server took as reading gets no count and sends nothing, so a busy room costs no hub call per message per reader. The server trusts the client. The read state belongs to the person. `typing` is different: the hub forwards it only when `channelId` is the connection's open conversation, because a typing event reaches the people of that conversation (PR-19) and the id alone must not be an entry ticket.

The write is an upsert. Today the increment runs an UPDATE. The UPDATE does not create a missing row. The first unread of a person in a room is then lost on a restart (NT-05). The upsert corrects this. The writer batches, so one message to a room with fifty persons becomes one transaction.

### Other changes of read state

- A room deletion removes the read states of the room (AD-35).
- The bootstrap sends the counts of the person that are above zero.
- Quick reactions (MR-41) are the three emoji that the person used most in reactions. ChatService computes them from the reactions in memory at bootstrap and pads them with ❤️ 😂 👍.

## Locks in ChatService

Messages: one lock per channel around the list. The lock covers appends, edits, deletes, and the two reads that page the list. Read states: a `ConcurrentDictionary` with one lock per record. The lock covers the increment and the clear. No code inside a lock does I/O or raises an event. Events are raised after the lock. This is the same pattern as on the presence page.

## What the hub does not do

The hub does not send messages. The send is HTTP, for the outbox. The hub does not change settings. Settings use HTTP. The hub does not upload. Uploads use TUS. The hub does nothing for the admin pages. The hub is the live conversation only.

## Spec notes met here

- Today `GetMessages(count)` ignores the history cutoff. Some paths use it for the initial load. The new `Tail` applies the cutoff in every case (TL-05).
- Today an edit does not run the link previews again. MR-22 says an edit that adds or removes a link adds or removes the card.
