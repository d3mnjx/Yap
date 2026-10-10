using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Yap.Data;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Yap.Models;
using Yap.Offline;
using Yap.Services;
using Yap.Services.Gifs;

// Real application services/database; a separate temporary content root, never developer/reference data.
var root = Path.Combine(Path.GetTempPath(), "yap-offline-contract-" + Guid.NewGuid());
Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
Directory.CreateDirectory(Path.Combine(root, "Data"));
var config = new Dictionary<string, string?>
{
    ["ChatSettings:Persistence:Enabled"] = "true",
    ["ChatSettings:Persistence:ConnectionStrings:SQLite"] = "Data Source=" + Path.Combine(root, "Data", "yap.db"),
    ["ChatSettings:Bot:Enabled"] = "false",
    ["Vapid:PublicKey"] = "",
    ["Vapid:PrivateKey"] = "",
    ["OfflineChat:RecentMessageLimit"] = "3",
    ["ChatSettings:GifSettings:Klipy:ApiKey"] = "synthetic-paging-fixture"
};
File.WriteAllText(Path.Combine(root, "appsettings.json"), JsonSerializer.Serialize(config));
File.WriteAllText(Path.Combine(root, "Data", "appsettings.json"), JsonSerializer.Serialize(config));
void Check(bool condition, string label) { if (!condition) throw new Exception(label); Console.WriteLine("PASS " + label); }
WebApplicationFactory<OfflineHub> Factory() => new WebApplicationFactory<OfflineHub>().WithWebHostBuilder(builder =>
{
    builder.UseContentRoot(root).UseWebRoot(Path.Combine(root, "wwwroot"));
    builder.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(config));
    builder.ConfigureLogging(l => l.ClearProviders());
    builder.ConfigureServices(s =>
    {
        s.AddSingleton<TimeProvider>(new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.UtcNow));
        s.AddHttpClient("Klipy").ConfigurePrimaryHttpMessageHandler(() => new GifPagingChecks.Handler());
    });
});
Guid dmId, deletedId, editedId;
string token;
var durableOperation = Guid.NewGuid();
Guid durableMessage = Guid.Empty;
try
{
    using (var factory = Factory())
    {
        using var http = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false,
            HandleCookies = false
        });
        Check(!typeof(OfflineHub).Assembly.GetManifestResourceNames().Any(name => name.EndsWith(".razor.css")),
            "chat styles have no embedded Razor component dependency");
        Check(typeof(OfflineHub).Assembly.GetType("Yap.Components.Pages.RoomChat") == null
            && typeof(OfflineHub).Assembly.GetType("Yap.Components.Pages.DmChat") == null,
            "retired Blazor chat pages are absent from the application");
        // Route removal must apply to the endpoint table as well as auth classification.
        var endpoints = factory.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>()
            .Endpoints.OfType<Microsoft.AspNetCore.Routing.RouteEndpoint>()
            .Select(endpoint => endpoint.RoutePattern.RawText).ToArray();
        Check(endpoints.Contains("/api/chat/session") && endpoints.Contains("/hubs/chat/negotiate"), "canonical API and hub are mapped");
        foreach (var retired in new[] { "/next", "/api/next", "/hubs/next" })
        {
            Check(!endpoints.Any(route => route == retired || route?.StartsWith(retired + "/") == true),
                "retired prototype route is not mapped: " + retired);
            Check(!ChatRoutes.IsShell(retired) && !ChatRoutes.IsApi(retired) && !ChatRoutes.IsHub(retired),
                "retired prototype route has no chat auth classification: " + retired);
        }
        var users = factory.Services.GetRequiredService<UserService>();
        var chat = factory.Services.GetRequiredService<ChatService>();
        using var scope = factory.Services.CreateScope();
        var snapshots = scope.ServiceProvider.GetRequiredService<OfflineSnapshotService>();
        var admin = (await users.CreateUserAsync("adminfixture"))!;
        var alice = (await users.CreateUserAsync("alicefixture"))!;
        var bob = (await users.CreateUserAsync("bobfixture"))!;
        var carol = (await users.CreateUserAsync("carolfixture"))!;
        token = alice.Token;
        MediaChecks.Run(factory.Services, root, alice, snapshots);
        await PreviewChecks.Run(factory.Services, alice);
        var dm = chat.GetOrCreateDMChannel(alice.Id, alice.Username, bob.Id, bob.Username);
        dmId = dm.Id;
        Check((await http.GetAsync("/api/chat/bootstrap")).StatusCode == HttpStatusCode.Unauthorized, "anonymous snapshot denied");
        http.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + carol.Token);
        Check((await http.GetAsync($"/api/chat/conversations/{dm.Id}")).StatusCode == HttpStatusCode.NotFound, "nonmember DM denied");
        http.DefaultRequestHeaders.Remove("Cookie");
        http.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + token);
        for (var i = 0; i < 6; i++)
            await chat.SendMessageAsync(dm.Id, bob.Id, bob.Username, "message " + i);
        var before = snapshots.FullView(alice);
        var window = before.Conversations.Single(c => c.Id == dm.Id);
        Check(window.Messages.Length == 3 && window.HasMore && window.Messages[0].Content == "message 3", "configured latest-X bound and ordering");
        editedId = window.Messages[1].Id;
        deletedId = window.Messages[2].Id;
        await chat.MutateMessageAsync(bob, dm.Id, editedId, Guid.NewGuid(), "edit", "edited", null, false);
        await chat.MutateMessageAsync(bob, dm.Id, deletedId, Guid.NewGuid(), "delete", null, null, false);
        await chat.MutateMessageAsync(alice, dm.Id, editedId, Guid.NewGuid(), "reaction", null, "👍", true);
        var after = snapshots.FullView(alice);
        var changed = after.Conversations.Single(c => c.Id == dm.Id);
        Check(after.Revision != before.Revision && changed.Messages.All(m => m.Id != deletedId) && changed.Messages.Single(m => m.Id == editedId).Content == "edited" && changed.Messages.Single(m => m.Id == editedId).Reactions.Single().Users.Single() == alice.Username, "authoritative edit/delete/reaction replacement");
        // Change a room's permissions/history through shared admin operations, including since-signup visibility.
        var room = (await chat.CreateRoomAsync(admin.Id, admin.Username, "historyfixture"))!;
        await chat.SendMessageAsync(room.Id, admin.Id, admin.Username, "before signup cutoff");
        await Task.Delay(20);
        alice.CreatedAt = DateTime.UtcNow;
        await chat.UpdateChannelAsync(admin.Id, room.Id, room.Name, "restricted", ChannelPermission.AdminOnly, HistoryLimit.Unlimited, true);
        Check(snapshots.Conversation(alice, room.Id) is { Messages.Length: 0, CanWrite: false, HistoryLimited: true }, "since-signup and write permissions enforced");
        Check(snapshots.Conversation(admin, room.Id)!.Messages.Length == 1, "admin history exception");
        var oldMessage = chat.GetMessages(dmId, 100).First();
        var oldRevision = snapshots.FullView(alice).Revision;
        await chat.MutateMessageAsync(bob, dmId, oldMessage.Id, Guid.NewGuid(), "edit", "older changed", null, false);
        Check(snapshots.FullView(alice).Revision != oldRevision, "older content mutation invalidates authorized conversation snapshot");
        var historyResult = await http.GetFromJsonAsync<JsonElement>($"/api/chat/conversations/{dmId}/history?limit=100");
        Check(historyResult.GetProperty("messages").EnumerateArray().Any(m => m.GetProperty("id").GetGuid() == oldMessage.Id && m.GetProperty("content").GetString() == "older changed"), "history endpoint includes current older content");
        var restrictedTarget = chat.GetMessages(room.Id, 100).First().Id;
        Check((await http.GetAsync($"/api/chat/conversations/{room.Id}/messages/{restrictedTarget}")).StatusCode == HttpStatusCode.NotFound, "reply lookup respects since-signup history restriction");
        alice.TimeZone = "UTC+1";
        alice.DateFormat = "dmy-12h-cs-CZ";
        var dateResult = await http.GetFromJsonAsync<JsonElement>("/api/chat/bootstrap");
        Check(dateResult.GetProperty("update").GetProperty("state").GetProperty("dateSettings").GetProperty("dateSeparator").GetString() == "." && dateResult.GetProperty("update").GetProperty("state").GetProperty("dateSettings").GetProperty("offsetMinutes").GetInt32() == 60, "date DTO preserves configured separator and custom offset");
        var response = await http.GetAsync("/api/chat/bootstrap");
        var json = await response.Content.ReadAsStringAsync();
        Check(response.Headers.CacheControl?.NoStore == true && !json.Contains(token) && !json.Contains("password", StringComparison.OrdinalIgnoreCase), "safe DTOs and no-store API");
        var gifs = factory.Services.GetRequiredService<GifService>();
        var gifPath = Path.Combine(root, "fixture.gif");
        await File.WriteAllBytesAsync(gifPath, Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
        var acceptedGif = await gifs.TryAcceptAsGifAsync(gifPath, "image/gif", true, alice.Id, "fixture.gif");
        Check(acceptedGif != null, "GIF library fixture accepted by existing media service");
        await gifs.SetFavoriteAsync(alice.Id, acceptedGif!.GifEntryId, true, "Personal folder");
        await gifs.SetServerGifAsync(acceptedGif.GifEntryId, true, "Shared folder");
        var library = await http.GetFromJsonAsync<JsonElement>("/api/chat/gifs/library");
        Check(library.GetProperty("favoriteFolders")[0].GetString() == "Personal folder" && library.GetProperty("serverFolders")[0].GetString() == "Shared folder", "GIF picker exposes own favorite and shared server folders");
        Check((await http.GetFromJsonAsync<JsonElement>("/api/chat/gifs?mode=trending")).GetProperty("items").GetArrayLength() == 0, "Trending never mixes unrelated local GIFs into provider results");
        using (var otherLibrary = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false
        }))
        {
            Check((await otherLibrary.GetAsync("/api/chat/gifs/library")).StatusCode == HttpStatusCode.Unauthorized, "anonymous GIF library denied");
            otherLibrary.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + carol.Token);
            var otherData = await otherLibrary.GetFromJsonAsync<JsonElement>("/api/chat/gifs/library");
            Check(otherData.GetProperty("favorites").GetArrayLength() == 0 && otherData.GetProperty("favoriteFolders").GetArrayLength() == 0 && otherData.GetProperty("server").GetArrayLength() == 1, "GIF picker library keeps another user's favorites/folders private");
        }
        var manifestResponse = await http.GetAsync("/manifest.webmanifest");
        var manifest = await manifestResponse.Content.ReadFromJsonAsync<JsonElement>();
        Check(manifestResponse.Headers.CacheControl?.NoStore == true && manifest.GetProperty("id").GetString() == "/", "credentialed manifest is no-store with stable app identity");
        using (var installed = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false
        }))
        {
            await installed.GetAsync(manifest.GetProperty("start_url").GetString());
            var installedSession = await installed.GetFromJsonAsync<JsonElement>("/api/chat/session");
            Check(installedSession.GetProperty("userId").GetGuid() == alice.Id, "first installed launch redeems token into a separate cookie jar");
            await installed.GetAsync("/pwa-launch?lt=expired-fixture");
            Check((await installed.GetFromJsonAsync<JsonElement>("/api/chat/session")).GetProperty("userId").GetGuid() == alice.Id, "existing installed cookie takes precedence over expired handoff token");
        }
        using (var anonymous = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false
        }))
        {
            await anonymous.GetAsync("/pwa-launch?lt=invalid-fixture");
            Check((await anonymous.GetAsync("/api/chat/session")).StatusCode == HttpStatusCode.Unauthorized, "invalid handoff token does not authenticate");
        }
        await UpgradeChecks.Run(factory.Services, http);
        var sessionResponse = await http.GetAsync("/api/chat/session");
        var anti = (await sessionResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("csrfToken").GetString()!;
        // This fixture switches auth tokens explicitly. An automatic cookie jar would append
        // the renewed old auth cookie and test a duplicate-cookie request instead of a switch.
        var antiCookie = sessionResponse.Headers.GetValues("Set-Cookie").Single(c => !c.StartsWith("yap_auth=")).Split(';')[0];
        http.DefaultRequestHeaders.Remove("Cookie");
        http.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + token + "; " + antiCookie);
        async Task<HttpResponseMessage> Send(Guid channelId, Guid operation, string content, bool csrf = true, string? origin = null, string? fetchSite = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/chat/conversations/{channelId}/messages")
            {
                Content = JsonContent.Create(new { operationId = operation, content })
            };
            if (csrf)
                request.Headers.Add("X-CSRF-TOKEN", anti);
            if (origin != null)
                request.Headers.Add("Origin", origin);
            if (fetchSite != null)
                request.Headers.Add("Sec-Fetch-Site", fetchSite);
            return await http.SendAsync(request);
        }
        Check((await Send(dmId, Guid.NewGuid(), "forged", csrf: false)).StatusCode == HttpStatusCode.Forbidden, "send requires antiforgery token");
        Check((await Send(dmId, Guid.NewGuid(), "forged", origin: "https://foreign.invalid", fetchSite: "cross-site")).StatusCode == HttpStatusCode.Forbidden, "browser-marked cross-site send rejected");
        foreach (var fetchSite in new string?[] { "same-origin", null })
        {
            Check((await Send(dmId, Guid.NewGuid(), "proxy-compatible send", origin: "https://public.example.test:8443", fetchSite: fetchSite)).IsSuccessStatusCode,
                "valid send tolerates public/internal URL mismatch with " + (fetchSite ?? "missing") + " browser metadata");
            Check((await Send(dmId, Guid.NewGuid(), "forged", csrf: false, origin: "https://public.example.test:8443", fetchSite: fetchSite)).StatusCode == HttpStatusCode.Forbidden,
                "URL mismatch never bypasses antiforgery");
            using var negotiate = new HttpRequestMessage(HttpMethod.Post, "/hubs/chat/negotiate?negotiateVersion=1");
            negotiate.Headers.Add("Origin", "https://public.example.test:8443");
            if (fetchSite != null)
                negotiate.Headers.Add("Sec-Fetch-Site", fetchSite);
            using var negotiation = await http.SendAsync(negotiate);
            Check(negotiation.IsSuccessStatusCode, "authenticated hub tolerates public/internal URL mismatch with " + (fetchSite ?? "missing") + " browser metadata");
        }
        using (var negotiate = new HttpRequestMessage(HttpMethod.Post, "/hubs/chat/negotiate?negotiateVersion=1"))
        {
            negotiate.Headers.Add("Sec-Fetch-Site", "cross-site");
            using var negotiation = await http.SendAsync(negotiate);
            Check(negotiation.StatusCode == HttpStatusCode.Forbidden, "browser-marked cross-site hub request rejected");
        }
        using (var anonymous = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false
        }))
        {
            using var negotiation = await anonymous.PostAsync("/hubs/chat/negotiate?negotiateVersion=1", null);
            Check(negotiation.StatusCode == HttpStatusCode.Unauthorized, "hub still requires account authentication without browser metadata");
        }
        http.DefaultRequestHeaders.Remove("Cookie");
        http.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + bob.Token + "; " + antiCookie);
        Check((await Send(dmId, Guid.NewGuid(), "wrong account race")).StatusCode == HttpStatusCode.Forbidden,
            "antiforgery token cannot send under an account switched after session validation");
        http.DefaultRequestHeaders.Remove("Cookie");
        http.DefaultRequestHeaders.Add("Cookie", "yap_auth=" + token + "; " + antiCookie);
        await SyncChecks.Run(factory.Services, http, anti, alice, bob);
        await ChangeChecks.Run(factory.Services, alice, bob);
        await MaintenanceChecks.Run(factory.Services, http, alice);
        var bobUnread = chat.GetUnreadCount(bob.Id, dmId);
        var sends = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Send(dmId, durableOperation, "durable once")));
        Check(sends.All(r => r.IsSuccessStatusCode), "concurrent retries accepted");
        var receipts = await Task.WhenAll(sends.Select(r => r.Content.ReadFromJsonAsync<JsonElement>()));
        durableMessage = receipts[0].GetProperty("messageId").GetGuid();
        Check(receipts.All(r => r.GetProperty("messageId").GetGuid() == durableMessage)
            && chat.GetMessages(dmId, 100).Count(m => m.OperationId == durableOperation) == 1
            && chat.GetUnreadCount(bob.Id, dmId) == bobUnread + 1, "one message and one unread increment for concurrent retries");
        Check((await Send(dmId, durableOperation, "different")).StatusCode == HttpStatusCode.Conflict, "operation payload conflict rejected");
        Check((await Send(room.Id, Guid.NewGuid(), "forbidden")).StatusCode == HttpStatusCode.Forbidden, "current room write permission enforced");
        Check((await Send(dmId, Guid.NewGuid(), new string('x', 4001))).StatusCode == HttpStatusCode.BadRequest, "server text limit enforced");
        var privateDm = await chat.OpenDirectMessageAsync(bob, carol.Username);
        Check((await Send(privateDm.Id, Guid.NewGuid(), "intrusion")).StatusCode == HttpStatusCode.NotFound, "nonmember DM write rejected");
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<ChatDbContext>>().CreateDbContextAsync();
        await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER reject_fixture BEFORE INSERT ON Messages WHEN NEW.Content = 'reject-fixture' BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
        var failedOperation = Guid.NewGuid();
        var beforeFailure = chat.GetMessages(dmId, 100).Count;
        Check((await Send(dmId, failedOperation, "reject-fixture")).StatusCode == HttpStatusCode.ServiceUnavailable,
            "database write rejection is not acknowledged");
        Check(chat.GetMessages(dmId, 100).Count == beforeFailure && !await db.TextSendReceipts.AnyAsync(r => r.OperationId == failedOperation),
            "failed transaction publishes neither message nor receipt");
        await db.Database.ExecuteSqlRawAsync("DROP TRIGGER reject_fixture;");
        Check((await Send(dmId, failedOperation, "reject-fixture")).IsSuccessStatusCode, "retry succeeds after database recovers");
        var mediaReceipt = await chat.SendTextAsync(alice, dmId, Guid.NewGuid(), "", images: ["/uploads/contract.png"]);
        Check((await db.Messages.AsNoTracking().SingleAsync(m => m.Id == mediaReceipt.MessageId)).ImageUrls.Single() == "/uploads/contract.png", "durable media acceptance preserves attachment list");
        var mediaReplayId = Guid.NewGuid();
        var resolveCount = 0;
        Task<(List<string>?, List<string>?, List<GifAttachment>?)> ResolveFixture()
        {
            resolveCount++;
            return Task.FromResult<(List<string>?, List<string>?, List<GifAttachment>?)>((["/uploads/fixture.png"], null, null));
        }
        await chat.SendTextAsync(alice, dmId, mediaReplayId, "", mediaIdentity: "fixture-upload", resolveMedia: ResolveFixture);
        await chat.SendTextAsync(alice, dmId, mediaReplayId, "", mediaIdentity: "fixture-upload", resolveMedia: () => throw new Exception("Consumed upload must not be resolved on retry"));
        Check(resolveCount == 1, "media receipt replay skips upload/provider side effects");
        var actionMessage = await chat.SendTextAsync(alice, dmId, Guid.NewGuid(), "action target");
        var replyReceipt = await chat.SendTextAsync(alice, dmId, Guid.NewGuid(), "reply text", actionMessage.MessageId);
        Check((await db.Messages.AsNoTracking().SingleAsync(m => m.Id == replyReceipt.MessageId)).ReplyToMessageId == actionMessage.MessageId, "reply association persisted atomically");
        var editOperation = Guid.NewGuid();
        await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, editOperation, "edit", "first edit", null, false);
        await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, Guid.NewGuid(), "edit", "latest edit", null, false);
        await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, editOperation, "edit", "first edit", null, false);
        Check(chat.GetMessageById(dmId, actionMessage.MessageId)!.Content == "latest edit", "duplicate old edit cannot overwrite later accepted edit");
        var reactionOperation = Guid.NewGuid();
        await chat.MutateMessageAsync(bob, dmId, actionMessage.MessageId, reactionOperation, "reaction", "", "👍", true);
        await chat.MutateMessageAsync(bob, dmId, actionMessage.MessageId, Guid.NewGuid(), "reaction", "", "👍", false);
        await chat.MutateMessageAsync(bob, dmId, actionMessage.MessageId, reactionOperation, "reaction", "", "👍", true);
        Check(chat.GetMessageById(dmId, actionMessage.MessageId)!.Reactions.Count == 0, "reaction desired state and receipt prevent retry inversion");
        async Task Denied(Func<Task> action, int status, string label)
        {
            try
            {
                await action();
                throw new Exception(label);
            }
            catch (ChatSendException e) { Check(e.Status == status, label); }
        }
        await Denied(() => chat.MutateMessageAsync(bob, dmId, actionMessage.MessageId, Guid.NewGuid(), "edit", "intrusion", null, false), 403, "cannot edit another user's message");
        await Denied(() => chat.MutateMessageAsync(carol, dmId, actionMessage.MessageId, Guid.NewGuid(), "reaction", "", "👍", true), 404, "nonmember mutation rejected");
        await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER reject_edit BEFORE UPDATE ON Messages WHEN NEW.Content = 'reject-edit' BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
        var failedEdit = Guid.NewGuid();
        try
        {
            await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, failedEdit, "edit", "reject-edit", null, false);
            throw new Exception("edit rejection expected");
        }
        catch (DbUpdateException) { }
        Check(chat.GetMessageById(dmId, actionMessage.MessageId)!.Content == "latest edit" && !await db.TextSendReceipts.AnyAsync(r => r.OperationId == failedEdit), "failed edit transaction publishes neither mutation nor receipt");
        await db.Database.ExecuteSqlRawAsync("DROP TRIGGER reject_edit;");
        await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, Guid.NewGuid(), "delete", "", null, false);
        await chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, Guid.NewGuid(), "delete", "", null, false);
        await Denied(() => chat.MutateMessageAsync(alice, dmId, actionMessage.MessageId, Guid.NewGuid(), "edit", "resurrect", null, false), 404, "edit cannot resurrect deleted message; repeat delete succeeds");
        await chat.MutateMessageAsync(alice, dmId, durableMessage, Guid.NewGuid(), "delete", null, null, false);
        Check((await Send(dmId, durableOperation, "durable once")).IsSuccessStatusCode
            && chat.GetMessageById(dmId, durableMessage) == null && !await db.Messages.AnyAsync(m => m.Id == durableMessage),
            "receipt replay after deletion does not resurrect the message");
        var removable = (await chat.CreateRoomAsync(admin.Id, admin.Username, "removablefixture", sinceJoined: false))!;
        var removedOperation = Guid.NewGuid();
        Check((await Send(removable.Id, removedOperation, "accepted before room deletion")).IsSuccessStatusCode, "send accepted before room deletion");
        await chat.DeleteRoomAsync(admin.Id, removable.Id);
        Check(!snapshots.FullView(alice).Conversations.Any(c => c.Id == removable.Id)
            && (await Send(removable.Id, removedOperation, "accepted before room deletion")).IsSuccessStatusCode
            && (await Send(removable.Id, Guid.NewGuid(), "new send to deleted room")).StatusCode == HttpStatusCode.NotFound,
            "deleted-room snapshot, retained receipt and rejection of new sends");
        await PresenceChecks.Run(factory.Services, http, anti, alice, bob, carol, privateDm.Id, room.Id);
        await ConnectionChecks.Run(factory.Services, http, anti, alice, bob);
        await DeliveryChecks.Run(factory.Services, alice);
        await LocaleChecks.Run(http, anti, alice);
        await FollowupChecks.Run(factory.Services, http, anti, alice);
        await GifPagingChecks.Run(http, anti, chat, admin);
        await OriginChecks.Run(factory.Services, http);
        await users.RotateTokenAsync(alice.Id);
        Check((await http.GetAsync("/api/chat/bootstrap")).StatusCode == HttpStatusCode.Unauthorized, "token revocation enforced");
        token = alice.Token;
    }
    // The restarted host also verifies deployers can opt back into restricted proxy trust.
    config["ReverseProxy:KnownProxies:0"] = "192.0.2.25";
    config["ReverseProxy:KnownNetworks:0"] = "192.0.2.128/28";
    File.WriteAllText(Path.Combine(root, "Data", "appsettings.json"), JsonSerializer.Serialize(config));
    using (var restarted = Factory())
    {
        using var http = restarted.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost"),
            AllowAutoRedirect = false
        });
        await UpgradeChecks.CheckForwarding(restarted.Services, restricted: true);
        var users = restarted.Services.GetRequiredService<UserService>();
        Check(users.GetByUsername("originrecipient")?.LoginOrigin == "https://recipient.example.test:8443"
            && users.GetByUsername("originlegacy")?.LoginOrigin == null,
            "per-user login origin survives restart while older accounts retain nullable fallback");
        using var scope = restarted.Services.CreateScope();
        var snapshots = scope.ServiceProvider.GetRequiredService<OfflineSnapshotService>();
        var alice = users.AuthenticateByToken(token)!;
        var window = snapshots.Conversation(alice, dmId, 100)!;
        var chat = restarted.Services.GetRequiredService<ChatService>();
        var carol = users.GetByUsername("carolfixture")!;
        var readDm = chat.GetDMChannels(alice.Username).Single(c => c.IsDMBetween(alice.Id, carol.Id));
        var checkpoint = chat.GetReadCheckpoint(alice.Id, readDm.Id);
        Check(checkpoint.Unread == 1 && checkpoint.Received - checkpoint.ReadThrough == 1, "observed read checkpoints survive application restart");
        await chat.MarkObservedReadAsync(alice.Id, readDm.Id, checkpoint.ReadThrough);
        Check(chat.GetUnreadCount(alice.Id, readDm.Id) == 1, "read replay after restart preserves unseen arrival");
        var replay = await chat.SendTextAsync(alice, dmId, durableOperation, "durable once");
        Check(replay.MessageId == durableMessage && chat.GetMessageById(dmId, durableMessage) == null, "durable receipt survives host restart and deletion");
        Check(window.Messages.All(m => m.Id != deletedId) && window.Messages.Single(m => m.Id == editedId).Content == "edited" && window.Messages.Single(m => m.Id == editedId).Reactions.Length == 1, "recovery survives application restart");
    }
    await MigrationChecks.Run(Path.Combine(root, "Data", "yap.db"));
    config["ChatSettings:Persistence:Enabled"] = "false";
    File.WriteAllText(Path.Combine(root, "Data", "appsettings.json"), JsonSerializer.Serialize(config));
    using (var ephemeral = Factory())
    {
        using var http = ephemeral.CreateClient();
        var users = ephemeral.Services.GetRequiredService<UserService>();
        var user = (await users.CreateUserAsync("ephemeralfixture"))!;
        var chat = ephemeral.Services.GetRequiredService<ChatService>();
        try
        {
            await chat.SendTextAsync(user, chat.GetLobbyId(), Guid.NewGuid(), "must not claim durability");
            throw new Exception("Expected rejection");
        }
        catch (ChatSendException ex) { Check(ex.Status == 503 && ex.Code == "persistence_required", "persistence-disabled server refuses durable sends"); }
    }
}
finally { Directory.Delete(root, true); }
