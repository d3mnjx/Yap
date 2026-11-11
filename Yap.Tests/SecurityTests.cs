using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Yap.Helpers;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Gifs;
using Yap.Services.Media;
using Yap.Services.Presence;

namespace Yap.Tests;

/// <summary>
/// The checks that followed the review of 2026-10-15: a forwarded header and smart login, the connect guard
/// against the server's own network, GIF ids, unfinished uploads, push subscriptions, and the beacon nonce.
/// Each test fails on the code before the fix.
/// </summary>
public class SecurityTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public SecurityTests(YapFactory app) => _app = app;

    private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
    private static readonly byte[] Gif = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    // Two red frames of 8 x 8, made with ffmpeg. The name of the format is not in the lists of TusEndpoints.
    private static readonly byte[] Apng = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAIAAAACAAAAAAAAAAAAAEABQAA+RL9XwAAABJJREFUeJxj/M+AHbDgEB+kEgDSuQEdMHaoJwAAABpmY1RMAAAAAQAAAAEAAAABAAAAAAAAAAAAAQAFAADKUJ05AAAAEGZkQVQAAAACeJxj/M/AAAADBQEBhCp0sQAAAABJRU5ErkJggg==");
    // Two red frames, then two blue ones, 16 x 16, made with ffmpeg. An animated AVIF holds two video streams: its
    // still picture (the first frame) and the animation.
    private static readonly byte[] Avif = Convert.FromBase64String("AAAALGZ0eXBhdmlzAAAAAGF2aXNhdmlmbXNmMWlzbzhtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAA/AAAAAiAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAALDbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAABTYAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAk90cmFrAAAAaHRraGQBAAADAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAf/////////8AAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAQAAAAEAAAU2AAAAAAABAAAAAAG7bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAQABVxAAAAAAAL2hkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAABQaWN0dXJlSGFuZGxlcgAAAAFkbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABJHN0YmwAAACcc3RzZAAAAAAAAAABAAAAjGF2MDEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEYTGF2YzYyLjExLjEwMCBsaWJhb20tYXYxAAAAAAAAAAAY//8AAAAMYXYxQ4EADAAAAAAKZmllbAEAAAAAEHBhc3AAAAABAAAAAQAAABBjY3N0AAAAAHwAAAAAAAAYc3R0cwAAAAAAAAABAAAABAAAEAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAABAAAAAEAAAAkc3RzegAAAAAAAAAAAAAABAAAACIAAAAUAAAAHQAAABQAAAAUc3RjbwAAAAAAAAABAAAD8AAAAG9tZGF0CgoAAAABn/n/8wCAMhQQAK6AAAJAAAAAeJ2JgR9lXUOJmDISMAPAgAAABsAAAAKAAACAAHaQMhswBcEEAABGu4AAAkAAAIAAGBW8dnjpRwz8bg0yEjAGAgQEAEbAAAACgAAAgAB4oA==");
    private static readonly byte[] Page = Encoding.UTF8.GetBytes("<script>document.title = 'not a picture'</script>");

    // The tus protocol, in one place for the tests below: the create, the bytes, and the id of the upload.
    private static Task<HttpResponseMessage> CreateUploadAsync(HttpClient http, string fileName, int length, params (string Key, string Value)[] more)
    {
        var metadata = more.Prepend(("filename", fileName)).Select(m => $"{m.Item1} {Convert.ToBase64String(Encoding.UTF8.GetBytes(m.Item2))}");
        var create = new HttpRequestMessage(HttpMethod.Post, "/api/tus");
        create.Headers.Add("Tus-Resumable", "1.0.0");
        create.Headers.Add("Upload-Length", length.ToString());
        create.Headers.Add("Upload-Metadata", string.Join(",", metadata));
        return http.SendAsync(create);
    }

    private static Task<HttpResponseMessage> SendBytesAsync(HttpClient http, HttpResponseMessage created, byte[] bytes)
    {
        var patch = new HttpRequestMessage(HttpMethod.Patch, created.Headers.Location!.ToString()) { Content = new ByteArrayContent(bytes) };
        patch.Content.Headers.ContentType = new("application/offset+octet-stream");
        patch.Headers.Add("Tus-Resumable", "1.0.0");
        patch.Headers.Add("Upload-Offset", "0");
        return http.SendAsync(patch);
    }

    private static string FileId(HttpResponseMessage created) => created.Headers.Location!.ToString().TrimEnd('/').Split('/').Last();

    /// <summary>A whole upload that the server takes at the create: the bytes go up, and the answer is the result the uploader gets.</summary>
    private static async Task<JsonElement> UploadAsync(HttpClient http, string fileName, byte[] bytes, params (string Key, string Value)[] more)
    {
        var created = await CreateUploadAsync(http, fileName, bytes.Length, more);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await SendBytesAsync(http, created, bytes)).StatusCode);
        return await http.GetFromJsonAsync<JsonElement>($"/api/tus/info/{FileId(created)}");
    }

    /// <summary>Whether a file with exactly these bytes is anywhere under the uploads folder: the public part, and the part of tus.</summary>
    private bool IsStored(byte[] bytes) => Directory.EnumerateFiles(_app.Service<UploadPaths>().Root, "*", SearchOption.AllDirectories).Any(path =>
    {
        try { return new FileInfo(path).Length == bytes.Length && File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes); }
        catch (IOException) { return false; }   // a file of another upload that went away in this moment
    });

    [Fact(DisplayName = "AU-09: a forwarded header counts from a trusted proxy only; from anyone else the address is unknown")]
    public async Task Forwarded_headers_count_from_trusted_proxies_only()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["ChatSettings:TrustedProxies:0"] = "10.0.0.0/8" }).Build();
        var middleware = new ForwardedHeadersMiddleware(_ => Task.CompletedTask, NullLoggerFactory.Instance, Options.Create(TrustedProxies.Options(config)));

        static DefaultHttpContext Request(string peer, string? forwardedFor)
        {
            var http = new DefaultHttpContext();
            http.Connection.RemoteIpAddress = IPAddress.Parse(peer);
            if (forwardedFor is not null) http.Request.Headers["X-Forwarded-For"] = forwardedFor;
            return http;
        }

        var direct = Request("198.51.100.7", null);
        await middleware.Invoke(direct);
        Assert.Equal("198.51.100.7", IpHelper.GetClientIp(direct));

        var viaProxy = Request("10.1.2.3", "203.0.113.9");
        await middleware.Invoke(viaProxy);
        Assert.Equal("203.0.113.9", IpHelper.GetClientIp(viaProxy));

        var spoofed = Request("198.51.100.7", "203.0.113.9");   // the client wrote the header itself
        await middleware.Invoke(spoofed);
        Assert.Null(IpHelper.GetClientIp(spoofed));
    }

    [Fact(DisplayName = "AU-09: behind a Cloudflare hop the visitor is CF-Connecting-IP; from anyone else the header is ignored")]
    public async Task Cloudflare_hop_gives_the_visitor_and_needs_no_listing()
    {
        // The deployment this models: visitor -> Cloudflare -> Caddy (no Cloudflare configuration) -> Docker gateway -> Yap.
        // Only the gateway is listed; Cloudflare is known by its ranges (CloudflareIps), and Caddy passes CF-Connecting-IP through.
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["ChatSettings:TrustedProxies:0"] = "10.0.0.0/8" }).Build();
        var middleware = new ForwardedHeadersMiddleware(_ => Task.CompletedTask, NullLoggerFactory.Instance, Options.Create(TrustedProxies.Options(config)));
        var services = new ServiceCollection().AddSingleton<CloudflareIps>().BuildServiceProvider();

        static DefaultHttpContext Request(IServiceProvider services, string peer, string? forwardedFor, string? connectingIp)
        {
            var http = new DefaultHttpContext { RequestServices = services };
            http.Connection.RemoteIpAddress = IPAddress.Parse(peer);
            if (forwardedFor is not null) http.Request.Headers["X-Forwarded-For"] = forwardedFor;
            if (connectingIp is not null) http.Request.Headers["CF-Connecting-IP"] = connectingIp;
            return http;
        }

        var viaCaddy = Request(services, "10.1.2.3", "104.16.1.1", "203.0.113.9");   // Caddy wrote the Cloudflare edge into X-Forwarded-For
        await middleware.Invoke(viaCaddy);
        Assert.Equal("203.0.113.9", IpHelper.GetClientIp(viaCaddy));
        Assert.Null(IpHelper.UntrustedForwardedFor(viaCaddy));

        var direct = Request(services, "172.64.5.5", "203.0.113.9", "203.0.113.9");   // Cloudflare itself is the peer, nothing listed for it
        await middleware.Invoke(direct);
        Assert.Equal("203.0.113.9", IpHelper.GetClientIp(direct));
        Assert.Null(IpHelper.UntrustedForwardedFor(direct));   // no "proxy not trusted" notice for Cloudflare

        var spoofed = Request(services, "198.51.100.7", null, "203.0.113.42");   // not a Cloudflare address: the header is the client's word
        await middleware.Invoke(spoofed);
        Assert.Equal("198.51.100.7", IpHelper.GetClientIp(spoofed));

        var aroundCloudflare = Request(services, "10.1.2.3", "198.51.100.7", "203.0.113.42");   // reached Caddy without Cloudflare
        await middleware.Invoke(aroundCloudflare);
        Assert.Equal("198.51.100.7", IpHelper.GetClientIp(aroundCloudflare));
    }

    [Fact(DisplayName = "AU-09: a CF-Connecting-IP from a peer that is not Cloudflare does not sign in as the person who used that address")]
    public async Task Spoofed_cloudflare_header_does_not_sign_in()
    {
        await _app.SignInAsync("nora_smart");
        var users = _app.Service<UserService>();
        users.RecordKnownIp(users.GetByUsername("nora_smart")!.Id, "203.0.113.77");

        var attacker = _app.CreateClient();
        attacker.DefaultRequestHeaders.Add("X-Test-Remote-Ip", "198.51.100.7");
        attacker.DefaultRequestHeaders.Add("CF-Connecting-IP", "203.0.113.77");
        var check = await attacker.GetFromJsonAsync<JsonElement>("/api/auth/check?username=nora_smart");
        Assert.NotEqual("smart", check.GetProperty("state").GetString());

        var throughCloudflare = _app.CreateClient();   // the same header from a Cloudflare address is the visitor
        throughCloudflare.DefaultRequestHeaders.Add("X-Test-Remote-Ip", "104.16.1.1");
        throughCloudflare.DefaultRequestHeaders.Add("CF-Connecting-IP", "203.0.113.77");
        var own = await throughCloudflare.GetFromJsonAsync<JsonElement>("/api/auth/check?username=nora_smart");
        Assert.Equal("smart", own.GetProperty("state").GetString());
    }

    [Fact(DisplayName = "AU-09: a spoofed X-Forwarded-For does not sign in as the person who used that address")]
    public async Task Spoofed_forwarded_header_does_not_sign_in()
    {
        await _app.SignInAsync("vera_smart");
        var users = _app.Service<UserService>();
        users.RecordKnownIp(users.GetByUsername("vera_smart")!.Id, "203.0.113.42");   // a device of hers connected from there

        var attacker = _app.CreateClient();   // from elsewhere, with her address in a header
        attacker.DefaultRequestHeaders.Add("X-Test-Remote-Ip", "198.51.100.7");
        attacker.DefaultRequestHeaders.Add("X-Forwarded-For", "203.0.113.42");
        var check = await attacker.GetFromJsonAsync<JsonElement>("/api/auth/check?username=vera_smart");
        Assert.NotEqual("smart", check.GetProperty("state").GetString());
        var signin = await attacker.PostAsJsonAsync("/api/auth/signin", new { username = "vera_smart" });
        Assert.NotEqual(HttpStatusCode.OK, signin.StatusCode);
        Assert.False(signin.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(c => c.StartsWith("yap_auth=")));

        var device = _app.CreateClient();     // from the address itself: the smart login she is entitled to
        device.DefaultRequestHeaders.Add("X-Test-Remote-Ip", "203.0.113.42");
        var own = await device.GetFromJsonAsync<JsonElement>("/api/auth/check?username=vera_smart");
        Assert.Equal("smart", own.GetProperty("state").GetString());
    }

    [Fact(DisplayName = "The fetch clients refuse a private address at the connection, so a redirect cannot reach one")]
    public async Task Private_addresses_are_refused_at_connect()
    {
        using var client = new HttpClient(new SocketsHttpHandler { ConnectCallback = NetworkSecurityHelper.ConnectToPublicAddress }) { Timeout = TimeSpan.FromSeconds(5) };
        foreach (var url in new[] { "http://127.0.0.1:9/", "http://[::1]:9/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://100.64.0.1/", "http://localhost:9/" })
        {
            var error = await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync(url));
            Assert.Contains("not a public address", error.Message + error.InnerException?.Message);
        }
        Assert.True(NetworkSecurityHelper.IsPrivateAddress(IPAddress.Parse("::ffff:192.168.1.1")));
        Assert.False(NetworkSecurityHelper.IsPrivateAddress(IPAddress.Parse("93.184.216.34")));
    }

    [Fact(DisplayName = "A redirect to a private address is refused before the hop; a redirect to a public one is followed")]
    public async Task Redirects_are_checked_per_hop()
    {
        static HttpClient Client(Func<HttpRequestMessage, HttpResponseMessage> answer) =>
            new(new SafeRedirectHandler { InnerHandler = new StubHandler(answer) });

        using var toPrivate = Client(_ => new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("http://169.254.169.254/latest/meta-data/") } });
        var error = await Assert.ThrowsAsync<HttpRequestException>(() => toPrivate.GetAsync("https://public.example/start"));
        Assert.Contains("not a public address", error.Message);

        var hops = new List<string>();
        using var toPublic = Client(request =>
        {
            hops.Add(request.RequestUri!.ToString());
            return hops.Count == 1
                ? new HttpResponseMessage(HttpStatusCode.MovedPermanently) { Headers = { Location = new Uri("https://one.one.one.one/landing") } }
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("landed") };
        });
        var response = await toPublic.GetAsync("https://public.example/start");
        Assert.Equal("landed", await response.Content.ReadAsStringAsync());
        Assert.Equal(["https://public.example/start", "https://one.one.one.one/landing"], hops);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(answer(request));
    }

    [Fact(DisplayName = "PK-27, ST-23: a private upload is the uploader's until it was sent or starred; tags are the uploader's or the admin's")]
    public async Task Gif_ids_are_not_entry_tickets()
    {
        var owner = await _app.SignInAsync("olga_gif");
        var other = await _app.SignInAsync("omar_gif");
        var users = _app.Service<UserService>();
        var gifs = _app.Service<GifService>();
        Directory.CreateDirectory(_app.Service<UploadPaths>().Gifs);
        var source = Path.Combine(_app.ContentRoot, "private.gif");
        await File.WriteAllBytesAsync(source, Gif);
        var accepted = await gifs.TryAcceptAsGifAsync(source, ".gif", "image/gif", isExplicitGif: true, users.GetByUsername("olga_gif")!.Id, "private.gif");
        Assert.NotNull(accepted);
        var id = accepted!.GifEntryId;
        var lobby = _app.Service<ChatService>().LobbyId;

        // another person: no star, no tags, no send by id
        Assert.Equal(HttpStatusCode.NotFound, (await other.Http.PutAsJsonAsync($"/api/gifs/{id}/favorite", new { on = true })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Http.PutAsJsonAsync($"/api/gifs/{id}/tags", new { tags = new[] { "mine" } })).StatusCode);
        var send = await other.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), gifs = new[] { new { entryId = id } } });
        Assert.Equal(HttpStatusCode.BadRequest, send.StatusCode);

        // the uploader: tags and a send
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Http.PutAsJsonAsync($"/api/gifs/{id}/tags", new { tags = new[] { "cat" } })).StatusCode);
        var sent = await owner.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), gifs = new[] { new { entryId = id } } });
        Assert.Equal(HttpStatusCode.OK, sent.StatusCode);

        // sent in a conversation: the other person may star it now, and still not tag it
        Assert.Equal(HttpStatusCode.NoContent, (await other.Http.PutAsJsonAsync($"/api/gifs/{id}/favorite", new { on = true })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Http.PutAsJsonAsync($"/api/gifs/{id}/tags", new { tags = new[] { "mine" } })).StatusCode);
    }

    [Fact(DisplayName = "An unfinished upload and its result belong to the uploader")]
    public async Task Uploads_belong_to_the_uploader()
    {
        var uma = await _app.SignInAsync("uma_tus");
        var ulf = await _app.SignInAsync("ulf_tus");

        var created = await CreateUploadAsync(uma.Http, "dot.png", Png.Length);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var fileId = FileId(created);

        // another person can neither see nor continue the upload
        var peek = new HttpRequestMessage(HttpMethod.Head, created.Headers.Location!.ToString());
        peek.Headers.Add("Tus-Resumable", "1.0.0");
        Assert.Equal(HttpStatusCode.NotFound, (await ulf.Http.SendAsync(peek)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SendBytesAsync(ulf.Http, created, Png)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await SendBytesAsync(uma.Http, created, Png)).StatusCode);

        // the result: the uploader's only, as often as the uploader asks (an answer can be lost on the way), and without the server's path
        Assert.Equal(HttpStatusCode.Unauthorized, (await _app.CreateClient().GetAsync($"/api/tus/info/{fileId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ulf.Http.GetAsync($"/api/tus/info/{fileId}")).StatusCode);
        var info = await uma.Http.GetFromJsonAsync<JsonElement>($"/api/tus/info/{fileId}");
        Assert.StartsWith("/uploads/", info.GetProperty("url").GetString());
        Assert.False(info.TryGetProperty("path", out _));
        var again = await uma.Http.GetFromJsonAsync<JsonElement>($"/api/tus/info/{fileId}");
        Assert.Equal(info.GetProperty("url").GetString(), again.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await ulf.Http.GetAsync($"/api/tus/info/{fileId}")).StatusCode);   // still nobody else's
    }

    [Fact(DisplayName = "An error in the server's work on a finished upload is a refusal, not an endless \"still at work\"")]
    public async Task A_failed_upload_gets_a_result()
    {
        var uma = await _app.SignInAsync("uma_tus_error");

        var created = await CreateUploadAsync(uma.Http, "pack.zip", Png.Length, ("kind", "gif-pack"));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var fileId = FileId(created);

        // The fault: a folder stands where the server puts a pack (TusEndpoints.cs), so the move of the file throws,
        // as it does on a disk that fails.
        var inTheWay = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), $"gif-pack-{fileId}.zip"));
        try
        {
            Assert.Equal(HttpStatusCode.NoContent, (await SendBytesAsync(uma.Http, created, Png)).StatusCode);

            // 200 with an error, not the 202 of "still at work": the client shows the file as refused, with Retry
            var answer = await uma.Http.GetAsync($"/api/tus/info/{fileId}");
            Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
            Assert.Equal("error", (await answer.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("type").GetString());
        }
        finally { inTheWay.Delete(); }
    }

    [Fact(DisplayName = "A plain upload needs the name of a picture or a video, and the server refuses another name before the bytes flow")]
    public async Task A_plain_upload_is_refused_by_its_name_at_the_create()
    {
        var uma = await _app.SignInAsync("uma_tus_name");
        foreach (var name in new[] { "page.html", "page.svg", "noextension", "clip.m4v" })   // .m4v: a GIF source only, not a chat file
            Assert.Equal(HttpStatusCode.BadRequest, (await CreateUploadAsync(uma.Http, name, Page.Length)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await CreateUploadAsync(uma.Http, "dot.PNG", Png.Length)).StatusCode);
    }

    [Fact(DisplayName = "The size cap of an upload follows the kind that tus reads, not a text somewhere in the metadata")]
    public async Task The_cap_of_a_pack_needs_the_kind_of_a_pack()
    {
        var uma = await _app.SignInAsync("uma_tus_cap");
        const int large = 300 * 1024 * 1024;   // over the cap of a chat upload (100 MB), under the cap of a pack (1024 MB); no byte is sent
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await CreateUploadAsync(uma.Http, "big.mp4", large)).StatusCode);
        // "xkind" is no kind for tus, so this is a plain chat upload. Before the fix it was created: the cap came from
        // a search for the text of the pair "kind gif-pack" in the header, and that text is in "xkind gif-pack" too.
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await CreateUploadAsync(uma.Http, "big.mp4", large, ("xkind", "gif-pack"))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await CreateUploadAsync(uma.Http, "pack.zip", large, ("kind", "gif-pack"))).StatusCode);

        // A create that names its length later, on a PATCH, gets no cap at all from tus. The server offers no such create.
        var deferred = new HttpRequestMessage(HttpMethod.Post, "/api/tus");
        deferred.Headers.Add("Tus-Resumable", "1.0.0");
        deferred.Headers.Add("Upload-Defer-Length", "1");
        deferred.Headers.Add("Upload-Metadata", $"filename {Convert.ToBase64String(Encoding.UTF8.GetBytes("big.mp4"))}");
        Assert.False((await uma.Http.SendAsync(deferred)).IsSuccessStatusCode);
    }

    [Fact(DisplayName = "The media of a message are plain URLs of uploads: a browser resolves a URL before it asks")]
    public async Task Media_urls_stay_inside_the_uploads()
    {
        var mia = await _app.SignInAsync("mia_media_url");
        var lobby = _app.Service<ChatService>().LobbyId;
        Task<HttpResponseMessage> Send(object body) => mia.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", body);

        // Each of these starts with /uploads/, and a browser asks for another path of this server, with the reader's cookie.
        foreach (var url in new[]
                 {
                     "/uploads/../api/invite/zzz.png", "/uploads/a/../../api/invite/zzz.png", "/uploads/%2e%2e/api/invite/zzz.png",
                     "/uploads/..\\api\\invite\\zzz.png", "/uploads/./dot.png", "/uploads//dot.png", "/uploads/dot.png?x=1", "/uploads/dot.png#x",
                 })
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await Send(new { clientId = Guid.NewGuid(), images = new[] { url } })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await Send(new { clientId = Guid.NewGuid(), videos = new[] { url } })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await Send(new { clientId = Guid.NewGuid(), voice = new { url, durationMs = 1000, peaks = "0369" } })).StatusCode);
        }
        // The form that the upload endpoint gives.
        Assert.Equal(HttpStatusCode.OK, (await Send(new { clientId = Guid.NewGuid(), images = new[] { $"/uploads/{Guid.NewGuid()}.png" } })).StatusCode);
    }

    [Fact(DisplayName = "A picture with more pixels than the server decodes is refused with the reason, whatever the size of its file")]
    public async Task A_picture_with_too_many_pixels_is_refused()
    {
        // One colour, 7200 x 7200: 52 MP in a file of some KB. The server decodes a picture whole for its thumbnails,
        // so the size of the file is no limit for the memory. Before the fix this upload got a URL and its thumbnails.
        using var stream = new MemoryStream();
        using (var picture = new SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.L8>(7200, 7200))
            await SixLabors.ImageSharp.ImageExtensions.SaveAsPngAsync(picture, stream);
        var bytes = stream.ToArray();
        Assert.True(bytes.Length < 1024 * 1024, "the test picture must be a small file");

        var pia = await _app.SignInAsync("pia_pixels");
        var info = await UploadAsync(pia.Http, "huge.png", bytes);
        Assert.Equal("error", info.GetProperty("type").GetString());
        Assert.Contains("too many pixels (7200 x 7200, max 50 megapixels)", info.GetProperty("error").GetString());
        Assert.False(info.TryGetProperty("url", out _));
        Assert.False(IsStored(bytes));
    }

    [Theory(DisplayName = "IB-32: a GIF has the pixel limit of a picture, in the chat and in a library")]
    [InlineData(null)]
    [InlineData("user")]
    public async Task A_gif_with_too_many_pixels_is_refused(string? target)
    {
        // The canvas of a GIF is in its header (bytes 6 to 9), and every frame is drawn on it: 7200 x 7200 is 52 MP in
        // a file of 42 bytes. A GIF is stored as it came, on a route of its own, and the pixel check stood after that
        // route. So this file was accepted, and each reader's browser got the 52 MP.
        var bytes = (byte[])Gif.Clone();
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(6), 7200);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(8), 7200);

        var gia = await _app.SignInAsync($"gia_gif_pixels_{target ?? "chat"}");
        var info = target is null ? await UploadAsync(gia.Http, "huge.gif", bytes) : await UploadAsync(gia.Http, "huge.gif", bytes, ("target", target));
        Assert.Equal("error", info.GetProperty("type").GetString());
        Assert.Contains("too many pixels (7200 x 7200, max 50 megapixels)", info.GetProperty("error").GetString());
        Assert.False(IsStored(bytes));
    }

    // These three do not depend on ffmpeg: the names pass the create on every machine, and ImageSharp reads the bytes.
    [Theory(DisplayName = "Bytes that are not a picture never get a public URL, and the server keeps no copy of a refused file")]
    [InlineData("dot.png", null)]      // a plain upload: before the fix it was moved into the uploads folder as it came
    [InlineData("cat.gif", "gif")]     // marked as a GIF in the chat: before the fix it fell through "so the file isn't lost"
    [InlineData("cat.webp", "gif")]
    public async Task A_page_under_the_name_of_a_picture_is_refused(string name, string? kind)
    {
        var uma = await _app.SignInAsync($"uma_tus_{Path.GetExtension(name).TrimStart('.')}");
        var info = await UploadAsync(uma.Http, name, Page, kind is null ? Array.Empty<(string, string)>() : new[] { ("kind", kind) });

        Assert.Equal("error", info.GetProperty("type").GetString());
        Assert.False(info.TryGetProperty("url", out _));
        Assert.False(IsStored(Page));   // not in the public folder, and not left with tus either: the sweep of tus never removes a finished upload
    }

    [Fact(DisplayName = "A file marked as a GIF can have any name: the server converts its bytes, and the upload itself is never a public file")]
    public async Task A_gif_upload_is_converted_whatever_its_name_is()
    {
        var uma = await _app.SignInAsync("uma_tus_anim");
        (string, string)[] toLibrary = [("kind", "gif"), ("target", "user"), ("folder", "")];

        // A server without ffmpeg takes only .gif and .webp as a GIF, and refuses every other name at the create.
        if (!GifFfmpegHelper.IsAvailable)
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await CreateUploadAsync(uma.Http, "anim.apng", Apng.Length, toLibrary)).StatusCode);
            return;
        }

        // an animation in a format that no list names: it becomes a WebP of the server's own making
        var gif = await UploadAsync(uma.Http, "anim.apng", Apng, toLibrary);
        Assert.Equal("gif", gif.GetProperty("type").GetString());
        var entry = _app.Service<GifService>().GetEntry(gif.GetProperty("gifEntryId").GetGuid())!;
        Assert.EndsWith(".webp", entry.GifUrl);
        var served = await _app.CreateClient().GetAsync(entry.GifUrl);
        Assert.Equal(HttpStatusCode.OK, served.StatusCode);
        Assert.Equal("image/webp", served.Content.Headers.ContentType?.MediaType);
        Assert.False(IsStored(Apng));   // the upload was read where tus stored it, and is gone

        // a page under the name of a page: the conversion fails, and nothing of the file stays
        var page = await UploadAsync(uma.Http, "cat.htm", Page, toLibrary);
        Assert.Equal("error", page.GetProperty("type").GetString());
        Assert.False(IsStored(Page));
        Assert.Empty(Directory.GetFiles(_app.Service<UploadPaths>().Root, "*.htm*", SearchOption.AllDirectories));
    }

    [Fact(DisplayName = "An animated AVIF stays animated: the conversion takes the stream with the animation, not the still picture before it")]
    public async Task An_animated_avif_stays_animated()
    {
        var uma = await _app.SignInAsync("uma_tus_avif");
        if (!GifFfmpegHelper.IsAvailable) return;   // no conversion on this machine

        var gif = await UploadAsync(uma.Http, "two.avif", Avif, ("kind", "gif"), ("target", "user"), ("folder", ""));
        if (gif.GetProperty("type").GetString() == "error") return;   // an ffmpeg that cannot read AVIF: nothing to compare

        var entry = _app.Service<GifService>().GetEntry(gif.GetProperty("gifEntryId").GetGuid())!;
        using var webp = SixLabors.ImageSharp.Image.Load<SixLabors.ImageSharp.PixelFormats.Rgba32>(_app.Service<UploadPaths>().PathOf(entry.GifUrl!)!);
        var first = webp.Frames[0][8, 8];
        var last = webp.Frames[webp.Frames.Count - 1][8, 8];
        // Red at the start and blue at the end. Before the choice of the stream, every frame was the still picture: red.
        Assert.True(first.R > first.B, $"first frame: {first}");
        Assert.True(last.B > last.R, $"last frame: {last}");
    }

    [Fact(DisplayName = "/uploads serves the media files of the server and nothing else: a page in the folder has no URL, under any spelling")]
    public async Task Uploads_serve_media_files_only()
    {
        var uploads = _app.Service<UploadPaths>();
        var client = _app.CreateClient();
        // An absolute URL: a relative one that starts with two slashes names a host, not a path.
        Task<HttpResponseMessage> Get(string path) => client.GetAsync(new Uri($"https://localhost{path}"));

        // A page that is in the folder already, as one stored before the server checked the name of every upload.
        var page = $"{Guid.NewGuid():N}.html";
        File.WriteAllBytes(Path.Combine(uploads.Root, page), Page);
        // A file in the folder of tus, with the name of a picture: the folder is not public, whatever is in it.
        var part = $"{Guid.NewGuid():N}.png";
        File.WriteAllBytes(Path.Combine(uploads.TusTemp, part), Png);
        var picture = $"{Guid.NewGuid():N}.png";
        File.WriteAllBytes(Path.Combine(uploads.Root, picture), Png);

        // The doubled slash: the /uploads handler does not take such a path, and the handler of wwwroot took it,
        // because the uploads folder is inside wwwroot.
        foreach (var path in new[] { $"/uploads/{page}", $"//uploads/{page}", $"/uploads//{page}", $"/uploads/tus-temp/{part}", $"/uploads//tus-temp/{part}", $"//uploads/tus-temp/{part}", $"//uploads/{picture}" })
            Assert.Equal(HttpStatusCode.NotFound, (await Get(path)).StatusCode);

        var answer = await Get($"/uploads/{picture}");
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal("image/png", answer.Content.Headers.ContentType?.MediaType);
        Assert.Equal("nosniff", Assert.Single(answer.Headers.GetValues("X-Content-Type-Options")));
        // No "Content-Security-Policy: sandbox": some browsers do not play a video opened by its URL under it
        // (Program.cs), and a file of a media type runs no script.
        Assert.False(answer.Headers.Contains("Content-Security-Policy"));
    }

    [Fact(DisplayName = "NT-23, NT-24: a push subscription belongs to the account that registered it")]
    public async Task Push_subscriptions_belong_to_their_owner()
    {
        var pia = await _app.SignInAsync("pia_push");
        var pol = await _app.SignInAsync("pol_push");
        var endpoint = $"https://push.example.test/{Guid.NewGuid():N}";
        Assert.Equal(HttpStatusCode.OK, (await pia.Http.PostAsJsonAsync("/api/push/subscribe", new { username = "pia_push", endpoint, p256dh = "k", auth = "a" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await pia.Http.PostAsJsonAsync("/api/push/subscribe", new { username = "pia_push", endpoint = "http://push.example.test/plain", p256dh = "k", auth = "a" })).StatusCode);

        // another account: no take-over, no removal, not even through its own sign-out
        Assert.Equal(HttpStatusCode.Conflict, (await pol.Http.PostAsJsonAsync("/api/push/subscribe", new { username = "pol_push", endpoint, p256dh = "k", auth = "a" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await pol.Http.PostAsJsonAsync("/api/push/unsubscribe", new { endpoint })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await pol.Http.PostAsJsonAsync("/api/auth/signout", new { pushEndpoint = endpoint })).StatusCode);
        var devices = await pia.Http.GetFromJsonAsync<JsonElement>("/api/push/devices");
        Assert.Contains(devices.EnumerateArray(), d => d.GetProperty("endpoint").GetString() == endpoint);

        Assert.Equal(HttpStatusCode.OK, (await pia.Http.PostAsJsonAsync("/api/push/unsubscribe", new { endpoint })).StatusCode);
    }

    [Fact(DisplayName = "A proxy that is not trusted is reported: the admin status route and the bot's message to the admin")]
    public async Task Untrusted_proxy_is_reported_to_the_admin()
    {
        var admin = await _app.AdminAsync();
        var anyone = _app.CreateClient();
        anyone.DefaultRequestHeaders.Add("X-Test-Remote-Ip", "172.17.0.1");
        anyone.DefaultRequestHeaders.Add("X-Forwarded-For", "203.0.113.5");
        await anyone.GetAsync("/api/bootstrap");

        var proxy = (await admin.Http.GetFromJsonAsync<JsonElement>("/api/admin/status")).GetProperty("proxy");
        Assert.False(string.IsNullOrEmpty(proxy.GetProperty("untrustedPeer").GetString()));
        Assert.True(proxy.GetProperty("count").GetInt64() >= 1);

        var users = _app.Service<UserService>();
        var chat = _app.Service<ChatService>();
        var bot = _app.Service<Yap.Services.Chat.SystemBotService>();
        var adminId = users.GetByUsername(admin.Username)!.Id;
        var told = false;
        for (var tries = 0; tries < 20 && !told; tries++)
        {
            told = chat.DmChannelsOf(adminId).Where(c => bot.IsBotUser(c.Participant1 ?? "") || bot.IsBotUser(c.Participant2 ?? ""))
                .Any(c => chat.Tail(c.Id, 50, adminId).Messages.Any(m => m.Content.Contains("TrustedProxies")));
            if (!told) await Task.Delay(100);
        }
        Assert.True(told, "the bot did not tell the admin");
    }

    [Fact(DisplayName = "TL-05: a room's history cutoff applies to live events and quotes, not only to the history page")]
    public async Task History_cutoff_covers_live_events_and_quotes()
    {
        var chat = _app.Service<ChatService>();
        var users = _app.Service<UserService>();
        var owner = await _app.AdminAsync();
        var ownerId = users.GetByUsername(owner.Username)!.Id;
        var (room, error) = chat.CreateRoom(ownerId, "sincejoined", null, Yap.Models.Chat.ChannelPermission.Everyone, Yap.Models.Chat.HistoryLimit.Unlimited, sinceJoined: true);
        Assert.Null(error);
        var send = async (object body) => (await (await owner.Http.PostAsJsonAsync($"/api/channels/{room!.Id}/messages", body)).Content.ReadFromJsonAsync<MessageDto>())!;
        var old = await send(new { clientId = Guid.NewGuid(), text = "OLD SECRET" });
        await Task.Delay(50);   // the newcomer's account must be younger than the old message

        var newcomer = await _app.SignInAsync("newcomer_cutoff");
        var hub = await newcomer.ConnectAsync();
        var opened = await hub.InvokeAsync<Conversation>("OpenRoom", room!.Id);
        Assert.Empty(opened.Messages);
        Assert.True(opened.Restricted);
        var received = new List<(string Kind, string Text)>();
        var marker = new Expectation<bool>();
        hub.On<MessageDto>("messageEdited", m => { lock (received) received.Add(("edit", m.Text)); });
        hub.On<Guid, IReadOnlyList<ReactionGroupDto>>("reactions", (id, _) => { lock (received) received.Add(("reactions", id.ToString())); });
        hub.On<MessageDto>("message", m =>
        {
            lock (received) received.Add(("message", $"{m.Text}|{m.ReplyTo?.Text}|{m.ReplyTo?.Username}|{m.ReplyTo?.Unavailable}"));
            if (m.Text == "marker") marker.Set(true);
        });

        // the admin edits and reacts to the old message, replies to it, then posts a plain marker; a connection hears events in order
        var ownerHub = await owner.ConnectAsync();
        await ownerHub.InvokeAsync<Conversation>("OpenRoom", room.Id);
        var ownerEdit = new Expectation<string>();
        ownerHub.On<MessageDto>("messageEdited", m => { if (m.Id == old.Id) ownerEdit.Set(m.Text); });
        Assert.Null(await ownerHub.InvokeAsync<HubError?>("Edit", old.Id, "OLD SECRET EDITED"));
        Assert.Null(await ownerHub.InvokeAsync<HubError?>("React", old.Id, "👍"));
        var reply = await send(new { clientId = Guid.NewGuid(), text = "a reply", replyToId = old.Id });
        Assert.Equal("OLD SECRET EDITED", reply.ReplyTo!.Text);   // the admin's own answer carries the quote
        await send(new { clientId = Guid.NewGuid(), text = "marker" });
        await marker.Within();
        Assert.Equal("OLD SECRET EDITED", await ownerEdit.Within());   // a reader inside the cutoff still gets the edit

        lock (received)
        {
            Assert.DoesNotContain(received, r => r.Kind == "edit");
            Assert.DoesNotContain(received, r => r.Kind == "reactions");
            Assert.DoesNotContain(received, r => r.Text.Contains("SECRET"));
            Assert.Contains(received, r => r.Kind == "message" && r.Text.StartsWith("a reply||") && r.Text.EndsWith("|True"));   // the quote says unavailable, no text, no name
        }
        await hub.DisposeAsync(); await ownerHub.DisposeAsync();
    }

    [Fact(DisplayName = "AU-15: a person's login link carries that person's own address, never another caller's Host header")]
    public async Task Link_origin_is_the_persons_own()
    {
        var alice = await _app.SignInAsync("alice_origin");
        var eve = await _app.SignInAsync("eve_origin");
        Assert.Equal(HttpStatusCode.OK, (await alice.Http.PostAsync("/api/account/link", null)).StatusCode);
        var before = (await alice.Http.GetFromJsonAsync<JsonElement>("/api/account/link")).GetProperty("url").GetString()!;
        Assert.StartsWith("https://localhost/invite/", before);

        var forged = new HttpRequestMessage(HttpMethod.Get, "/api/bootstrap");
        forged.Headers.Host = "attacker.invalid";
        Assert.Equal(HttpStatusCode.OK, (await eve.Http.SendAsync(forged)).StatusCode);

        var after = (await alice.Http.GetFromJsonAsync<JsonElement>("/api/account/link")).GetProperty("url").GetString()!;
        Assert.Equal(before, after);   // Eve's word stays Eve's
        Assert.Equal(HttpStatusCode.OK, (await eve.Http.PostAsync("/api/account/link", null)).StatusCode);
        Assert.StartsWith("https://attacker.invalid/invite/", (await eve.Http.GetFromJsonAsync<JsonElement>("/api/account/link")).GetProperty("url").GetString());
    }

    [Fact(DisplayName = "AU-05: an approved registration is the requesting browser's; another requester cannot claim it")]
    public async Task Approved_registration_belongs_to_the_requester()
    {
        var gate = _app.Service<RegistrationGateService>();
        await _app.AdminAsync();
        await gate.SetRequireApprovalAsync(true);
        try
        {
            var requester = _app.CreateClient();   // keeps its cookies, as a browser does
            var asked = await requester.PostAsJsonAsync("/api/auth/signin", new { username = "approved_one" });
            Assert.Equal(HttpStatusCode.Accepted, asked.StatusCode);
            Assert.Contains(asked.Headers.GetValues("Set-Cookie"), c => c.StartsWith("yap_pending="));
            Assert.Equal("waiting", (await requester.GetFromJsonAsync<JsonElement>("/api/auth/pending/approved_one")).GetProperty("state").GetString());

            gate.ApproveUser("approved_one");

            var intruder = _app.CreateClient();
            Assert.Equal("waiting", (await intruder.GetFromJsonAsync<JsonElement>("/api/auth/pending/approved_one")).GetProperty("state").GetString());
            var claim = await intruder.PostAsJsonAsync("/api/auth/signin", new { username = "approved_one" });
            Assert.Equal(HttpStatusCode.Accepted, claim.StatusCode);
            Assert.False(claim.Headers.TryGetValues("Set-Cookie", out var cookies) && cookies.Any(c => c.StartsWith("yap_auth=")));

            Assert.Equal("approved", (await requester.GetFromJsonAsync<JsonElement>("/api/auth/pending/approved_one")).GetProperty("state").GetString());
            var signedIn = await requester.PostAsJsonAsync("/api/auth/signin", new { username = "approved_one" });
            Assert.Equal(HttpStatusCode.OK, signedIn.StatusCode);
            Assert.Contains(signedIn.Headers.GetValues("Set-Cookie"), c => c.StartsWith("yap_auth="));
        }
        finally { await gate.SetRequireApprovalAsync(false); }
    }

    [Fact(DisplayName = "PK-20: a provider GIF is sent from the server's own copy of an item it showed; an unknown item is refused")]
    public async Task Provider_item_must_have_been_shown()
    {
        var sender = await _app.SignInAsync("gina_provider");
        var lobby = _app.Service<ChatService>().LobbyId;
        var item = new
        {
            sourceId = "never-shown-" + Guid.NewGuid().ToString("N"), title = "x", width = 1, height = 1,
            formats = new[] { new { url = "http://127.0.0.1:9/secret.gif", contentType = "image/gif", width = 1, height = 1, sizeBytes = 1L } },
            previewFormats = Array.Empty<object>(), tags = Array.Empty<string>(),
        };
        var refused = await sender.Http.PostAsJsonAsync($"/api/channels/{lobby}/messages", new { clientId = Guid.NewGuid(), gifs = new[] { new { provider = item, searchText = (string?)null } } });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
    }

    [Fact(DisplayName = "AD-26: the IPv4 beacon nonce is minted by the hub for the caller's own connection only")]
    public async Task Beacon_nonce_needs_the_callers_connection()
    {
        var nina = await _app.SignInAsync("nina_beacon");
        var noel = await _app.SignInAsync("noel_beacon");
        var hub = await nina.ConnectAsync();
        await hub.InvokeAsync<Conversation>("OpenRoom", _app.Service<ChatService>().LobbyId);   // a call completes after the server's connect hook registered the session
        // The hub mints the nonce for the calling connection: a client that skips the negotiate step does not know
        // its connection id, so the bootstrap carries none (the resume work of 2026-10-22).
        Assert.False(string.IsNullOrEmpty(await hub.InvokeAsync<string?>("BeaconNonce")));
        var noelId = _app.Service<UserService>().GetByUsername("noel_beacon")!.Id;
        Assert.Null(_app.Service<PresenceService>().CreateBeaconNonce(hub.ConnectionId!, noelId));   // another person's id for that connection
        var bootstrap = await nina.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap");
        Assert.False(bootstrap.GetProperty("config").TryGetProperty("beaconNonce", out _));
        await hub.DisposeAsync();
    }
}
