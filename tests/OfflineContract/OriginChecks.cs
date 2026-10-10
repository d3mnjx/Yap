using Yap.Offline;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Yap.Models;
using Yap.Services;

static class OriginChecks
{
    public static async Task Run(IServiceProvider services, HttpClient client)
    {
        void Check(bool condition, string label)
        {
            if (!condition)
                throw new Exception(label);
            Console.WriteLine("PASS " + label);
        }

        var users = services.GetRequiredService<UserService>();
        var links = services.GetRequiredService<AccessLinkService>();
        var chat = services.GetRequiredService<ChatService>();
        var recipient = (await users.CreateUserAsync("originrecipient"))!;
        var attacker = (await users.CreateUserAsync("originattacker"))!;
        var admin = users.GetByUsername("adminfixture")!;
        var oldAccount = (await users.CreateUserAsync("originlegacy"))!;

        async Task Visit(User user, string path, string host, bool modern = false)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Add("Cookie", "yap_auth=" + user.Token);
            request.Headers.Host = host;
            request.Headers.Add("X-Forwarded-Host", "poison.example.test");
            request.Headers.Add("X-Forwarded-Proto", "https");
            if (modern)
                request.Headers.Add(ChatProtocol.Header, ChatProtocol.Version);
            using var response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
        }

        await Visit(recipient, "/api/chat/bootstrap?path=/lobby", "recipient.example.test:8443", modern: true);
        Check(recipient.LoginOrigin == "https://recipient.example.test:8443",
            "bootstrap records the authenticated recipient's scheme/Host before presence, ignoring forwarded Host");
        await Visit(attacker, "/api/chat/session", "attacker.example.test");
        Check(attacker.LoginOrigin == "https://attacker.example.test" && recipient.LoginOrigin == "https://recipient.example.test:8443",
            "another account's session cannot overwrite the recipient's origin");
        await Visit(attacker, "/api/chat/bootstrap?path=/lobby", "legacy-protocol.example.test");
        Check(attacker.LoginOrigin == "https://legacy-protocol.example.test",
            "bootstrap without a protocol header records its authenticated user's origin");
        users.RecordLoginOrigin(admin.Id, "https://admin.example.test/settings?ignored=true#ignored");
        Check(admin.LoginOrigin == "https://admin.example.test", "stored origins exclude paths, queries and fragments");
        Check(links.BuildUrl("fixture", "https://viewer.example.test:8443/settings/") == "https://viewer.example.test:8443/invite/fixture",
            "viewer circuit base URI builds copyable links without a path");
        Check(links.BuildUrl("fixture", "javascript:alert(1)", "https://user:secret@example.test") == "/invite/fixture",
            "non-HTTP and credential-bearing origins cannot become login-link destinations");

        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ChatSettings:Bot:Enabled"] = "true",
            ["ChatSettings:Bot:Username"] = "originbot"
        }).Build();
        var bot = new SystemBotService(users, chat, links, config,
            services.GetRequiredService<IWebHostEnvironment>(), NullLogger<SystemBotService>.Instance);
        await bot.InitializeAsync();
        var welcomeLink = (await links.CreateForUserAsync(recipient.Id, recipient.Id))!;
        var welcome = new TaskCompletionSource<ChatMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnMessage(ChatMessage message)
        {
            if (message.Content.Contains("personal login link:") && message.Content.Contains(welcomeLink.Code))
                welcome.TrySetResult(message);
        }
        chat.OnMessageReceived += OnMessage;
        try
        {
            await chat.AddUserAsync("origin-welcome-session", recipient.Id, recipient.Username);
            ((Microsoft.Extensions.Time.Testing.FakeTimeProvider)services.GetRequiredService<TimeProvider>()).Advance(services.GetRequiredService<PresenceOptions>().DisconnectGrace);
            // Exercise the real event handler and its one-minute delay, with an intervening hostile session.
            await Visit(attacker, "/api/chat/session", "attacker.example.test");
            Console.WriteLine("WAIT real delayed welcome DM (one minute)");
            var message = await welcome.Task.WaitAsync(TimeSpan.FromSeconds(75));
            Check(message.Content.Contains($"https://recipient.example.test:8443/invite/{welcomeLink.Code}")
                && !message.Content.Contains("attacker.example.test") && !message.Content.Contains("poison.example.test"),
                "delayed welcome DM uses its own recipient after another user's hostile request");
        }
        finally { chat.OnMessageReceived -= OnMessage; }

        var replacement = (await links.CreateForUserAsync(recipient.Id, admin.Id))!;
        await bot.NotifyLinkReplacedByAdminAsync(recipient, replacement);
        var botUser = users.GetByUsername("originbot")!;
        bool HasDm(User user, string url) => chat.GetMessages(chat.GetOrCreateDMChannel(
            botUser.Id, botUser.Username, user.Id, user.Username).Id).Any(m => m.Content.Contains(url));
        Check(HasDm(recipient, $"https://recipient.example.test:8443/invite/{replacement.Code}"),
            "replacement DM prefers target user's recorded origin over admin's");
        var oldLink = (await links.CreateForUserAsync(oldAccount.Id, admin.Id))!;
        await bot.NotifyLinkReplacedByAdminAsync(oldAccount, oldLink);
        Check(HasDm(oldAccount, $"https://admin.example.test/invite/{oldLink.Code}"),
            "replacement DM for an older account falls back to issuing admin's origin");
        var unknownAdmin = (await users.CreateUserAsync("originunknownadmin"))!;
        var relative = (await links.CreateForUserAsync(oldAccount.Id, unknownAdmin.Id))!;
        await bot.NotifyLinkReplacedByAdminAsync(oldAccount, relative);
        Check(HasDm(oldAccount, $"for you: /invite/{relative.Code}"),
            "replacement DM uses relative link when neither account has an origin");

        config["PublicOrigin"] = "https://configured.example.test:9443/";
        var configuredLinks = new AccessLinkService(services, NullLogger<AccessLinkService>.Instance, config);
        Check(configuredLinks.BuildUrl("fixture", recipient.LoginOrigin, admin.LoginOrigin) == "https://configured.example.test:9443/invite/fixture"
            && configuredLinks.BuildUrl("fixture", "https://viewer.example.test/settings") == "https://configured.example.test:9443/invite/fixture"
            && configuredLinks.BuildUrl("fixture") == "https://configured.example.test:9443/invite/fixture",
            "PublicOrigin overrides recipient, admin, viewer and absent origins");
        foreach (var invalid in new[] { "https://example.test/path", "https://example.test/?q=1", "https://example.test/#fragment", "https://user:secret@example.test", "javascript:bad", "/relative" })
        {
            config["PublicOrigin"] = invalid;
            try
            {
                _ = new AccessLinkService(services, NullLogger<AccessLinkService>.Instance, config);
                throw new Exception("Invalid PublicOrigin accepted: " + invalid);
            }
            catch (ArgumentException) { }
        }
        Console.WriteLine("PASS invalid configured PublicOrigin fails instead of silently choosing a request host");
    }
}
