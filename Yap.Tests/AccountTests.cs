using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Data.Sqlite;
using Yap.Models.Accounts;

using Yap.Services.Accounts;
using Yap.Services.Presence;

namespace Yap.Tests;

/// <summary>Sign-out of other devices (AU-20) and the persistence writer's drain on shutdown.</summary>
public class AccountTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public AccountTests(YapFactory app) => _app = app;

    [Fact(DisplayName = "AU-20: sign out all other devices closes their connections and tells them")]
    public async Task Sign_out_others_closes_the_other_device()
    {
        var grace = await _app.SignInAsync("grace_devices");
        var phone = await grace.ConnectAsync("phone");
        var laptop = await grace.ConnectAsync("laptop");
        var told = new Expectation<bool>();
        phone.On("signedOut", () => told.Set(true));
        var closed = new Expectation<bool>();
        phone.Closed += _ => { closed.Set(true); return Task.CompletedTask; };

        var devices = await grace.Http.GetFromJsonAsync<JsonElement>("/api/account/devices?device=laptop");
        Assert.Equal(2, devices.GetProperty("devices").GetArrayLength());

        // the laptop connected a moment ago: in its first hour it cannot sign the others out (AU-20)
        var tooNew = await grace.Http.PostAsJsonAsync("/api/account/devices/sign-out-others", new { deviceId = "laptop" });
        Assert.Equal(HttpStatusCode.Forbidden, tooNew.StatusCode);
        var users = _app.Service<UserService>();
        users.RecordDevice(users.GetByUsername("grace_devices")!.Id, "laptop", DateTime.UtcNow - TimeSpan.FromHours(2));

        var response = await grace.Http.PostAsJsonAsync("/api/account/devices/sign-out-others", new { deviceId = "laptop" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("yap_auth=", response.Headers.GetValues("Set-Cookie").First());   // the caller keeps a session, with the new token

        await told.Within();
        await closed.Within();
        Assert.Equal(HubConnectionState.Connected, laptop.State);
        await laptop.DisposeAsync();
    }

    [Fact(DisplayName = "AU-20: the device list gives no device id, so a new device cannot name an older one")]
    public async Task The_device_list_gives_no_device_id()
    {
        var olga = await _app.SignInAsync("olga_devices");
        var desk = await olga.ConnectAsync("desk-7f3a91c2");
        var phone = await olga.ConnectAsync("phone-5d2e80b4");
        var users = _app.Service<UserService>();
        users.RecordDevice(users.GetByUsername("olga_devices")!.Id, "desk-7f3a91c2", DateTime.UtcNow - TimeSpan.FromHours(2));

        // What the phone, in its first hour, can read about the account's devices. The hub records a connection a
        // moment after ConnectAsync returns, so the list is asked for until both rows are there.
        var list = "";
        for (var i = 0; i < 50; i++)
        {
            list = await olga.Http.GetStringAsync("/api/account/devices?device=phone-5d2e80b4");
            if (JsonDocument.Parse(list).RootElement.GetProperty("devices").GetArrayLength() == 2) break;
            await Task.Delay(100);
        }
        Assert.Equal(2, JsonDocument.Parse(list).RootElement.GetProperty("devices").GetArrayLength());
        // The id of the desk is the proof of the desk's age. With it, the phone signed the desk out.
        Assert.DoesNotContain("desk-7f3a91c2", list);

        var withItsOwnId = await olga.Http.PostAsJsonAsync("/api/account/devices/sign-out-others", new { deviceId = "phone-5d2e80b4" });
        Assert.Equal(HttpStatusCode.Forbidden, withItsOwnId.StatusCode);
        await desk.DisposeAsync();
        await phone.DisposeAsync();
    }

    [Fact(DisplayName = "AU-20: the admin's Diagnostics give no device id, for an open session and for a closed one")]
    public async Task Diagnostics_give_no_device_id()
    {
        var admin = await _app.AdminAsync();
        var desk = await admin.ConnectAsync("desk-91c27f3a");

        // The id of the desk is the proof of the desk's age. A new device of the same admin account read it here and
        // signed the desk out with it. The hub records a connection a moment after ConnectAsync returns, and a close
        // a moment after the dispose, so each answer is asked for until the row is there.
        async Task<string> AnswerWithARowInAsync(string list, Action? first = null)
        {
            var answer = "";
            for (var i = 0; i < 50; i++)
            {
                first?.Invoke();
                answer = await admin.Http.GetStringAsync("/api/admin/diagnostics");
                if (JsonDocument.Parse(answer).RootElement.GetProperty(list).EnumerateArray().Any(s => s.GetProperty("username").GetString() == admin.Username)) return answer;
                await Task.Delay(100);
            }
            Assert.Fail($"no row of the admin in \"{list}\"");
            return answer;
        }

        Assert.DoesNotContain("desk-91c27f3a", await AnswerWithARowInAsync("sessions"));
        await desk.DisposeAsync();
        // A closed session stays in "sessions" for 30 s (a reload must show nothing, PR-14), and a sweep after that
        // moves it to "recentlyClosed". The sweep takes its clock as a parameter, so the test does not wait.
        var presence = _app.Service<PresenceService>();
        Assert.DoesNotContain("desk-91c27f3a", await AnswerWithARowInAsync("recentlyClosed", () => presence.Sweep(DateTime.UtcNow.AddSeconds(31))));
    }

    [Fact(DisplayName = "SH-33: a new account reaches the open clients as a profile message")]
    public async Task New_account_is_announced()
    {
        var watcher = await _app.SignInAsync("watcher_profile");
        var hub = await watcher.ConnectAsync();
        var seen = new Expectation<string>();
        hub.On<UserDto>("profile", u => { if (u.Username == "newcomer_profile") seen.Set(u.Username); });

        await _app.SignInAsync("newcomer_profile");
        Assert.Equal("newcomer_profile", await seen.Within());
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "AU-22: sign out clears this device's cookie only")]
    public async Task Sign_out_clears_the_cookie()
    {
        var heidi = await _app.SignInAsync("heidi_signout");
        var response = await heidi.Http.PostAsJsonAsync("/api/auth/signout", new { });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("yap_auth=;", response.Headers.GetValues("Set-Cookie").First());
    }

    [Fact(DisplayName = "The writer stores what memory has, and drains on shutdown")]
    public async Task Writer_drains_on_shutdown()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var ivan = await app.SignInAsync("ivan_persist");
                var lobby = app.Service<Yap.Services.Chat.ChatService>().LobbyId;
                var sent = await ivan.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), text = "stored" });
                Assert.Equal(HttpStatusCode.OK, sent.StatusCode);
            }   // disposing the factory stops the host, and StopAsync drains the queue

            await using var connection = new SqliteConnection($"Data Source={db}");
            await connection.OpenAsync();
            await using var users = connection.CreateCommand();
            users.CommandText = "select count(*) from Users where Username = 'ivan_persist'";
            Assert.Equal(1L, await users.ExecuteScalarAsync());
            await using var messages = connection.CreateCommand();
            messages.CommandText = "select count(*) from Messages where Content = 'stored'";
            Assert.Equal(1L, await messages.ExecuteScalarAsync());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }

    [Fact(DisplayName = "GEN-05, AU-22: a sign-out ends the hub connections of the same device; other devices stay")]
    public async Task Sign_out_closes_the_devices_connections()
    {
        var ines = await _app.SignInAsync("ines_signout");
        var tab = await ines.ConnectAsync("desk");
        var otherTab = await ines.ConnectAsync("desk");
        var phone = await ines.ConnectAsync("pocket");
        var closed = new Expectation<bool>();
        otherTab.Closed += _ => { closed.Set(true); return Task.CompletedTask; };

        var response = await ines.Http.PostAsJsonAsync("/api/auth/signout", new { deviceId = "desk" });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        await closed.Within();
        Assert.Equal(HubConnectionState.Connected, phone.State);
        await phone.DisposeAsync(); await tab.DisposeAsync(); await otherTab.DisposeAsync();
    }

    [Fact(DisplayName = "AU-22: a sign-out ends the installed app's automatic sign-in on this device")]
    public async Task Pwa_launch_after_sign_out_stays_signed_out()
    {
        await _app.AdminAsync();   // the admin slot is taken: kim is an ordinary account
        var options = new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, BaseAddress = YapFactory.BaseAddress };
        var device = _app.CreateClient(options);
        Assert.Equal(HttpStatusCode.OK, (await device.PostAsJsonAsync("/api/auth/signin", new { username = "kim_pwa" })).StatusCode);
        var start = (await device.GetFromJsonAsync<JsonElement>("/manifest.webmanifest")).GetProperty("start_url").GetString()!;
        Assert.StartsWith("/pwa-launch?lt=", start);

        Assert.Equal(HttpStatusCode.NoContent, (await device.PostAsJsonAsync("/api/auth/signout", new { })).StatusCode);
        var launch = await device.GetAsync(start);
        Assert.Equal(HttpStatusCode.Redirect, launch.StatusCode);
        Assert.False(launch.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(c => c.StartsWith("yap_auth=")));
        Assert.False((await device.GetFromJsonAsync<JsonElement>("/api/bootstrap")).TryGetProperty("user", out _));

        var fresh = _app.CreateClient(options);   // a jar that never signed out redeems the token: the first launch of an install
        var redeemed = await fresh.GetAsync(start);
        Assert.Equal(HttpStatusCode.Redirect, redeemed.StatusCode);
        Assert.Contains(redeemed.Headers.GetValues("Set-Cookie"), c => c.StartsWith("yap_auth="));
    }

    [Fact(DisplayName = "A send repeated across a restart finds its first copy: the stored row keeps the client id")]
    public async Task Retry_across_restart_is_not_a_duplicate()
    {
        var db = Path.Combine(Path.GetTempPath(), $"yap-test-{Guid.NewGuid():N}.db");
        try
        {
            var clientId = Guid.NewGuid();
            Guid firstId; string token;
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var jon = await app.SignInAsync("jon_retry");
                token = jon.Token;
                var lobby = app.Service<Yap.Services.Chat.ChatService>().LobbyId;
                var first = await jon.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId, text = "retry me" });
                Assert.Equal(HttpStatusCode.OK, first.StatusCode);
                firstId = (await first.Content.ReadFromJsonAsync<Yap.Models.Chat.MessageDto>())!.Id;
            }
            await using (var app = new YapFactory { SqlitePath = db })
            {
                var client = app.CreateClient();
                client.DefaultRequestHeaders.Add("Cookie", $"yap_auth={token}");
                var lobby = app.Service<Yap.Services.Chat.ChatService>().LobbyId;
                var again = await client.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId, text = "retry me" });
                Assert.Equal(HttpStatusCode.OK, again.StatusCode);
                Assert.Equal(firstId, (await again.Content.ReadFromJsonAsync<Yap.Models.Chat.MessageDto>())!.Id);
            }

            await using var connection = new SqliteConnection($"Data Source={db}");
            await connection.OpenAsync();
            await using var rows = connection.CreateCommand();
            rows.CommandText = "select count(*) from Messages where Content = 'retry me' and ClientId is not null";
            Assert.Equal(1L, await rows.ExecuteScalarAsync());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (var f in Directory.GetFiles(Path.GetDirectoryName(db)!, Path.GetFileName(db) + "*")) File.Delete(f);
        }
    }
}
