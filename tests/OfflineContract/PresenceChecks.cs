using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Yap.Data;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class PresenceChecks
{
    static void Check(bool value, string label)
    {
        if (!value)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
    public static async Task Run(IServiceProvider services, HttpClient http, string csrf, User alice, User bob, User carol, Guid privateDm, Guid readOnlyRoom)
    {
        var chat = services.GetRequiredService<ChatService>();
        var clock = (Microsoft.Extensions.Time.Testing.FakeTimeProvider)services.GetRequiredService<TimeProvider>();
        var live = services.GetRequiredService<OfflineLiveService>();
        await live.Join("alice1", alice, live.Ticket(alice), UserStatus.Online, true, false, 0);
        await live.Join("alice2", alice, live.Ticket(alice), UserStatus.Invisible, false, true, 0);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online && chat.IsPageVisible(alice.Username), "another tab joins without overriding chosen status");
        await live.Report("alice1", alice, true, 301, null);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online, "active sibling prevents auto-away");
        await live.Report("alice2", alice, false, 301, null);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Away && chat.IsAutoAway(alice.Username), "all sessions idle for five minutes applies auto-away");
        await live.Report("alice1", alice, true, 0, null);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online, "activity restores automatic away");
        await live.SetStatus("alice1", alice, UserStatus.Away);
        await live.Report("alice1", alice, true, 0, null);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Away, "activity preserves manual Away");
        await live.SetStatus("alice1", alice, UserStatus.Invisible);
        await live.Report("alice1", alice, true, 0, null);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Invisible, "activity preserves manual Invisible");
        bool rejected = false;
        try
        {
            await live.Join("forged", bob, live.Ticket(alice), UserStatus.Online, true, false, 0);
        }
        catch { rejected = true; }
        Check(rejected && !chat.HasSession("chat:forged"), "live ticket is bound to actual account");
        rejected = false;
        try
        {
            await live.Report("alice1", bob, true, 0, null);
        }
        catch { rejected = true; }
        Check(rejected, "live session cannot be used by another account");
        await live.Report("alice1", alice, true, 0, privateDm);
        rejected = false;
        try
        {
            await live.Typing("alice1", alice, privateDm, true);
        }
        catch { rejected = true; }
        Check(rejected, "nonmember cannot publish or subscribe to DM typing");
        await live.Report("alice1", alice, true, 0, readOnlyRoom);
        rejected = false;
        try
        {
            await live.Typing("alice1", alice, readOnlyRoom, true);
        }
        catch { rejected = true; }
        Check(rejected, "read-only conversation rejects typing");
        var dm = await chat.OpenDirectMessageAsync(alice, carol.Username);
        await live.Report("alice1", alice, true, 0, dm.Id);
        await live.Report("alice2", alice, true, 0, dm.Id);
        await live.Typing("alice1", alice, dm.Id, true);
        await live.Typing("alice2", alice, dm.Id, true);
        await live.Typing("alice1", alice, dm.Id, false);
        Check(chat.GetTypingUsers(dm.Id).Contains(alice.Username), "one tab stopping preserves sibling typing");
        await live.Leave("alice1");
        Check(chat.GetActiveSessionsForUser(alice.Username).Count == 1 && chat.HasSession("chat:alice1"), "active-session list excludes disconnected recovery records without deleting them");
        Check(chat.GetTypingUsers(dm.Id).Contains(alice.Username) && chat.HasActiveSession(alice.Username), "one tab closing preserves sibling presence and typing");
        await live.Report("alice2", alice, false, 0, dm.Id);
        Check(!chat.GetTypingUsers(dm.Id).Contains(alice.Username) && !chat.IsPageVisible(alice.Username), "hidden last tab stops typing and no longer suppresses push");
        await live.Report("alice2", alice, true, 0, dm.Id);
        await live.Typing("alice2", alice, dm.Id, true);
        await Task.Delay(3100);
        Check(chat.GetTypingUsers(dm.Id).Count == 0, "typing expires without fresh input");
        await live.SetStatus("alice2", alice, UserStatus.Online);
        await live.Leave("alice2");
        Check(chat.GetActiveSessionsForUser(alice.Username).Count == 0, "fully disconnected account has no displayed active sessions");
        Check(chat.HasActiveSession(alice.Username) && !chat.IsPageVisible(alice.Username) && chat.GetUserStatus(alice.Username) == UserStatus.Online,
            "disconnect clears visibility immediately while preserving original grace");
        clock.Advance(TimeSpan.FromSeconds(31));
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Away && chat.IsAutoAway(alice.Username), "disconnected last session becomes auto-Away after original 30-second grace");
        await live.Join("alice3", alice, live.Ticket(alice), UserStatus.Online, true, false, 0);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online && !chat.HasSession("chat:alice2"), "reconnect restores auto-away and replaces retained sessions");
        await live.Leave("alice3");
        clock.Advance(services.GetRequiredService<PresenceOptions>().HubRetention);
        Check(!chat.HasActiveSession(alice.Username), "configured hub retention expires without ghost presence");

        var users = services.GetRequiredService<UserService>();
        var admin = users.GetAllUsers().First(u => u.IsAdmin);
        var room = (await chat.CreateRoomAsync(admin.Id, admin.Username, "presence-room-fixture"))!;
        await users.SetRoomNotificationModeAsync(bob.Id, NotificationMode.AllowAll);
        await live.Join("room-alice", alice, live.Ticket(alice), UserStatus.Online, true, false, 0);
        await chat.SendMessageAsync(room.Id, admin.Id, admin.Username, "room while live");
        Check(chat.GetUnreadCount(alice.Id, room.Id) == 1 && chat.GetUnreadCount(bob.Id, room.Id) == 1 && chat.GetUnreadCount(carol.Id, room.Id) == 0,
            "room unread includes live muted users and offline subscribers, excludes offline muted users");
        Check(chat.IsChannelMuted(alice.Id, room.Id) && !chat.IsChannelMuted(bob.Id, room.Id), "room mute policy is preserved");
        await live.Leave("room-alice");
        clock.Advance(services.GetRequiredService<PresenceOptions>().HubRetention);
        await chat.SendMessageAsync(room.Id, admin.Id, admin.Username, "room while offline");
        Check(chat.GetUnreadCount(alice.Id, room.Id) == 1 && chat.GetUnreadCount(bob.Id, room.Id) == 2, "disconnected muted room does not accumulate new unread");
        await users.SetRoomNotificationModeAsync(bob.Id, NotificationMode.MuteAll);

        await chat.SendTextAsync(carol, dm.Id, Guid.NewGuid(), "observed before disconnect");
        var seen = chat.GetReadCheckpoint(alice.Id, dm.Id).Received;
        await chat.SendTextAsync(carol, dm.Id, Guid.NewGuid(), "arrived while offline");
        await chat.MarkObservedReadAsync(alice.Id, dm.Id, seen);
        Check(chat.GetUnreadCount(alice.Id, dm.Id) == 1, "offline observed checkpoint preserves newer unseen arrival");
        await chat.MarkObservedReadAsync(alice.Id, dm.Id, seen);
        Check(chat.GetUnreadCount(alice.Id, dm.Id) == 1, "duplicate read is idempotent");
        var through = chat.GetReadCheckpoint(alice.Id, dm.Id).Received;
        await Task.WhenAll(chat.MarkObservedReadAsync(alice.Id, dm.Id, through), chat.SendTextAsync(carol, dm.Id, Guid.NewGuid(), "concurrent unseen arrival"));
        Check(chat.GetUnreadCount(alice.Id, dm.Id) == 1, "concurrent read and arrival cannot lose an unread increment");
        await chat.MarkObservedReadAsync(alice.Id, dm.Id, seen);
        Check(chat.GetUnreadCount(alice.Id, dm.Id) == 1, "out-of-order old read cannot regress checkpoint");
        await using var db = services.GetService<IDbContextFactory<ChatDbContext>>() is { } factory ? await factory.CreateDbContextAsync() : null;
        var latest = chat.GetReadCheckpoint(alice.Id, dm.Id).Received;
        if (db != null)
        {
            await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER reject_read BEFORE UPDATE ON ChannelReadStates BEGIN SELECT RAISE(ABORT, 'test read failure'); END;");
            rejected = false;
            try
            {
                await chat.MarkObservedReadAsync(alice.Id, dm.Id, latest);
            }
            catch { rejected = true; }
            Check(rejected && chat.GetUnreadCount(alice.Id, dm.Id) == 1, "failed read persistence is not acknowledged or applied in memory");
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER reject_read;");
        }
        await chat.MarkObservedReadAsync(alice.Id, dm.Id, latest);
        await chat.SendTextAsync(carol, dm.Id, Guid.NewGuid(), "unread across restart");
        async Task<HttpResponseMessage> Read(Guid id, long target, bool token = true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/chat/conversations/{id}/read") { Content = JsonContent.Create(new { through = target }) };
            if (token)
                request.Headers.Add("X-CSRF-TOKEN", csrf);
            return await http.SendAsync(request);
        }
        Check((await Read(dm.Id, latest, false)).StatusCode == HttpStatusCode.Forbidden, "read write requires antiforgery");
        Check((await Read(privateDm, 0)).StatusCode == HttpStatusCode.NotFound, "nonmember DM read denied");
        Check((await Read(dm.Id, long.MaxValue)).StatusCode == HttpStatusCode.BadRequest, "future read checkpoint rejected");
        Check((await Read(dm.Id, latest)).IsSuccessStatusCode && chat.GetUnreadCount(alice.Id, dm.Id) == 1, "HTTP read replay retains unseen arrival");
        var checkpoint = chat.GetReadCheckpoint(alice.Id, dm.Id);
        var persisted = db != null ? await db.ChannelReadStates.AsNoTracking().SingleAsync(s => s.UserId == alice.Id && s.ChannelId == dm.Id)
            : new ChannelReadState { ReceivedCount = checkpoint.Received, ReadThrough = checkpoint.ReadThrough, UnreadCount = checkpoint.Unread };
        Check(persisted.ReceivedCount - persisted.ReadThrough == 1 && persisted.UnreadCount == 1, "checkpoint and unread count persist together");
    }
}
