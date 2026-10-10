using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Hosting;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class MaintenanceChecks
{
    public static async Task Run(IServiceProvider services, HttpClient http, User user)
    {
        using var mismatch = new HttpRequestMessage(HttpMethod.Get, "/api/chat/bootstrap");
        mismatch.Headers.Add("X-Yap-Chat-Protocol", "1");
        Check((await http.SendAsync(mismatch)).StatusCode == HttpStatusCode.UpgradeRequired, "unsupported protocol is rejected with 426");
        Check((await http.GetAsync("/api/chat/sync")).StatusCode == HttpStatusCode.NotFound, "diagnostic sync route is retired");
        var config = services.GetRequiredService<IConfiguration>();
        var changes = new Dictionary<string, string>
        {
            ["MaxTextLength"] = "123",
            ["MaxOperationsPerBatch"] = "2",
            ["MaxPostBytes"] = "32768",
            ["MaxFilesPerMessage"] = "3",
            ["HistoryPageSize"] = "2",
            ["HistoryMaxMessages"] = "4",
            ["ReadBatch"] = "5",
            ["TypingTimeoutMs"] = "2000",
            ["AwayAfterMs"] = "15000",
            ["AllowedExtensions:0"] = ".png"
        };
        var original = changes.Keys.ToDictionary(key => key, key => config["OfflineChat:" + key]);
        try
        {
            foreach (var (key, value) in changes)
                config["OfflineChat:" + key] = value;
            var data = await http.GetFromJsonAsync<JsonElement>("/api/chat/bootstrap");
            var header = data.GetProperty("update").GetProperty("state");
            Check(header.GetProperty("maxTextLength").GetInt32() == 123 && header.GetProperty("maxOperationsPerBatch").GetInt32() == 2
                && header.GetProperty("maxBatchBytes").GetInt32() == 16384 && header.GetProperty("maxFilesPerMessage").GetInt32() == 3
                && header.GetProperty("historyPageSize").GetInt32() == 2 && header.GetProperty("historyMaxMessages").GetInt32() == 4
                && header.GetProperty("readBatch").GetInt32() == 5 && header.GetProperty("typingTimeoutMs").GetInt32() == 2000
                && header.GetProperty("awayAfterMs").GetInt32() == 15000 && header.GetProperty("allowedExtensions")[0].GetString() == ".png",
                "bootstrap limits follow server configuration and derive batch headroom");
            var chat = services.GetRequiredService<ChatService>();
            var lobby = chat.GetRooms().Single(c => c.IsDefault);
            try
            {
                await chat.SendTextAsync(user, lobby.Id, Guid.NewGuid(), new string('x', 124));
                throw new Exception("configured text limit was ignored");
            }
            catch (ChatSendException error) when (error.Code == "invalid_message") { Check(true, "server enforces the advertised text limit"); }
        }
        finally { foreach (var (key, value) in original) config["OfflineChat:" + key] = value; }

        var env = services.GetRequiredService<IWebHostEnvironment>();
        var directory = Path.Combine(env.WebRootPath, "chat-client");
        Directory.CreateDirectory(Path.Combine(directory, "emoji"));
        File.WriteAllText(Path.Combine(directory, "fixture.css"), "body {color:red}");
        File.WriteAllText(Path.Combine(directory, "emoji", "fixture.svg"), "<svg/>");
        File.WriteAllText(Path.Combine(directory, "fixture.css.br"), "transport variant");
        var first = new ChatShellManifest(env);
        File.AppendAllText(Path.Combine(directory, "fixture.css"), " ");
        var next = new ChatShellManifest(env);
        Check(first.Version != next.Version && first.Assets.Any(a => a.Url.EndsWith("fixture.css"))
            && first.Assets.All(a => !a.Url.EndsWith(".svg") && !a.Url.EndsWith(".br")),
            "shell inventory hashes content and excludes individual artwork and transport variants");
        Check(new ChatShellManifest(env).Version == next.Version, "unchanged shell inventory has deterministic version");
        File.WriteAllText(Path.Combine(env.WebRootPath, "icon.svg"), "<svg>default</svg>");
        var branding = Path.Combine(env.ContentRootPath, "Data", "branding");
        Directory.CreateDirectory(branding);
        File.WriteAllText(Path.Combine(branding, "icon.svg"), "<svg>branded</svg>");
        var branded = new ChatShellManifest(env);
        Check(branded.Assets.Single(a => a.Url == "/icon.svg").Hash == Convert.ToHexStringLower(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("<svg>branded</svg>"))),
            "shell hashes the served branding override rather than the built-in icon");
        var manifest = await http.GetAsync("/chat-client/manifest.json");
        Check(manifest.IsSuccessStatusCode && manifest.Headers.CacheControl?.NoStore == true, "shell manifest endpoint is no-store");
    }
    private static void Check(bool condition, string label)
    {
        if (!condition)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
}
