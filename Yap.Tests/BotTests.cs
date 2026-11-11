using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Presence;

namespace Yap.Tests;

/// <summary>The bot's return notice to the admin (PR-18, AD-09) and the JOIN row of the action log (AD-18).</summary>
public class BotTests(YapFactory app) : IClassFixture<YapFactory>
{
    private readonly YapFactory _app = app;

    /// <summary>Whether the bot's direct message with the admin holds a message with the fragment. With `wait`, polls for up to two seconds.</summary>
    private async Task<bool> BotToldAdminAsync(string fragment, bool wait = true)
    {
        var users = _app.Service<UserService>();
        var chat = _app.Service<ChatService>();
        var bot = _app.Service<SystemBotService>();
        var adminId = users.GetByUsername((await _app.AdminAsync()).Username)!.Id;
        for (var tries = 0; tries < (wait ? 20 : 1); tries++)
        {
            var told = chat.DmChannelsOf(adminId).Where(c => bot.IsBotUser(c.Participant1 ?? "") || bot.IsBotUser(c.Participant2 ?? ""))
                .Any(c => chat.Tail(c.Id, 50, adminId).Messages.Any(m => m.Content.Contains(fragment)));
            if (told) return true;
            await Task.Delay(100);
        }
        return false;
    }

    /// <summary>An account from before, away since `away` ago: older than the first-join window, with the end of its last visit stamped.</summary>
    private async Task<SignedIn> ReturningAsync(string username, TimeSpan away)
    {
        var signedIn = await _app.SignInAsync(username);
        var user = _app.Service<UserService>().GetByUsername(username)!;
        user.CreatedAt = DateTime.UtcNow.AddMinutes(-10);
        user.LastSeenAt = DateTime.UtcNow - away;
        return signedIn;
    }

    /// <summary>Connects. ConnectAsync returns after the server's OnConnectedAsync, and the bot decides on the return
    /// notice inside that method. Do not wait for the session count in its place: the session is there a moment
    /// before the bot decides, and a test that changed StartedAt in that moment got the wrong notice.</summary>
    private static async Task<Microsoft.AspNetCore.SignalR.Client.HubConnection> JoinAsync(YapFactory app, SignedIn person, int sessions = 1)
    {
        var hub = await person.ConnectAsync();
        var id = app.Service<UserService>().GetByUsername(person.Username)!.Id;
        Assert.Equal(sessions, app.Service<PresenceService>().SessionsOf(id).Count);
        return hub;
    }

    [Fact(DisplayName = "PR-18: the admin hears of a return after the threshold; not of a short absence, not when off, not in the startup quiet")]
    public async Task Return_notice()
    {
        var bot = _app.Service<SystemBotService>();
        await _app.AdminAsync();
        bot.StartedAt = DateTime.UtcNow.AddMinutes(-10);   // past the startup quiet
        await bot.UpdateSettingsAsync(null, null, null, 2);

        await using var brief = await JoinAsync(_app, await ReturningAsync("pr18_brief", TimeSpan.FromHours(1)));
        await using var back = await JoinAsync(_app, await ReturningAsync("pr18_back", TimeSpan.FromHours(3)));
        Assert.True(await BotToldAdminAsync("pr18_back is back after 3 hours."), "the bot did not tell the admin of the return");
        Assert.False(await BotToldAdminAsync("pr18_brief is back", wait: false));

        await bot.UpdateSettingsAsync(null, null, null, 0);
        await using var off = await JoinAsync(_app, await ReturningAsync("pr18_off", TimeSpan.FromDays(3)));
        await bot.UpdateSettingsAsync(null, null, null, 2);

        bot.StartedAt = DateTime.UtcNow;   // as right after a restart
        await using var early = await JoinAsync(_app, await ReturningAsync("pr18_early", TimeSpan.FromDays(3)));
        bot.StartedAt = DateTime.UtcNow.AddMinutes(-10);

        await using var later = await JoinAsync(_app, await ReturningAsync("pr18_later", TimeSpan.FromDays(3)));
        Assert.True(await BotToldAdminAsync("pr18_later is back after 3 days."));
        Assert.False(await BotToldAdminAsync("pr18_off is back", wait: false));
        Assert.False(await BotToldAdminAsync("pr18_early is back", wait: false));
    }

    [Fact(DisplayName = "PR-18: the absence reads as whole hours, or whole days from two days on")]
    public void Absence_text()
    {
        Assert.Equal("1 hour", SystemBotService.Describe(TimeSpan.FromMinutes(90)));
        Assert.Equal("3 hours", SystemBotService.Describe(TimeSpan.FromHours(3.9)));
        Assert.Equal("47 hours", SystemBotService.Describe(TimeSpan.FromHours(47)));
        Assert.Equal("2 days", SystemBotService.Describe(TimeSpan.FromHours(48)));
        Assert.Equal("12 days", SystemBotService.Describe(TimeSpan.FromDays(12.5)));
    }

    [Fact(DisplayName = "AD-09: the admin sets the return notice hours; a value out of range is refused")]
    public async Task Return_hours_setting()
    {
        var admin = await _app.AdminAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Http.PutAsJsonAsync("/api/admin/bot", new { returnAfterHours = 5 })).StatusCode);
        Assert.Equal(5, (await admin.Http.GetFromJsonAsync<JsonElement>("/api/admin/bot")).GetProperty("returnAfterHours").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.Http.PutAsJsonAsync("/api/admin/bot", new { returnAfterHours = -1 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.Http.PutAsJsonAsync("/api/admin/bot", new { returnAfterHours = 721 })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.Http.PutAsJsonAsync("/api/admin/bot", new { returnAfterHours = 2 })).StatusCode);   // the default again, for the other tests
    }

    [Fact(DisplayName = "AD-18: a join writes one JOIN row with the device; a second tab writes none")]
    public async Task Join_row()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            Guid id;
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var ana = await app.SignInAsync("ana_join");
                id = app.Service<UserService>().GetByUsername("ana_join")!.Id;
                await using var tab1 = await JoinAsync(app, ana);
                await using var tab2 = await JoinAsync(app, ana, sessions: 2);
            }   // disposing the factory stops the host, and StopAsync drains the writer's queue

            await using var connection = new SqliteConnection($"Data Source={db}");
            await connection.OpenAsync();
            await using var rows = connection.CreateCommand();
            rows.CommandText = "select count(*) from UserActionLogs where Action = 'JOIN' and UserUid = $uid";
            rows.Parameters.AddWithValue("$uid", id.ToString());
            Assert.Equal(1L, await rows.ExecuteScalarAsync());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }
}
