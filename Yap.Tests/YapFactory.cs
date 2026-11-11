using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Yap.Tests;

/// <summary>
/// Hosts the whole application in memory, with its own empty content root, so a test never touches the
/// repository's Data folder. Persistence is off unless a test turns it on with a temporary database.
/// Without a database the first account becomes the admin (AU-06); <see cref="AdminAsync"/> makes sure
/// that account is always the same one, whatever test runs first.
/// </summary>
public class YapFactory : WebApplicationFactory<Program>
{
    // The in-memory server has no TLS, but the auth cookie is Secure, and a cookie container never sends a
    // Secure cookie over http. An https base address makes the test server see https requests.
    public static readonly Uri BaseAddress = new("https://localhost");

    public string ContentRoot { get; } = Directory.CreateTempSubdirectory("yap-test-").FullName;
    public string? SqlitePath { get; init; }
    public Dictionary<string, string> Settings { get; init; } = [];   // configuration keys a test sets on top

    public YapFactory() => ClientOptions.BaseAddress = BaseAddress;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(Path.Combine(ContentRoot, "wwwroot"));
        Directory.CreateDirectory(Path.Combine(ContentRoot, "Data"));
        builder.UseContentRoot(ContentRoot);
        builder.UseWebRoot(Path.Combine(ContentRoot, "wwwroot"));
        builder.UseSetting("ChatSettings:Persistence:Enabled", SqlitePath is null ? "false" : "true");
        if (SqlitePath is not null)
            builder.UseSetting("ChatSettings:Persistence:ConnectionStrings:SQLite", $"Data Source={SqlitePath}");
        builder.UseSetting("ChatSettings:ClearUploadsOnStart", "false");
        builder.UseSetting("ChatSettings:Bot:Enabled", "true");
        builder.UseSetting("ChatSettings:CloudflareIpsUrl", "");   // a test never reaches the network; the built-in ranges serve
        builder.UseSetting("Logging:LogLevel:Default", "Warning");
        foreach (var (key, value) in Settings) builder.UseSetting(key, value);
        builder.ConfigureServices(services => services.AddSingleton<IStartupFilter, TestRemoteIp>());
    }

    public T Service<T>() where T : notnull => Services.GetRequiredService<T>();

    private Task<SignedIn>? _admin;

    /// <summary>The admin of this instance: the first account created (AU-06).</summary>
    public Task<SignedIn> AdminAsync() => _admin ??= SignInCoreAsync("boss");

    /// <summary>A client that holds its cookies, signed in as a new account. Never the admin.</summary>
    public async Task<SignedIn> SignInAsync(string username)
    {
        await AdminAsync();   // the admin slot is taken first, so this account is an ordinary one
        return await SignInCoreAsync(username);
    }

    private async Task<SignedIn> SignInCoreAsync(string username)
    {
        var client = CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/signin", new { username });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var cookie = response.Headers.GetValues("Set-Cookie").First(c => c.StartsWith("yap_auth="));
        var token = cookie.Split(';')[0]["yap_auth=".Length..];
        return new SignedIn(this, client, username, token);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { Directory.Delete(ContentRoot, recursive: true); } catch { /* a temp folder; the OS cleans it */ }
    }
}

/// <summary>The in-memory server has no network peer, and the forwarded-headers middleware trusts the first forwarded
/// entry when the peer is unknown (a Unix socket behind a proxy). A test names the peer with the X-Test-Remote-Ip
/// header; this filter sets it ahead of the application's pipeline, as Kestrel sets it from the socket.</summary>
sealed class TestRemoteIp : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, nextMiddleware) =>
        {
            if (IPAddress.TryParse(context.Request.Headers["X-Test-Remote-Ip"], out var ip)) context.Connection.RemoteIpAddress = ip;
            return nextMiddleware(context);
        });
        next(app);
    };
}

/// <summary>One signed-in person: an HTTP client with the cookie, and hub connections on demand.</summary>
public sealed class SignedIn(YapFactory factory, HttpClient http, string username, string token)
{
    public HttpClient Http => http;
    public string Username => username;
    public string Token => token;   // for a second host on the same database: the cookie survives a restart

    public async Task<HubConnection> ConnectAsync(string device = "device-1")
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(YapFactory.BaseAddress, $"/hub?device={device}"), options =>
            {
                options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                options.Headers["Cookie"] = $"yap_auth={token}";
                options.Transports = HttpTransportType.LongPolling;   // WebSockets do not run through the in-memory handler
            })
            .Build();
        await connection.StartAsync();
        return connection;
    }
}

/// <summary>A hub message a test waits for.</summary>
public sealed class Expectation<T>
{
    private readonly TaskCompletionSource<T> _source = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public void Set(T value) => _source.TrySetResult(value);
    public bool Completed => _source.Task.IsCompleted;
    public async Task<T> Within(int seconds = 10)
    {
        var done = await Task.WhenAny(_source.Task, Task.Delay(TimeSpan.FromSeconds(seconds)));
        Assert.True(done == _source.Task, $"No {typeof(T).Name} arrived within {seconds} s");
        return await _source.Task;
    }
}
