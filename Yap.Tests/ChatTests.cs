using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Data.Sqlite;
using Yap.Models.Chat;
using Yap.Models.Media;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Gifs;
using Yap.Services.Media;

namespace Yap.Tests;

/// <summary>The paths of docs/architecture/message-path.md and chat-hub.md, end to end through HTTP and the hub.</summary>
public class ChatTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public ChatTests(YapFactory app) => _app = app;

    [Fact(DisplayName = "AU-04, AU-06: the first account is the admin; the bootstrap answers both states")]
    public async Task Bootstrap_answers_both_states()
    {
        var anonymous = await _app.CreateClient().GetFromJsonAsync<JsonElement>("/api/bootstrap");
        Assert.False(anonymous.TryGetProperty("user", out _));
        Assert.True(anonymous.GetProperty("texts").TryGetProperty("loginHeadings", out _));

        var me = await _app.AdminAsync();
        var doc = await me.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap");
        Assert.Equal(me.Username, doc.GetProperty("user").GetProperty("username").GetString());
        Assert.True(doc.GetProperty("user").GetProperty("isAdmin").GetBoolean());
        Assert.True(doc.GetProperty("rooms").GetArrayLength() >= 1);
        Assert.Equal("online", doc.GetProperty("user").GetProperty("status").GetString());
    }

    [Fact(DisplayName = "IB-24, MR-69: a send returns the message, the room's readers receive it, a repeat returns the same message")]
    public async Task Send_reaches_the_open_room_and_is_idempotent()
    {
        var alice = await _app.SignInAsync("alice_send");
        var bob = await _app.SignInAsync("bob_send");
        var lobby = _app.Service<ChatService>().LobbyId;

        var bobHub = await bob.ConnectAsync();
        var received = new Expectation<MessageDto>();
        bobHub.On<MessageDto>("message", received.Set);
        await bobHub.InvokeAsync<Conversation>("OpenRoom", lobby);

        var clientId = Guid.NewGuid();
        var first = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId, text = "hello bob" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var sent = (await first.Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Equal("hello bob", sent.Text);
        Assert.Equal(clientId, sent.ClientId);

        var seen = await received.Within();
        Assert.Equal(sent.Id, seen.Id);
        Assert.Equal("alice_send", seen.Username);

        var repeat = await (await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId, text = "hello bob" })).Content.ReadFromJsonAsync<MessageDto>();
        Assert.Equal(sent.Id, repeat!.Id);

        var empty = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "   " });
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
        await bobHub.DisposeAsync();
    }

    [Fact(DisplayName = "IB-70, MR-76: a voice message is sent alone, from an upload of this server, and reaches the row with its bars")]
    public async Task Voice_message_is_sent_alone()
    {
        var alice = await _app.SignInAsync("alice_voice");
        var lobby = _app.Service<ChatService>().LobbyId;
        var voice = new { url = "/uploads/voice.m4a", durationMs = 4200, peaks = "0369cfilorux" };

        var withText = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "hi", voice });
        Assert.Equal(HttpStatusCode.BadRequest, withText.StatusCode);
        var remote = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), voice = voice with { url = "https://elsewhere.example/x.m4a" } });
        Assert.Equal(HttpStatusCode.BadRequest, remote.StatusCode);
        var malformed = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), voice = voice with { peaks = "<script>" } });
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);

        var sent = await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), voice });
        Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
        var dto = (await sent.Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Equal("", dto.Text);
        Assert.Equal("/uploads/voice.m4a", dto.Voice?.Src);
        Assert.Equal(4200, dto.Voice?.DurationMs);
        Assert.Equal("0369cfilorux", dto.Voice?.Peaks);

        // A reply quotes it in words (MR-32), and an edit is refused: there is no caption to change (MR-57).
        var reply = await (await alice.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "nice", replyToId = dto.Id })).Content.ReadFromJsonAsync<MessageDto>();
        Assert.True(reply!.ReplyTo!.Voice);
        Assert.Null(reply.ReplyTo.Text);
        Assert.NotNull(_app.Service<ChatService>().Edit(_app.Service<ChatService>().GetMessage(dto.Id)!.UserId, dto.Id, "a caption"));
    }

    [Fact(DisplayName = "AD-19: the media clean-up sees a voice message's file as in use, and as unused once the message is gone")]
    public async Task Media_cleanup_counts_voice_files()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            await using var app = new YapFactory { SqlitePath = db };
            var alice = await app.SignInAsync("alice_prune");
            var chat = app.Service<ChatService>();
            var log = app.Service<MediaUploadLogService>();
            var cleanup = app.Service<MediaCleanupService>();
            var aliceId = app.Service<Yap.Services.Accounts.UserService>().GetByUsername(alice.Username)!.Id;

            // The upload's log row, as the tus path writes it, and a message that carries the file.
            var stem = Guid.NewGuid();
            log.Log(aliceId, alice.Username, "voice.webm", $"{stem}.m4a", 1234, "voice", ".m4a");
            var sent = await alice.Http.PostAsJsonAsync($"/api/channels/{chat.LobbyId}/messages", new { clientId = Guid.NewGuid(), voice = new { url = $"/uploads/{stem}.m4a", durationMs = 3000, peaks = "0z" } });
            Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
            var message = (await sent.Content.ReadFromJsonAsync<MessageDto>())!;

            // The writer lands the rows a moment later: every check waits for it.
            static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> ok)
            {
                T last = await probe();
                for (var i = 0; i < 50 && !ok(last); i++) { await Task.Delay(100); last = await probe(); }
                return last;
            }
            var row = await Eventually(async () => (await log.GetUploadsAsync()).FirstOrDefault(r => r.StoredFileName == $"{stem}.m4a"), r => r is not null);
            Assert.NotNull(row);

            var (outcome, uses, _) = await cleanup.DeleteAsync(aliceId, row.Id, force: false);   // the Voice column answers the LIKE
            Assert.Equal(MediaCleanupService.DeleteOutcome.InUse, outcome);
            Assert.Equal(1, uses);
            var referenced = await Eventually(() => cleanup.UnreferencedAsync(scanDatabase: true), u => u.Files == 0 && u.Recent == 0);   // the scan reads the Voice column
            Assert.Equal(0, referenced.Recent);

            Assert.Null(chat.Delete(aliceId, message.Id));
            var orphaned = await Eventually(() => cleanup.UnreferencedAsync(scanDatabase: true), u => u.Recent == 1);
            Assert.Equal((0, 1), (orphaned.Files, orphaned.Recent));   // unused now, but inside the grace period
            var deleted = await Eventually(() => cleanup.DeleteAsync(aliceId, row.Id, force: false), r => r.Outcome == MediaCleanupService.DeleteOutcome.Deleted);
            Assert.Equal(MediaCleanupService.DeleteOutcome.Deleted, deleted.Outcome);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }

    [Fact(DisplayName = "AD-03: the startup load keeps the newest messages of each conversation, within the count and the days")]
    public async Task Startup_load_is_bounded_per_conversation()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            Guid lobby, dm;
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var boss = await app.AdminAsync();
                var alice = await app.SignInAsync("alice_load");
                var chat = app.Service<ChatService>();
                var bossId = app.Service<Yap.Services.Accounts.UserService>().GetByUsername(boss.Username)!.Id;
                lobby = chat.LobbyId;
                dm = chat.GetOrCreateDm(bossId, alice.Username)!.Id;
                foreach (var (channel, text) in new[] { (lobby, "m1"), (lobby, "m2"), (lobby, "m3"), (lobby, "m4"), (lobby, "m5"), (dm, "d1"), (dm, "d2") })
                {
                    var sent = await boss.Http.PostAsJsonAsync($"/api/channels/{channel}/messages", new { clientId = Guid.NewGuid(), text });
                    Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
                }
            }   // the stop drains the writer

            // m1, m2 and d1 are ten days old now, in the text form the writer stores
            await using (var connection = new SqliteConnection($"Data Source={db}"))
            {
                await connection.OpenAsync();
                await using var age = connection.CreateCommand();
                age.CommandText = "update Messages set Timestamp = $t where Content in ('m1', 'm2', 'd1')";
                age.Parameters.AddWithValue("$t", DateTime.UtcNow.AddDays(-10).ToString("yyyy-MM-dd HH:mm:ss.fffffff"));
                Assert.Equal(3, await age.ExecuteNonQueryAsync());
            }
            SqliteConnection.ClearAllPools();

            // The count bound cuts the lobby to m4 and m5; the day bound cuts the conversation to d2.
            await using (var app = new YapFactory { SqlitePath = db, Settings = { ["ChatSettings:Persistence:Load:MaxMessagesPerChannel"] = "2", ["ChatSettings:Persistence:Load:MaxDays"] = "5" } })
            {
                var chat = app.Service<ChatService>();
                var bossId = app.Service<Yap.Services.Accounts.UserService>().GetByUsername("boss")!.Id;
                var (lobbyTail, hasMore, _) = chat.Tail(lobby, 50, bossId);
                Assert.Equal(new[] { "m4", "m5" }, lobbyTail.Select(m => m.Content));
                Assert.False(hasMore);   // the history starts at the oldest loaded message
                var (dmTail, _, _) = chat.Tail(dm, 50, bossId);
                Assert.Equal(new[] { "d2" }, dmTail.Select(m => m.Content));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }

    [Fact(DisplayName = "TL-01, TL-05, TL-06: the tail is 50, older pages follow the cursor, the cutoff hides history from non-admins")]
    public async Task Tail_older_and_cutoff()
    {
        var admin = _app.Service<ChatService>();
        var owner = await _app.AdminAsync();   // only the admin creates rooms (AD-29)
        var ownerId = _app.Service<Yap.Services.Accounts.UserService>().GetByUsername(owner.Username)!.Id;
        var (room, error) = admin.CreateRoom(ownerId, "pages", null, ChannelPermission.Everyone, HistoryLimit.OneDay, sinceJoined: false);
        Assert.Null(error);
        admin.GenerateTestMessages(room!.Id, ownerId, owner.Username, 120, TimeSpan.FromDays(3));

        var hub = await owner.ConnectAsync();
        var tail = await hub.InvokeAsync<Conversation>("OpenRoom", room.Id);
        Assert.Equal(50, tail.Messages.Count);
        Assert.True(tail.HasMore);
        Assert.False(tail.Restricted);   // the admin sees everything

        var oldest = tail.Messages[0];
        var page = await hub.InvokeAsync<Page>("Older", room.Id, oldest.Timestamp, oldest.Id);
        Assert.Equal(50, page.Messages.Count);
        Assert.True(page.Messages[^1].Timestamp <= oldest.Timestamp);
        var last = await hub.InvokeAsync<Page>("Older", room.Id, page.Messages[0].Timestamp, page.Messages[0].Id);
        Assert.Equal(20, last.Messages.Count);
        Assert.False(last.HasMore);
        await hub.DisposeAsync();

        var reader = await _app.SignInAsync("reader_pages");
        var readerHub = await reader.ConnectAsync();
        var limited = await readerHub.InvokeAsync<Conversation>("OpenRoom", room.Id);
        Assert.True(limited.Restricted);
        Assert.All(limited.Messages, m => Assert.True(m.Timestamp >= DateTime.UtcNow.AddDays(-1).AddMinutes(-1)));
        await readerHub.DisposeAsync();
    }

    // A room of generated messages, and every message the hub gives this connection, oldest first: the tail and the older pages.
    private async Task<(Channel Room, List<MessageDto> All)> RoomWithMessages(HubConnection hub, string name, int count, TimeSpan span, HistoryLimit limit = HistoryLimit.Unlimited)
    {
        var chat = _app.Service<ChatService>();
        var owner = await _app.AdminAsync();
        var ownerId = _app.Service<Yap.Services.Accounts.UserService>().GetByUsername(owner.Username)!.Id;
        var (room, error) = chat.CreateRoom(ownerId, name, null, ChannelPermission.Everyone, limit, sinceJoined: false);
        Assert.Null(error);
        chat.GenerateTestMessages(room!.Id, ownerId, owner.Username, count, span);
        return (room, await Readable(hub, room.Id));
    }

    private static async Task<List<MessageDto>> Readable(HubConnection hub, Guid roomId)
    {
        var tail = await hub.InvokeAsync<Conversation>("OpenRoom", roomId);
        var all = tail.Messages.ToList();
        for (var more = tail.HasMore; more && all.Count > 0;)
        {
            var page = await hub.InvokeAsync<Page>("Older", roomId, all[0].Timestamp, all[0].Id);
            all.InsertRange(0, page.Messages);
            more = page.HasMore;
        }
        return all;
    }

    [Fact(DisplayName = "SH-49, TL-41: around returns 25 messages before the target and 24 after it")]
    public async Task Around_returns_the_target_in_the_middle()
    {
        var hub = await (await _app.AdminAsync()).ConnectAsync();
        var (room, all) = await RoomWithMessages(hub, "around_middle", 200, TimeSpan.FromHours(5));
        Assert.Equal(200, all.Count);

        var window = await hub.InvokeAsync<Window>("Around", room.Id, all[100].Id);
        Assert.Null(window.Error);
        Assert.Equal(50, window.Messages.Count);
        Assert.Equal(all[100].Id, window.Messages[25].Id);
        Assert.Equal(all.Skip(75).Take(50).Select(m => m.Id), window.Messages.Select(m => m.Id));
        Assert.True(window.HasMore);
        Assert.True(window.HasNewer);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SH-49, TL-41: near the oldest message the window has no more; near the newest it is a tail")]
    public async Task Around_near_the_ends()
    {
        var hub = await (await _app.AdminAsync()).ConnectAsync();
        var (room, all) = await RoomWithMessages(hub, "around_ends", 200, TimeSpan.FromHours(5));

        var early = await hub.InvokeAsync<Window>("Around", room.Id, all[3].Id);
        Assert.Equal(28, early.Messages.Count);   // 3 before, the target, 24 after
        Assert.Equal(all[3].Id, early.Messages[3].Id);
        Assert.False(early.HasMore);
        Assert.True(early.HasNewer);

        var late = await hub.InvokeAsync<Window>("Around", room.Id, all[190].Id);
        Assert.Equal(35, late.Messages.Count);    // 25 before, the target, the 9 newest
        Assert.Equal(all[^1].Id, late.Messages[^1].Id);
        Assert.True(late.HasMore);
        Assert.False(late.HasNewer);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SH-49, TL-05: around keeps to the reader's history cutoff")]
    public async Task Around_respects_the_cutoff()
    {
        var admin = await (await _app.AdminAsync()).ConnectAsync();
        var (room, all) = await RoomWithMessages(admin, "around_cutoff", 120, TimeSpan.FromDays(3), HistoryLimit.OneDay);
        await admin.DisposeAsync();

        var reader = await (await _app.SignInAsync("reader_around")).ConnectAsync();
        var visible = await Readable(reader, room.Id);
        Assert.True(visible.Count < all.Count);

        var hidden = await reader.InvokeAsync<Window>("Around", room.Id, all[0].Id);
        Assert.Equal("Message not found.", hidden.Error);
        Assert.Empty(hidden.Messages);

        var oldest = await reader.InvokeAsync<Window>("Around", room.Id, visible[0].Id);
        Assert.Null(oldest.Error);
        Assert.Equal(visible[0].Id, oldest.Messages[0].Id);   // nothing from behind the cutoff fills the 25 before
        Assert.False(oldest.HasMore);
        await reader.DisposeAsync();
    }

    [Fact(DisplayName = "SH-48, SH-49: an unknown id or one of another room is not found; a pin whose message is not in memory is too old to load")]
    public async Task Around_of_an_unknown_id()
    {
        var hub = await (await _app.AdminAsync()).ConnectAsync();
        var (room, _) = await RoomWithMessages(hub, "around_unknown", 10, TimeSpan.FromHours(1));
        var (_, elsewhere) = await RoomWithMessages(hub, "around_elsewhere", 10, TimeSpan.FromHours(1));

        var unknown = await hub.InvokeAsync<Window>("Around", room.Id, Guid.NewGuid());
        Assert.Equal("Message not found.", unknown.Error);
        var foreign = await hub.InvokeAsync<Window>("Around", room.Id, elsewhere[0].Id);
        Assert.Equal("Message not found.", foreign.Error);
        Assert.Empty(foreign.Messages);

        // A pin from before the startup load: the channel keeps it while the message stays in the database (SH-48).
        var gone = Guid.NewGuid();
        room.Pins = [new Pin(gone, "someone", "old news", DateTime.UtcNow.AddYears(-1), [], "someone", DateTime.UtcNow.AddYears(-1))];
        var old = await hub.InvokeAsync<Window>("Around", room.Id, gone);
        Assert.Equal("Too old to load", old.Error);
        Assert.Empty(old.Messages);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "TL-43: messageLinks names the conversation, the author and the time of a message the reader may read")]
    public async Task MessageLinks_of_a_room_message()
    {
        var hub = await (await _app.AdminAsync()).ConnectAsync();
        var (room, all) = await RoomWithMessages(hub, "links_room", 10, TimeSpan.FromHours(1));

        var link = Assert.Single(await hub.InvokeAsync<List<MessageLinkDto>>("MessageLinks", new[] { all[4].Id }));
        Assert.Equal(all[4].Id, link.Id);
        Assert.Equal(room.Id, link.ChannelId);
        Assert.Null(link.DmUser);
        Assert.Equal(all[4].Username, link.Username);
        Assert.Equal(all[4].Timestamp, link.Timestamp);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "TL-44, TL-05: an unknown id, a deleted message and a message behind the history limit have no entry; an admin reads behind the limit")]
    public async Task MessageLinks_are_silent_about_what_the_reader_may_not_read()
    {
        var boss = await _app.AdminAsync();
        var admin = await boss.ConnectAsync();
        var (room, all) = await RoomWithMessages(admin, "links_cutoff", 120, TimeSpan.FromDays(3), HistoryLimit.OneDay);
        var gone = (await (await boss.Http.PostAsJsonAsync($"/api/channels/{room.Id}/messages", new { clientId = Guid.NewGuid(), text = "soon deleted" })).Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Single(await admin.InvokeAsync<List<MessageLinkDto>>("MessageLinks", new[] { gone.Id }));   // it had an entry while it existed
        Assert.Null(await admin.InvokeAsync<HubError?>("Delete", gone.Id));

        var reader = await (await _app.SignInAsync("reader_links")).ConnectAsync();
        var asked = new[] { Guid.NewGuid(), gone.Id, all[0].Id, all[^1].Id };
        var forReader = await reader.InvokeAsync<List<MessageLinkDto>>("MessageLinks", asked);
        Assert.Equal([all[^1].Id], forReader.Select(l => l.Id));   // all[0] is behind the reader's one day
        var forAdmin = await admin.InvokeAsync<List<MessageLinkDto>>("MessageLinks", asked);
        Assert.Equal([all[0].Id, all[^1].Id], forAdmin.Select(l => l.Id));
        await reader.DisposeAsync();
        await admin.DisposeAsync();
    }

    [Fact(DisplayName = "TL-43, TL-44: a direct message has an entry for its two people, with the other person's name, and none for a third person")]
    public async Task MessageLinks_of_a_direct_message()
    {
        var erin = await _app.SignInAsync("erin_links");
        var frank = await _app.SignInAsync("frank_links");
        var grace = await _app.SignInAsync("grace_links");
        var dm = _app.Service<ChatService>().GetOrCreateDm(_app.Service<UserService>().GetByUsername("erin_links")!.Id, "frank_links")!;
        var sent = (await (await erin.Http.PostAsJsonAsync($"/api/channels/{dm.Id}/messages", new { clientId = Guid.NewGuid(), text = "between us" })).Content.ReadFromJsonAsync<MessageDto>())!;

        var erinHub = await erin.ConnectAsync();
        var frankHub = await frank.ConnectAsync();
        var graceHub = await grace.ConnectAsync();
        var forErin = Assert.Single(await erinHub.InvokeAsync<List<MessageLinkDto>>("MessageLinks", new[] { sent.Id }));
        Assert.Equal(dm.Id, forErin.ChannelId);
        Assert.Equal("frank_links", forErin.DmUser);
        var forFrank = Assert.Single(await frankHub.InvokeAsync<List<MessageLinkDto>>("MessageLinks", new[] { sent.Id }));
        Assert.Equal("erin_links", forFrank.DmUser);
        Assert.Empty(await graceHub.InvokeAsync<List<MessageLinkDto>>("MessageLinks", new[] { sent.Id }));
        await erinHub.DisposeAsync();
        await frankHub.DisposeAsync();
        await graceHub.DisposeAsync();
    }

    [Fact(DisplayName = "TL-43: messageLinks reads the first 50 ids of a call")]
    public async Task MessageLinks_reads_the_first_50_ids()
    {
        var hub = await (await _app.AdminAsync()).ConnectAsync();
        var (_, all) = await RoomWithMessages(hub, "links_cap", 60, TimeSpan.FromHours(1));

        var links = await hub.InvokeAsync<List<MessageLinkDto>>("MessageLinks", all.Select(m => m.Id).ToArray());
        Assert.Equal(all.Take(50).Select(m => m.Id), links.Select(l => l.Id));
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SH-42: the address of a message link answers with the app shell")]
    public async Task Message_link_address_answers_the_shell()
    {
        var response = await _app.CreateClient().GetAsync("/m/PyuMHppHTQuxxlLnqQ1PGA");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact(DisplayName = "NT-01, NT-03, NT-06: a direct message counts for the other person until they open it")]
    public async Task Unread_counts_and_mark_read()
    {
        var carol = await _app.SignInAsync("carol_unread");
        var dave = await _app.SignInAsync("dave_unread");
        var chat = _app.Service<ChatService>();
        var users = _app.Service<Yap.Services.Accounts.UserService>();
        var dm = chat.GetOrCreateDm(users.GetByUsername("carol_unread")!.Id, "dave_unread")!;

        var daveHub = await dave.ConnectAsync();
        var unread = new Expectation<(Guid, int)>();
        daveHub.On<Guid, int>("unread", (channelId, count) => { if (channelId == dm.Id && count == 1) unread.Set((channelId, count)); });

        var sent = await carol.Http.PostAsJsonAsync($"/api/channels/{dm.Id}/messages", new { clientId = Guid.NewGuid(), text = "psst" });
        Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
        await unread.Within();

        var doc = await dave.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap");
        Assert.Equal(1, doc.GetProperty("unread").GetProperty(dm.Id.ToString()).GetInt32());

        var cleared = new Expectation<int>();
        daveHub.On<Guid, int>("unread", (channelId, count) => { if (channelId == dm.Id && count == 0) cleared.Set(count); });
        await daveHub.InvokeAsync<Conversation>("OpenDm", "carol_unread");   // TL-03: opening marks read
        await cleared.Within();
        Assert.Equal(0, chat.UnreadCount(users.GetByUsername("dave_unread")!.Id, dm.Id));
        await daveHub.DisposeAsync();
    }

    [Fact(DisplayName = "NT-03, NT-07: a room message counts for a connected person elsewhere, not for one reading the room")]
    public async Task Room_message_skips_the_readers()
    {
        var fay = await _app.SignInAsync("fay_reader");
        var gil = await _app.SignInAsync("gil_elsewhere");
        var hal = await _app.SignInAsync("hal_sender");
        var chat = _app.Service<ChatService>();
        var users = _app.Service<Yap.Services.Accounts.UserService>();
        var lobby = chat.LobbyId;

        var fayHub = await fay.ConnectAsync();
        var gilHub = await gil.ConnectAsync();
        await fayHub.InvokeAsync<Conversation>("OpenRoom", lobby);   // fay is reading the lobby; gil has Yap open on nothing
        var fayCounted = new Expectation<int>();
        fayHub.On<Guid, int>("unread", (channelId, count) => { if (channelId == lobby && count > 0) fayCounted.Set(count); });
        var gilCounted = new Expectation<int>();
        gilHub.On<Guid, int>("unread", (channelId, count) => { if (channelId == lobby && count == 1) gilCounted.Set(count); });

        var sent = await hal.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "room" });
        Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
        await gilCounted.Within();

        Assert.Equal(0, chat.UnreadCount(users.GetByUsername("fay_reader")!.Id, lobby));
        Assert.False(fayCounted.Completed, "a reader got an unread count for the room they are looking at");
        await fayHub.DisposeAsync();
        await gilHub.DisposeAsync();
    }

    [Fact(DisplayName = "MR-40, MR-57: a reaction toggles and arrives; an edit of someone else's message is refused")]
    public async Task Reactions_and_edit_rules()
    {
        var erin = await _app.SignInAsync("erin_react");
        var frank = await _app.SignInAsync("frank_react");
        var lobby = _app.Service<ChatService>().LobbyId;
        var message = (await (await erin.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "react to me" })).Content.ReadFromJsonAsync<MessageDto>())!;

        var frankHub = await frank.ConnectAsync();
        await frankHub.InvokeAsync<Conversation>("OpenRoom", lobby);
        var reactions = new Expectation<IReadOnlyList<ReactionGroupDto>>();
        frankHub.On<Guid, IReadOnlyList<ReactionGroupDto>>("reactions", (id, groups) => { if (id == message.Id) reactions.Set(groups); });

        var ok = await frankHub.InvokeAsync<HubError?>("React", message.Id, "👍");
        Assert.Null(ok);
        var groups = await reactions.Within();
        Assert.Single(groups);
        Assert.Equal("👍", groups[0].Emoji);
        Assert.Equal(["frank_react"], groups[0].Users);

        var refused = await frankHub.InvokeAsync<HubError?>("Edit", message.Id, "mine now");
        Assert.NotNull(refused);
        await frankHub.DisposeAsync();
    }

    [Fact(DisplayName = "PK-07, PK-50: the emoji of a message go to the front of the recent emoji, the last one first, and the other device gets the list")]
    public async Task Emojis_of_a_message_go_to_recent()
    {
        var ana = await _app.SignInAsync("ana_recent");
        var other = await _app.SignInAsync("other_recent");
        var phone = await ana.ConnectAsync("phone");
        var laptop = await ana.ConnectAsync("laptop");
        var seen = new Expectation<JsonElement>();
        laptop.On<JsonElement>("me", partial => { if (partial.TryGetProperty("emoji", out var emoji)) seen.Set(emoji); });

        await phone.InvokeAsync("EmojisUsed", new[] { "🎉", "😀" });

        // The order of the text: the last emoji is the first cell, the same as two taps in the picker.
        Assert.Equal(["😀", "🎉"], Strings((await seen.Within()).GetProperty("recent")));
        Assert.Equal(["😀", "🎉"], await RecentOf(ana));
        Assert.Empty(await RecentOf(other));
        await phone.DisposeAsync();
        await laptop.DisposeAsync();
    }

    [Fact(DisplayName = "PK-07, PK-51: a list that arrives a second time changes nothing and sends no event; bad entries are ignored; the list holds 20")]
    public async Task A_repeated_emoji_list_is_harmless()
    {
        var ben = await _app.SignInAsync("ben_recent");
        var hub = await ben.ConnectAsync();
        var events = new List<List<string>>();
        var fire = new Expectation<bool>();
        hub.On<JsonElement>("me", partial =>
        {
            if (!partial.TryGetProperty("emoji", out var emoji)) return;
            var recent = Strings(emoji.GetProperty("recent"));
            lock (events) events.Add(recent);
            if (recent[0] == "🔥") fire.Set(true);
        });

        // The page sends its waiting list again after each connect until an answer came (PK-51), so a repeat must be
        // harmless. Events of one connection arrive in order: when the 🔥 event is here, an event of the repeat
        // would be here too.
        await hub.InvokeAsync("EmojisUsed", new[] { "🎉", "😀" });
        await hub.InvokeAsync("EmojisUsed", new[] { "🎉", "😀" });
        await hub.InvokeAsync("EmojisUsed", (string[]?)null);
        await hub.InvokeAsync("EmojisUsed", new[] { "", null, new string('x', 65) });
        await hub.InvokeAsync("EmojisUsed", new[] { "🔥" });
        await fire.Within();
        lock (events) Assert.Equal(2, events.Count);
        Assert.Equal(["🔥", "😀", "🎉"], await RecentOf(ben));

        await hub.InvokeAsync("EmojisUsed", Enumerable.Range(0, 30).Select(i => $"e{i}").ToArray());
        var kept = await RecentOf(ben);
        Assert.Equal(20, kept.Count);
        Assert.Equal("e29", kept[0]);   // the newest use is first: of 30 uses the last 20 stay, not the first 20
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "MR-41, MR-44, MR-82: a reaction sends the recent emoji and the quick reactions, each list only when it changed; an emoji of a message does not change the quick reactions")]
    public async Task A_reaction_sends_only_the_emoji_lists_that_changed()
    {
        var cleo = await _app.SignInAsync("cleo_recent");
        var first = await SendToLobby(cleo, "react to me");
        var second = await SendToLobby(cleo, "and to me");
        var hub = await cleo.ConnectAsync();
        var events = System.Threading.Channels.Channel.CreateUnbounded<JsonElement>();
        hub.On<JsonElement>("me", partial => { if (partial.TryGetProperty("emoji", out var emoji)) events.Writer.TryWrite(emoji); });
        async Task<JsonElement> Next() => await events.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        // The first 🔥 changes both lists. Each list has its own message with nothing else in it, and the two can
        // come in either order (bootstrap-and-events.md, rules).
        Assert.Null(await hub.InvokeAsync<HubError?>("React", first.Id, "🔥"));
        JsonElement[] both = [await Next(), await Next()];
        var recent = Assert.Single(both, e => e.TryGetProperty("recent", out _));
        var quick = Assert.Single(both, e => e.TryGetProperty("quickReactions", out _));
        Assert.False(recent.TryGetProperty("quickReactions", out _));
        Assert.False(quick.TryGetProperty("recent", out _));
        Assert.Equal("🔥", Strings(recent.GetProperty("recent"))[0]);
        // ❤️ and 😂 stay where they are; 🔥 takes the place of 👍. The first document of the page has the same three.
        Assert.Equal([Heart, "😂", "🔥"], Strings(quick.GetProperty("quickReactions")));
        Assert.Equal([Heart, "😂", "🔥"], Strings((await cleo.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap")).GetProperty("emoji").GetProperty("quickReactions")));

        // The reaction goes away. The recent list is the same and sends nothing. The quick reactions are the fixed
        // three again, and their message is the only one that tells the person's devices.
        Assert.Null(await hub.InvokeAsync<HubError?>("React", first.Id, "🔥"));
        var removed = await Next();
        Assert.False(removed.TryGetProperty("recent", out _));
        Assert.Equal([Heart, "😂", "👍"], Strings(removed.GetProperty("quickReactions")));

        // An emoji of a message goes to the recent list only.
        await hub.InvokeAsync("EmojisUsed", new[] { "🎉" });
        var typed = await Next();
        Assert.Equal(["🎉", "🔥"], Strings(typed.GetProperty("recent")));
        Assert.False(typed.TryGetProperty("quickReactions", out _));

        // 🔥 comes back: it is first in the recent list and one of the quick reactions. A second 🔥, on another
        // message, then changes neither list and sends nothing. Events of one connection arrive in order: when the 🚀 event is here, an event of the
        // second 🔥 would be here before it.
        Assert.Null(await hub.InvokeAsync<HubError?>("React", first.Id, "🔥"));
        await Next();
        await Next();
        Assert.Null(await hub.InvokeAsync<HubError?>("React", second.Id, "🔥"));
        await hub.InvokeAsync("EmojisUsed", new[] { "🚀" });
        var marker = await Next();
        Assert.Equal(["🚀", "🔥", "🎉"], Strings(marker.GetProperty("recent")));
        Assert.False(marker.TryGetProperty("quickReactions", out _));
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "MR-41, MR-83: a button keeps its place while the server runs; after a restart the quick reactions come from the reactions on the loaded messages, in the order of the messages, the highest weight first")]
    public async Task Quick_reactions_after_a_restart()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var rita = await app.SignInAsync("rita_quick");
                var chat = app.Service<ChatService>();
                var id = app.Service<UserService>().GetByUsername("rita_quick")!.Id;
                var older = await SendToLobby(rita, "the older message", chat.LobbyId);
                var newer = await SendToLobby(rita, "the newer message", chat.LobbyId);

                // The reaction on the newer message comes first, so 👀 is the newest reaction while the server runs.
                // Each new emoji takes the place of the one that leaves: 🚀 the place of 👍, then 👀 the place of 😂.
                Assert.Null(chat.ToggleReaction(id, "rita_quick", newer.Id, "🚀"));
                Assert.Null(chat.ToggleReaction(id, "rita_quick", older.Id, "👀"));
                Assert.Equal([Heart, "👀", "🚀"], chat.QuickReactions(id));
            }   // the stop drains the writer

            await using (var app = new YapFactory { SqlitePath = db })
            {
                // No bar shows at a start, so the order is the order of the weights. A stored reaction has no time
                // of its own: the start replays the reactions in the order of their messages, so 🚀 is the newest.
                var id = app.Service<UserService>().GetByUsername("rita_quick")!.Id;
                Assert.Equal(["🚀", "👀", Heart], app.Service<ChatService>().QuickReactions(id));
            }

            await using (var app = new YapFactory { SqlitePath = db, Settings = { ["ChatSettings:Persistence:Load:MaxMessagesPerChannel"] = "1" } })
            {
                // Only the newer message is loaded (AD-03). The reaction on the older one does not count.
                var id = app.Service<UserService>().GetByUsername("rita_quick")!.Id;
                Assert.Equal(["🚀", Heart, "😂"], app.Service<ChatService>().QuickReactions(id));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }

    [Fact(DisplayName = "AD-40, MR-41: a deleted account leaves the quick reactions")]
    public async Task A_deleted_account_leaves_the_quick_reactions()
    {
        var admin = await _app.AdminAsync();
        var gus = await _app.SignInAsync("gus_quick");
        var chat = _app.Service<ChatService>();
        var id = _app.Service<UserService>().GetByUsername("gus_quick")!.Id;
        var message = await SendToLobby(gus, "the last word of gus");
        Assert.Null(chat.ToggleReaction(id, "gus_quick", message.Id, "🔥"));
        Assert.Equal([Heart, "😂", "🔥"], chat.QuickReactions(id));

        Assert.Equal(HttpStatusCode.OK, (await admin.Http.PostAsJsonAsync("/api/admin/users/delete", new { usernames = new[] { "gus_quick" } })).StatusCode);

        Assert.Equal([Heart, "😂", "👍"], chat.QuickReactions(id));
    }

    [Fact(DisplayName = "MR-83: the replay at the start takes each person's newest 150 reactions from the newest messages of each conversation, in the order of time across the conversations")]
    public async Task The_replay_takes_the_newest_reactions_of_all_conversations()
    {
        await using var app = new YapFactory();   // its own lobby: the limit counts every message of a conversation
        var sam = await app.SignInAsync("sam_seed");
        await app.SignInAsync("tia_seed");
        var chat = app.Service<ChatService>();
        var users = app.Service<UserService>();
        var id = users.GetByUsername("sam_seed")!.Id;
        var lobby = $"/api/channels/{chat.LobbyId}/messages";
        async Task<Guid> Send(string url, string text) =>
            (await (await sam.Http.PostAsJsonAsync(url, new { clientId = Guid.NewGuid(), text })).Content.ReadFromJsonAsync<MessageDto>())!.Id;

        // Four messages in the order of time, in two conversations in turn. The reactions come in another order: a
        // reaction has no time of its own, so the replay follows the messages.
        var l1 = await Send(lobby, "the lobby, first");
        var d1 = await Send("/api/dm/tia_seed/messages", "the direct message, second");
        var l2 = await Send(lobby, "the lobby, third");
        var d2 = await Send("/api/dm/tia_seed/messages", "the direct message, fourth");
        foreach (var (message, emoji) in new[] { (d2, "d"), (l1, "a"), (l2, "c"), (d1, "b"), (d2, "e") })
            Assert.Null(chat.ToggleReaction(id, "sam_seed", message, emoji));

        Assert.Equal(["a", "b", "c", "d", "e"], chat.ReactionsForSeed()[id]);
        Assert.False(chat.ReactionsForSeed().ContainsKey(users.GetByUsername("tia_seed")!.Id));   // no reactions, no entry

        // The limit of messages is per conversation: the newest message of the lobby and the newest one of the
        // direct message. One limit for all conversations together gives only "d" and "e" here.
        Assert.Equal(["c", "d", "e"], chat.ReactionsForSeed(maxMessagesPerChannel: 1)[id]);
        // The limit per person keeps the person's newest reactions of all conversations, not the newest of each.
        Assert.Equal(["d", "e"], chat.ReactionsForSeed(maxReactionsPerUser: 2)[id]);
        Assert.Equal(["b", "c", "d", "e"], chat.ReactionsForSeed(maxReactionsPerUser: 4)[id]);

        // The limits that the server uses at its start: 200 reactions on two newer messages, and the newest 150 stay.
        var many = await Send(lobby, "many reactions");
        var more = await Send(lobby, "more reactions");
        for (var i = 0; i < 100; i++) Assert.Null(chat.ToggleReaction(id, "sam_seed", many, $"x{i}"));
        for (var i = 0; i < 100; i++) Assert.Null(chat.ToggleReaction(id, "sam_seed", more, $"y{i}"));
        Assert.Equal(
            Enumerable.Range(50, 50).Select(i => $"x{i}").Concat(Enumerable.Range(0, 100).Select(i => $"y{i}")).ToList(),
            chat.ReactionsForSeed()[id]);
    }

    // The heart as code points: it needs its variation selector to equal the server's default (MR-41).
    private const string Heart = "\u2764\uFE0F";

    private async Task<MessageDto> SendToLobby(SignedIn person, string text, Guid? lobby = null) =>
        (await (await person.Http.PostAsJsonAsync($"/api/channels/{lobby ?? _app.Service<ChatService>().LobbyId}/messages", new { clientId = Guid.NewGuid(), text })).Content.ReadFromJsonAsync<MessageDto>())!;

    private static List<string> Strings(JsonElement array) => array.EnumerateArray().Select(e => e.GetString()!).ToList();

    private static async Task<List<string>> RecentOf(SignedIn person) =>
        Strings((await person.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap")).GetProperty("emoji").GetProperty("recent"));

    [Fact(DisplayName = "GEN-04: a reply quotes an original of the same conversation only")]
    public async Task Reply_across_conversations_is_refused()
    {
        var alice = await _app.SignInAsync("alice_quote");
        var bob = await _app.SignInAsync("bob_quote");
        var eve = await _app.SignInAsync("eve_quote");
        var chat = _app.Service<ChatService>();
        var users = _app.Service<Yap.Services.Accounts.UserService>();
        var dm = chat.GetOrCreateDm(users.GetByUsername("alice_quote")!.Id, "bob_quote")!;
        var secret = (await (await alice.Http.PostAsJsonAsync($"/api/channels/{dm.Id}/messages", new { clientId = Guid.NewGuid(), text = "PRIVATE SENTINEL" })).Content.ReadFromJsonAsync<MessageDto>())!;

        // a third person knows the id: the lobby send is refused and the answer carries no text of the original
        var leak = await eve.Http.PostAsJsonAsync($"/api/channels/{chat.LobbyId}/messages", new { clientId = Guid.NewGuid(), text = "quote", replyToId = secret.Id });
        Assert.Equal(HttpStatusCode.BadRequest, leak.StatusCode);
        Assert.DoesNotContain("SENTINEL", await leak.Content.ReadAsStringAsync());

        // the same conversation: the quote carries the text
        var reply = await (await bob.Http.PostAsJsonAsync($"/api/channels/{dm.Id}/messages", new { clientId = Guid.NewGuid(), text = "re", replyToId = secret.Id })).Content.ReadFromJsonAsync<MessageDto>();
        Assert.Equal("PRIVATE SENTINEL", reply!.ReplyTo!.Text);

        // an original that is gone passes; the quote says so (MR-35)
        var gone = await (await bob.Http.PostAsJsonAsync($"/api/channels/{dm.Id}/messages", new { clientId = Guid.NewGuid(), text = "re2", replyToId = Guid.NewGuid() })).Content.ReadFromJsonAsync<MessageDto>();
        Assert.True(gone!.ReplyTo!.Unavailable);
    }

    [Fact(DisplayName = "PR-19: typing counts for the conversation the connection has open, and for no other")]
    public async Task Typing_needs_the_conversation_open()
    {
        var ann = await _app.SignInAsync("ann_typing");
        var ben = await _app.SignInAsync("ben_typing");
        var cid = await _app.SignInAsync("cid_typing");
        var chat = _app.Service<ChatService>();
        var users = _app.Service<Yap.Services.Accounts.UserService>();
        var dm = chat.GetOrCreateDm(users.GetByUsername("ann_typing")!.Id, "ben_typing")!;

        var benHub = await ben.ConnectAsync();
        await benHub.InvokeAsync<Conversation>("OpenDm", "ann_typing");
        var typists = new List<string>();
        var annTypes = new Expectation<string>();
        benHub.On<Guid, string, bool>("typing", (channelId, username, on) =>
        {
            if (channelId != dm.Id || !on) return;
            lock (typists) typists.Add(username);
            if (username == "ann_typing") annTypes.Set(username);
        });

        var cidHub = await cid.ConnectAsync();   // a third person with the lobby open and the direct message's id
        await cidHub.InvokeAsync<Conversation>("OpenRoom", chat.LobbyId);
        await cidHub.SendAsync("Typing", dm.Id, true);

        var annHub = await ann.ConnectAsync();   // the partner, typing after the intruder: events arrive in order
        await annHub.InvokeAsync<Conversation>("OpenDm", "ben_typing");
        await annHub.SendAsync("Typing", dm.Id, true);
        await annTypes.Within();
        lock (typists) Assert.Equal(["ann_typing"], typists);

        await benHub.DisposeAsync(); await cidHub.DisposeAsync(); await annHub.DisposeAsync();
    }

    [Fact(DisplayName = "SH-43, AD-33: the lobby is marked in the contract, whatever the sidebar order")]
    public async Task Lobby_is_marked_whatever_the_order()
    {
        var owner = await _app.AdminAsync();
        var chat = _app.Service<ChatService>();
        var ownerId = _app.Service<Yap.Services.Accounts.UserService>().GetByUsername(owner.Username)!.Id;
        var (room, error) = chat.CreateRoom(ownerId, "firstroom", null, ChannelPermission.Everyone, HistoryLimit.Unlimited, sinceJoined: false);
        Assert.Null(error);
        while (chat.Rooms()[0].Id != room!.Id) Assert.True(chat.MoveRoom(ownerId, room.Id, up: true));

        var rooms = (await owner.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap")).GetProperty("rooms").EnumerateArray().ToList();
        Assert.Equal("firstroom", rooms[0].GetProperty("name").GetString());
        var marked = Assert.Single(rooms, r => r.GetProperty("isLobby").GetBoolean());
        Assert.Equal(chat.LobbyId, marked.GetProperty("id").GetGuid());

        while (chat.Rooms()[^1].Id != room.Id) Assert.True(chat.MoveRoom(ownerId, room.Id, up: false));   // back to the bottom
    }

    [Fact(DisplayName = "OF-08: a direct message is addressed by its partner; the server finds or creates the channel")]
    public async Task Send_to_a_direct_message_by_partner()
    {
        var gina = await _app.SignInAsync("gina_dm");
        var hal = await _app.SignInAsync("hal_dm");
        var first = await gina.Http.PostAsJsonAsync("/api/dm/hal_dm/messages", new { clientId = Guid.NewGuid(), text = "hi hal" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var sent = (await first.Content.ReadFromJsonAsync<MessageDto>())!;

        var halHub = await hal.ConnectAsync();
        var opened = await halHub.InvokeAsync<Conversation>("OpenDm", "gina_dm");
        Assert.Equal(opened.ChannelId, sent.ChannelId);
        Assert.Contains(opened.Messages, m => m.Id == sent.Id);
        await halHub.DisposeAsync();

        var unknown = await gina.Http.PostAsJsonAsync("/api/dm/nobody_dm/messages", new { clientId = Guid.NewGuid(), text = "?" });
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact(DisplayName = "MR-77, MR-78, SH-48: in a direct message both people pin and unpin, six at most, the other side hears the change")]
    public async Task Dm_pins_both_ways_and_the_limit()
    {
        var alice = await _app.SignInAsync("alice_pin");
        var bob = await _app.SignInAsync("bob_pin");
        var aliceHub = await alice.ConnectAsync();
        var bobHub = await bob.ConnectAsync();
        var dm = (await aliceHub.InvokeAsync<Conversation>("OpenDm", "bob_pin")).ChannelId;
        await bobHub.InvokeAsync<Conversation>("OpenDm", "alice_pin");

        var sent = new List<MessageDto>();
        for (var i = 0; i < 7; i++)
            sent.Add((await (await alice.Http.PostAsJsonAsync("/api/dm/bob_pin/messages", new { clientId = Guid.NewGuid(), text = $"pin me {i}" })).Content.ReadFromJsonAsync<MessageDto>())!);

        var bobSees = new Expectation<IReadOnlyList<Pin>>();
        bobHub.On<Guid, IReadOnlyList<Pin>>("pins", (id, pins) => { if (id == dm) bobSees.Set(pins); });

        Assert.Null(await aliceHub.InvokeAsync<HubError?>("Pin", dm, sent[0].Id));
        var pins = await bobSees.Within();
        Assert.Equal([sent[0].Id], pins.Select(p => p.MessageId));
        Assert.Equal("alice_pin", pins[0].PinnedBy);
        Assert.Equal("pin me 0", pins[0].Text);

        Assert.Null(await bobHub.InvokeAsync<HubError?>("Pin", dm, sent[1].Id));   // the other side pins too
        for (var i = 2; i < 6; i++)
            Assert.Null(await aliceHub.InvokeAsync<HubError?>("Pin", dm, sent[i].Id));
        Assert.Equal("Up to 6 pinned messages. Unpin one first.", (await aliceHub.InvokeAsync<HubError?>("Pin", dm, sent[6].Id))?.Error);

        var reopened = await bobHub.InvokeAsync<Conversation>("OpenDm", "alice_pin");
        Assert.Equal([sent[5].Id, sent[4].Id, sent[3].Id, sent[2].Id, sent[1].Id, sent[0].Id], reopened.Pins.Select(p => p.MessageId));   // the newest pin first

        Assert.Null(await bobHub.InvokeAsync<HubError?>("Unpin", dm, sent[0].Id));   // the other side's pin
        Assert.Equal(5, _app.Service<ChatService>().PinsFor(dm, null).Count);
        await aliceHub.DisposeAsync();
        await bobHub.DisposeAsync();
    }

    [Fact(DisplayName = "MR-80, NT-02: a pin stores a system line in the conversation; it reaches the other person, counts for nobody and takes no edit, reaction, quote or pin")]
    public async Task A_pin_stores_a_system_line_that_counts_for_nobody()
    {
        var alice = await _app.SignInAsync("alice_pinline");
        var bob = await _app.SignInAsync("bob_pinline");
        var chat = _app.Service<ChatService>();
        var bobId = _app.Service<Yap.Services.Accounts.UserService>().GetByUsername("bob_pinline")!.Id;
        var aliceHub = await alice.ConnectAsync();
        var bobHub = await bob.ConnectAsync();   // connected, the conversation not open: a message counts for bob (NT-03)
        var dm = (await aliceHub.InvokeAsync<Conversation>("OpenDm", "bob_pinline")).ChannelId;

        var counted = new Expectation<int>();
        bobHub.On<Guid, int>("unread", (channelId, count) => { if (channelId == dm && count == 1) counted.Set(count); });
        var line = new Expectation<MessageDto>();
        bobHub.On<MessageDto>("message", m => { if (m.Kind == "pin") line.Set(m); });

        var sent = (await (await alice.Http.PostAsJsonAsync("/api/dm/bob_pinline/messages", new { clientId = Guid.NewGuid(), text = "pin me" })).Content.ReadFromJsonAsync<MessageDto>())!;
        await counted.Within();

        Assert.Null(await aliceHub.InvokeAsync<HubError?>("Pin", dm, sent.Id));
        var row = await line.Within();
        Assert.Equal("alice_pinline", row.Username);          // the pinner is the author
        Assert.Equal(sent.Id, row.ReplyTo?.Id);               // the line names the pinned message
        Assert.Equal("", row.Text);
        Assert.Equal(1, chat.UnreadCount(bobId, dm));         // the line did not count (NT-02)

        Assert.Equal("System lines do not accept reactions.", (await bobHub.InvokeAsync<HubError?>("React", row.Id, "👍"))?.Error);
        Assert.Equal("A system line cannot be edited.", (await aliceHub.InvokeAsync<HubError?>("Edit", row.Id, "x"))?.Error);
        Assert.Equal("A system line cannot be pinned.", (await aliceHub.InvokeAsync<HubError?>("Pin", dm, row.Id))?.Error);
        var quoted = await alice.Http.PostAsJsonAsync("/api/dm/bob_pinline/messages", new { clientId = Guid.NewGuid(), text = "re", replyToId = row.Id });
        Assert.Equal(HttpStatusCode.BadRequest, quoted.StatusCode);

        var opened = await bobHub.InvokeAsync<Conversation>("OpenDm", "alice_pinline");   // in the history, after the message
        Assert.Equal([sent.Id, row.Id], opened.Messages.Select(m => m.Id));
        Assert.Equal([null, "pin"], opened.Messages.Select(m => m.Kind));
        await aliceHub.DisposeAsync();
        await bobHub.DisposeAsync();
    }

    [Fact(DisplayName = "MR-77, AD-37, TL-05: in a room the admin always pins, the others follow the pin setting, a late joiner sees no pin from before their time")]
    public async Task Room_pin_permission_modes()
    {
        var boss = await _app.AdminAsync();
        var carol = await _app.SignInAsync("carol_pin");
        var dave = await _app.SignInAsync("dave_pin");
        // read as JSON: the server writes enums as camelCase strings, and this client has no converter for them
        var created = await (await boss.Http.PostAsJsonAsync("/api/rooms", new { name = "pins-room", description = (string?)null, adminOnly = false })).Content.ReadFromJsonAsync<JsonElement>();
        var room = created.GetProperty("id").GetGuid();
        Assert.Equal("adminOnly", created.GetProperty("pinPermission").GetString());   // the default of a new room
        var message = (await (await carol.Http.PostAsJsonAsync($"/api/channels/{room}/messages", new { clientId = Guid.NewGuid(), text = "worth pinning" })).Content.ReadFromJsonAsync<MessageDto>())!;

        var carolHub = await carol.ConnectAsync();
        var daveHub = await dave.ConnectAsync();
        var bossHub = await boss.ConnectAsync();
        await carolHub.InvokeAsync<Conversation>("OpenRoom", room);
        await daveHub.InvokeAsync<Conversation>("OpenRoom", room);
        await bossHub.InvokeAsync<Conversation>("OpenRoom", room);

        Assert.Equal("You cannot pin messages here.", (await carolHub.InvokeAsync<HubError?>("Pin", room, message.Id))?.Error);
        Assert.Null(await bossHub.InvokeAsync<HubError?>("Pin", room, message.Id));

        // The room keeps the defaults (one month, since joined): a person who joined after the message sees no pin of it.
        var eve = await _app.SignInAsync("eve_pin");
        var eveHub = await eve.ConnectAsync();
        Assert.Empty((await eveHub.InvokeAsync<Conversation>("OpenRoom", room)).Pins);
        Assert.Single((await bossHub.InvokeAsync<Conversation>("OpenRoom", room)).Pins);
        await eveHub.DisposeAsync();
        Assert.Null(await bossHub.InvokeAsync<HubError?>("Unpin", room, message.Id));

        var body = new Dictionary<string, object?> { ["name"] = "pins-room", ["description"] = null, ["adminOnly"] = false, ["pinPermission"] = "selected", ["pinners"] = new[] { "carol_pin" } };
        Assert.Equal(HttpStatusCode.NoContent, (await boss.Http.PatchAsJsonAsync($"/api/rooms/{room}", body)).StatusCode);
        Assert.Null(await carolHub.InvokeAsync<HubError?>("Pin", room, message.Id));
        Assert.Equal("You cannot unpin messages here.", (await daveHub.InvokeAsync<HubError?>("Unpin", room, message.Id))?.Error);

        body["pinners"] = new[] { "nobody_here" };
        Assert.Equal(HttpStatusCode.BadRequest, (await boss.Http.PatchAsJsonAsync($"/api/rooms/{room}", body)).StatusCode);   // an unknown name is refused, not dropped

        body["pinPermission"] = "everyone";
        body["pinners"] = Array.Empty<string>();
        Assert.Equal(HttpStatusCode.NoContent, (await boss.Http.PatchAsJsonAsync($"/api/rooms/{room}", body)).StatusCode);
        Assert.Null(await daveHub.InvokeAsync<HubError?>("Unpin", room, message.Id));
        Assert.Empty(_app.Service<ChatService>().PinsFor(room, null));
        await carolHub.DisposeAsync();
        await daveHub.DisposeAsync();
        await bossHub.DisposeAsync();
    }

    [Fact(DisplayName = "SH-48, AD-03: an edit changes the pinned text and a delete removes the pin; pins and the setting survive a restart, also for a message the startup load leaves in the database")]
    public async Task Pins_follow_the_message_and_survive_a_restart()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            Guid lobby, oldId;
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var boss = await app.AdminAsync();
                var chat = app.Service<ChatService>();
                lobby = chat.LobbyId;
                var hub = await boss.ConnectAsync();
                await hub.InvokeAsync<Conversation>("OpenRoom", lobby);

                var old = (await (await boss.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "old but pinned" })).Content.ReadFromJsonAsync<MessageDto>())!;
                var gone = (await (await boss.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "soon deleted" })).Content.ReadFromJsonAsync<MessageDto>())!;
                oldId = old.Id;
                Assert.Null(await hub.InvokeAsync<HubError?>("Pin", lobby, old.Id));
                Assert.Null(await hub.InvokeAsync<HubError?>("Pin", lobby, gone.Id));
                Assert.Null(await hub.InvokeAsync<HubError?>("Edit", old.Id, "old, edited, pinned"));
                Assert.Null(await hub.InvokeAsync<HubError?>("Delete", gone.Id));
                var pins = chat.PinsFor(lobby, null);
                Assert.Equal([old.Id], pins.Select(p => p.MessageId));   // the deleted message left the panel
                Assert.Equal("old, edited, pinned", pins[0].Text);       // the edit reached the copy

                var body = new { name = "lobby", description = (string?)null, adminOnly = false, pinPermission = "everyone" };
                Assert.Equal(HttpStatusCode.NoContent, (await boss.Http.PatchAsJsonAsync($"/api/rooms/{lobby}", body)).StatusCode);
                foreach (var text in new[] { "newer 1", "newer 2", "newer 3" })
                    Assert.Equal(HttpStatusCode.OK, (await boss.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text })).StatusCode);
                await hub.DisposeAsync();
            }   // the stop drains the writer

            // The count bound leaves the pinned message in the database; the pin still shows, with its copy of the text.
            await using (var app = new YapFactory { SqlitePath = db, Settings = { ["ChatSettings:Persistence:Load:MaxMessagesPerChannel"] = "2" } })
            {
                var chat = app.Service<ChatService>();
                Assert.Null(chat.GetMessage(oldId));
                Assert.Equal(PinPermission.Everyone, chat.GetRoom(lobby)!.PinPermission);
                var pins = chat.PinsFor(lobby, null);
                Assert.Equal([oldId], pins.Select(p => p.MessageId));
                Assert.Equal("old, edited, pinned", pins[0].Text);
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }

    [Fact(DisplayName = "SH-48, TL-24: a pinned picture carries the row's large and original files, and a pinned GIF stays a GIF")]
    public async Task Pin_media_carries_what_the_viewer_needs()
    {
        await using var app = new YapFactory();   // its own lobby: the shared one may hold three pins of other tests (MR-78)
        var boss = await app.AdminAsync();
        var chat = app.Service<ChatService>();
        var lobby = chat.LobbyId;
        var hub = await boss.ConnectAsync();
        await hub.InvokeAsync<Conversation>("OpenRoom", lobby);

        var album = (await (await boss.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), images = new[] { "/uploads/a.png", "/uploads/b.jpg" } })).Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Null(await hub.InvokeAsync<HubError?>("Pin", lobby, album.Id));
        var shots = chat.PinsFor(lobby, null).Single(p => p.MessageId == album.Id).Media;
        Assert.Equal(album.Images.Select(i => (i.Medium, i.Large, i.Original)), shots.Select(m => (m.Src!, m.Large!, m.Original!)));
        Assert.All(shots, m => Assert.Equal("image", m.Kind));

        Directory.CreateDirectory(app.Service<UploadPaths>().Gifs);
        var source = Path.Combine(app.ContentRoot, "pinned.gif");
        await File.WriteAllBytesAsync(source, Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
        var me = app.Service<UserService>().GetByUsername(boss.Username)!.Id;
        var accepted = (await app.Service<GifService>().TryAcceptAsGifAsync(source, ".gif", "image/gif", isExplicitGif: true, me, "pinned.gif"))!;
        var gif = (await (await boss.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), gifs = new[] { new { entryId = accepted.GifEntryId } } })).Content.ReadFromJsonAsync<MessageDto>())!;
        Assert.Null(await hub.InvokeAsync<HubError?>("Pin", lobby, gif.Id));
        var item = Assert.Single(chat.PinsFor(lobby, null).Single(p => p.MessageId == gif.Id).Media);
        Assert.Equal("gif", item.Kind);   // also when the file is a picture: the panel keeps every GIF out of the viewer (TL-22)
        Assert.Equal(gif.Gifs[0].IsImage, item.IsImage);
        await hub.DisposeAsync();
    }
}
