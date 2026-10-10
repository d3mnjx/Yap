using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Yap.Data;
using Yap.Middleware;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class DesignChecks
{
    static void Check(bool condition, string label)
    {
        if (!condition)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
    public static async Task Run(IServiceProvider services, HttpClient http, User alice)
    {
        var clock = (Microsoft.Extensions.Time.Testing.FakeTimeProvider)services.GetRequiredService<TimeProvider>();
        var savedCookies = http.DefaultRequestHeaders.GetValues("Cookie").Single();
        var env = services.GetRequiredService<IWebHostEnvironment>();
        var shellPath = Path.Combine(env.WebRootPath, "chat-client", "index.html");
        Directory.CreateDirectory(Path.GetDirectoryName(shellPath)!);
        var previous = File.Exists(shellPath) ? await File.ReadAllTextAsync(shellPath) : null;
        void Cookie(string value)
        {
            http.DefaultRequestHeaders.Remove("Cookie");
            if (value.Length > 0)
                http.DefaultRequestHeaders.Add("Cookie", value);
        }
        try
        {
            await File.WriteAllTextAsync(shellPath, "<!doctype html><html data-appearance><body>design-shell-fixture</body></html>");
            Cookie("yap_auth=" + alice.Token);
            using var shell = await http.GetAsync("/chat");
            Check(shell.IsSuccessStatusCode && !shell.Headers.Contains("Set-Cookie"), "chat shell never reissues cookies");
            var queue = services.GetRequiredService<RequestLogQueue>();
            while (queue.TryDequeue(out _))
            {
            }
            using var rootRequest = new HttpRequestMessage(HttpMethod.Get, "/");
            rootRequest.Headers.UserAgent.ParseAdd("Android design-root-fixture");
            using var root = await http.SendAsync(rootRequest);
            Check((await root.Content.ReadAsStringAsync()).Contains("design-shell-fixture")
                && root.Headers.CacheControl?.NoStore == true && !root.Headers.Contains("Set-Cookie"),
                "authenticated root uses mapped no-store shell without cookie writes");
            var entries = new List<RequestLogEntry>();
            while (queue.TryDequeue(out var entry))
                entries.Add(entry!);
            Check(entries.Any(e => e.Path == "/" && e.DeviceClass == "mobile" && e.StatusCode == 200),
                "authenticated root reaches request logging after mobile device classification");
            using var returned = await http.GetAsync("/?returnUrl=%2Fsettings");
            Check(!(await returned.Content.ReadAsStringAsync()).Contains("design-shell-fixture"), "root returnUrl retains Razor Welcome routing");
            Cookie("");
            using var anonymous = await http.GetAsync("/");
            Check(!(await anonymous.Content.ReadAsStringAsync()).Contains("design-shell-fixture"), "anonymous root retains Razor Welcome routing");
            Cookie("yap_auth=" + alice.Token);
            using var first = await http.GetAsync("/api/chat/session");
            var cookies = Microsoft.Net.Http.Headers.SetCookieHeaderValue.ParseList(first.Headers.GetValues("Set-Cookie").ToList());
            var auth = cookies.Single(c => c.Name == AuthMiddleware.CookieName);
            var renewal = cookies.Single(c => c.Name == AuthCookieRenewal.CookieName);
            Check(auth.Expires > clock.GetUtcNow().AddDays(364) && auth.HttpOnly && auth.Secure,
                "session renews legacy cookie with a moving one-year expiry");
            Cookie("yap_auth=" + alice.Token + "; " + renewal.Name + "=" + renewal.Value);
            clock.Advance(TimeSpan.FromMinutes(59));
            using var frequent = await http.GetAsync("/api/chat/session");
            Check(!frequent.Headers.TryGetValues("Set-Cookie", out var repeated)
                || repeated.All(c => !c.StartsWith("yap_auth")), "session checks and sibling tabs do not reissue auth cookies within an hour");
            clock.Advance(TimeSpan.FromMinutes(2));
            using var later = await http.GetAsync("/api/chat/session");
            var renewed = Microsoft.Net.Http.Headers.SetCookieHeaderValue.ParseList(later.Headers.GetValues("Set-Cookie").ToList())
                .Single(c => c.Name == AuthMiddleware.CookieName);
            Check(renewed.Expires > auth.Expires!.Value.AddHours(1), "hourly session renewal advances the cookie expiry");
            Cookie("yap_auth=" + alice.Token + "; " + AuthCookieRenewal.CookieName + "=invalid");
            using var invalid = await http.GetAsync("/api/chat/session");
            Check(invalid.Headers.GetValues("Set-Cookie").Any(c => c.StartsWith("yap_auth=")), "invalid renewal marker cannot suppress legacy-cookie upgrade");
            using var mismatch = new HttpRequestMessage(HttpMethod.Post, "/hubs/chat/negotiate?negotiateVersion=1");
            mismatch.Headers.Add(ChatProtocol.Header, "1");
            Check((int)(await http.SendAsync(mismatch)).StatusCode == 426, "hub negotiation rejects mismatched protocol header with 426");
            using var query = new HttpRequestMessage(HttpMethod.Post, "/hubs/chat/negotiate?negotiateVersion=1&protocol=1");
            Check((int)(await http.SendAsync(query)).StatusCode == 426, "hub transports reject mismatched browser protocol query with 426");
            var hub = ActivatorUtilities.CreateInstance<OfflineHub>(services);
            var caller = new Caller();
            caller.Http.Request.QueryString = new QueryString("?protocol=1");
            hub.Context = caller;
            var denied = false;
            try
            {
                await hub.Report(true, 0, null);
            }
            catch (HubException error) when (error.Message == "UPDATE_REQUIRED") { denied = true; }
            Check(denied, "hub Permit checks protocol before accepting transient reports");
        }
        finally
        {
            Cookie(savedCookies);
            if (previous == null)
                File.Delete(shellPath);
            else
                await File.WriteAllTextAsync(shellPath, previous);
        }
        await ForegroundReads(services);
    }
    private static async Task ForegroundReads(IServiceProvider services)
    {
        var users = services.GetRequiredService<UserService>();
        var viewer = (await users.CreateUserAsync("designviewer"))!;
        var sender = (await users.CreateUserAsync("designsender"))!;
        var chat = services.GetRequiredService<ChatService>();
        var live = services.GetRequiredService<OfflineLiveService>();
        var dm = chat.GetOrCreateDMChannel(viewer.Id, viewer.Username, sender.Id, sender.Username);
        await live.Join("design-viewer", viewer, live.Ticket(viewer), UserStatus.Online, true, false, 0);
        await live.Report("design-viewer", viewer, true, 0, dm.Id);
        await live.Join("design-sibling", viewer, live.Ticket(viewer), UserStatus.Online, false, true, 0);
        var counts = new List<int>();
        void Observe(Guid id, Guid channel)
        {
            if (id == viewer.Id && channel == dm.Id)
                counts.Add(chat.GetUnreadCount(id, channel));
        }
        chat.OnUnreadChanged += Observe;
        try
        {
            await chat.SendTextAsync(sender, dm.Id, Guid.NewGuid(), "already being read");
            Check(chat.GetUnreadCount(viewer.Id, dm.Id) == 0 && counts.All(c => c == 0),
                "foreground caught-up reader does not flash unread on a second device");
            await live.Report("design-viewer", viewer, false, 0, dm.Id);
            await chat.SendTextAsync(sender, dm.Id, Guid.NewGuid(), "hidden arrival");
            var seen = chat.GetReadCheckpoint(viewer.Id, dm.Id).Received;
            Check(chat.GetUnreadCount(viewer.Id, dm.Id) == 1, "hidden viewer still receives unread checkpoints");
            await live.Report("design-viewer", viewer, true, 0, dm.Id);
            await chat.SendTextAsync(sender, dm.Id, Guid.NewGuid(), "catch-up arrival");
            await chat.MarkObservedReadAsync(viewer.Id, dm.Id, seen, source: "resume");
            Check(chat.GetUnreadCount(viewer.Id, dm.Id) == 1, "foreground recovery cannot swallow earlier or unseen unread arrivals");
            await chat.MarkObservedReadAsync(viewer.Id, dm.Id, chat.GetReadCheckpoint(viewer.Id, dm.Id).Received, source: "open");
            await live.SetStatus("design-viewer", viewer, UserStatus.Away);
            await chat.SendTextAsync(sender, dm.Id, Guid.NewGuid(), "Away arrival");
            Check(chat.GetUnreadCount(viewer.Id, dm.Id) == 1, "manual Away does not suppress unread increments");
            await chat.MarkObservedReadAsync(viewer.Id, dm.Id, chat.GetReadCheckpoint(viewer.Id, dm.Id).Received, source: "explicit");
            await live.SetStatus("design-viewer", viewer, UserStatus.Online);
            await live.Report("design-viewer", viewer, true, 0, null);
            await chat.SendTextAsync(sender, dm.Id, Guid.NewGuid(), "unloaded window");
            Check(chat.GetUnreadCount(viewer.Id, dm.Id) == 1, "unloaded or invalidated windows retain unread arrivals");
            await using var db = await services.GetRequiredService<IDbContextFactory<ChatDbContext>>().CreateDbContextAsync();
            var state = await db.ChannelReadStates.AsNoTracking().SingleAsync(s => s.UserId == viewer.Id && s.ChannelId == dm.Id);
            Check(state.UnreadCount == 1 && state.ReceivedCount - state.ReadThrough == 1,
                "foreground policy preserves persisted checkpoint arithmetic");
            var sources = services.GetRequiredService<NotificationAudit>().GetUnreadChanges()
                .Where(change => change.User == viewer.Username && change.Kind == "clear").Select(change => change.Source);
            Check(new[] { "resume", "open", "explicit" }.All(sources.Contains), "read audit retains resume, open and explicit sources");
            var room = chat.GetRooms().First(c => c.IsDefault);
            await live.Report("design-viewer", viewer, true, 0, room.Id);
            await chat.SendTextAsync(sender, room.Id, Guid.NewGuid(), "foreground room arrival");
            Check(chat.GetUnreadCount(viewer.Id, room.Id) == 0, "foreground room arrivals also avoid unread flashes");
            await live.Leave("design-viewer");
            await chat.SendTextAsync(sender, room.Id, Guid.NewGuid(), "disconnected room arrival");
            Check(chat.GetUnreadCount(viewer.Id, room.Id) == 1, "disconnected retained sessions cannot suppress unread arrivals");
            await chat.MarkObservedReadAsync(viewer.Id, room.Id, chat.GetReadCheckpoint(viewer.Id, room.Id).Received);
            await live.Join("design-legacy", viewer, live.Ticket(viewer), UserStatus.Online, true, false, 0);
            await live.Report("design-legacy", viewer, true, 0, room.Id, validatedView: false);
            await chat.SendTextAsync(sender, room.Id, Guid.NewGuid(), "older hub client selection");
            Check(chat.GetUnreadCount(viewer.Id, room.Id) == 1, "unversioned hub clients retain observed-read accounting during shell upgrade");
            await live.Leave("design-legacy");
        }
        finally { chat.OnUnreadChanged -= Observe; await live.Leave("design-viewer"); await live.Leave("design-sibling"); }
    }
    private sealed class Caller : HubCallerContext, IHttpContextFeature
    {
        public HttpContext Http { get; private set; } = new DefaultHttpContext();
        public Caller()
        {
            Features.Set<IHttpContextFeature>(this);
        }
        HttpContext? IHttpContextFeature.HttpContext
        {
            get => Http; set => Http = value!;
        }
        public override string ConnectionId => "design-protocol";
        public override string? UserIdentifier => null;
        public override ClaimsPrincipal? User => null;
        public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
        public override IFeatureCollection Features { get; } = new FeatureCollection();
        public override CancellationToken ConnectionAborted => default;
        public override void Abort()
        {
        }
    }
}
