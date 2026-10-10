using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Yap.Data;
using Yap.Middleware;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class FollowupChecks
{
    public static async Task Run(IServiceProvider services, HttpClient http, string csrf, User user)
    {
        var users = services.GetRequiredService<UserService>();
        var original = (user.TimeZone, user.Locale, user.DateFormat);
        try
        {
            await users.UpdateLocaleAsync(user.Id, "Europe/Prague", "cs-CZ", "dmy-24h");
            var context = new DefaultHttpContext();
            context.Request.Headers.Cookie = "yap_auth=" + user.Token;
            var state = new UserStateService();
            await new AuthMiddleware(_ => Task.CompletedTask).InvokeAsync(context, users, state);
            Check(state.TimeZone == "Europe/Prague" && state.Locale == "cs-CZ" && state.DateFormat == "dmy-24h",
                "fresh Settings session loads timezone, locale and date format together");
            await users.UpdateLocaleAsync(user.Id, state.TimeZone, state.Locale, "ymd-12h");
            await using var db = services.GetService<IDbContextFactory<ChatDbContext>>() is { } factory ? await factory.CreateDbContextAsync() : null;
            var saved = db != null ? await db.Users.AsNoTracking().SingleAsync(u => u.Id == user.Id) : users.GetById(user.Id)!;
            Check(saved.Locale == "cs-CZ" && saved.TimeZone == "Europe/Prague" && saved.DateFormat == "ymd-12h",
                "Settings date save preserves the persisted locale and timezone");

            var channel = services.GetRequiredService<ChatService>().GetDMChannels(user.Username).First();
            foreach (var (locale, cycle, clock) in new[] { ("en-US", "h23", "24h"), ("cs-CZ", "h12", "12h") })
            {
                user.TimeZone = "UTC";
                user.Locale = user.DateFormat = null;
                using var request = new HttpRequestMessage(HttpMethod.Post, "/api/chat/preferences/detect")
                {
                    Content = JsonContent.Create(new { timeZone = "America/New_York", locale, hourCycle = cycle, path = "/chat", channelId = channel.Id })
                };
                request.Headers.Add("X-CSRF-TOKEN", csrf);
                using var response = await http.SendAsync(request);
                var update = await response.Content.ReadFromJsonAsync<JsonElement>();
                Check(response.IsSuccessStatusCode && user.TimeZone == "UTC" && user.DateFormat!.EndsWith(clock),
                    "browser hour cycle overrides locale guess and retains explicit UTC: " + cycle);
                Check(update.GetProperty("conversations").EnumerateArray().Any(c => c.GetProperty("id").GetGuid() == channel.Id
                    && c.GetProperty("window").ValueKind != JsonValueKind.Null), "detection keeps the channel-query window selected");
            }
        }
        finally { await users.UpdateLocaleAsync(user.Id, original.TimeZone, original.Locale, original.DateFormat); }

        var env = services.GetRequiredService<IWebHostEnvironment>();
        var shellPath = Path.Combine(env.WebRootPath, "chat-client", "index.html");
        Directory.CreateDirectory(Path.GetDirectoryName(shellPath)!);
        var previous = File.Exists(shellPath) ? await File.ReadAllTextAsync(shellPath) : null;
        try
        {
            // Exercise the actual HTTP route with unrelated edits to the html tag.
            await File.WriteAllTextAsync(shellPath, "<!doctype html><html class=\"fixture\" lang=\"en\" data-appearance><body>Chat</body></html>");
            var shell = await http.GetStringAsync("/lobby");
            Check(shell.Contains($"data-appearance-user=\"{user.Id}\"") && shell.Contains("class=\"fixture\""),
                "authenticated shell injects account appearance independently of html tag layout");
            await File.WriteAllTextAsync(shellPath, "<html lang=\"en\"><body>Missing placeholder</body></html>");
            Check((await http.GetAsync("/lobby")).StatusCode == HttpStatusCode.InternalServerError,
                "missing appearance placeholder fails loudly instead of serving a flashing shell");
        }
        finally
        {
            if (previous == null)
                File.Delete(shellPath);
            else
                await File.WriteAllTextAsync(shellPath, previous);
        }
        var changes = services.GetRequiredService<OfflineChangeSignal>();
        var received = 0;
        Action<OfflineChange> broken = _ => throw new InvalidOperationException("synthetic change listener failure");
        Action<OfflineChange> observer = _ => received++;
        changes.Changed += broken;
        changes.Changed += observer;
        try
        {
            changes.Touch(OfflineChangeKind.Preferences, user.Id);
            Check(received == 1, "throwing change subscriber cannot suppress subsequent listeners");
        }
        finally { changes.Changed -= broken; changes.Changed -= observer; }
    }

    private static void Check(bool condition, string label)
    {
        if (!condition)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
}
