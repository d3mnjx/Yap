using Microsoft.AspNetCore.ResponseCompression;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.FileProviders;
using Yap.Configuration;
using Yap.Endpoints;
using Yap.Helpers;
using Yap.Extensions;
using Yap.Middleware;
using Yap.Services;
using Yap.Services.Gifs;
using Yap.Services.Accounts;
using Yap.Services.Admin;
using Yap.Services.Chat;
using Yap.Services.Emoji;
using Yap.Services.Media;
using Yap.Services.Notifications;
using Yap.Services.Presence;

// The composition root: configuration, the singleton services, the middleware, the hub and the routes.
// The design is in docs/architecture/ (auth-and-program.md for this file).

var builder = WebApplication.CreateBuilder(args);

// No framework-level size limits: the real limit is enforced in the upload endpoint via ChatSettings:MaxUploadSizeMB.
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = null;
});
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = long.MaxValue;
});

// Load config from the Data folder if it exists (Docker deployment).
// It replaces the default appsettings.json entirely, to avoid .NET's array merge behaviour.
var dataConfigPath = Path.Combine(builder.Environment.ContentRootPath, "Data", "appsettings.json");
var dataDir = Path.GetDirectoryName(dataConfigPath)!;

// A fatal error leaves a trace next to the data, because the console is gone with the process. A Windows
// dev machine lost the process during uploads (2026-10-15) and no log survived it.
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    try { File.AppendAllText(Path.Combine(dataDir, $"crash-{DateTime.UtcNow:yyyy-MM-dd}.log"), $"{DateTime.UtcNow:O} terminating={e.IsTerminating}\n{e.ExceptionObject}\n\n"); }
    catch { /* nothing left to do */ }
};
if (Directory.Exists(dataDir) && !File.Exists(dataConfigPath))
{
    // Seed the Data folder with the default config so deployers have a template to edit.
    var defaultPath = Path.Combine(builder.Environment.ContentRootPath, "appsettings.json");
    if (File.Exists(defaultPath))
        File.Copy(defaultPath, dataConfigPath);
}
if (File.Exists(dataConfigPath))
{
    // The Data file takes the built-in file's place in the stack, not the top of it: environment
    // variables and the command line stay above it, so a deployment or a test can still override a key.
    var sources = builder.Configuration.Sources;
    var index = sources.ToList().FindIndex(s => s is Microsoft.Extensions.Configuration.Json.JsonConfigurationSource { Path: "appsettings.json" });
    var dataSource = new Microsoft.Extensions.Configuration.Json.JsonConfigurationSource { Path = dataConfigPath, Optional = false, ReloadOnChange = true };
    dataSource.ResolveFileProvider();
    if (index >= 0) { sources.RemoveAt(index); sources.Insert(index, dataSource); }
    else sources.Add(dataSource);
}

builder.Services.AddProblemDetails();

// Enums travel as camelCase strings on both JSON surfaces, the API and the hub ("away", not 1).
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));
builder.Services.AddSignalR()
    .AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)))
    .AddHubOptions<ChatHub>(o => o.AddFilter<HubLatencyFilter>());
builder.Services.AddSingleton<HubLatencyFilter>();

// Brotli or gzip for the shell, the scripts, the CSS and the JSON documents. On for https too: the
// pages carry no secret that a compression attack could read, and the deployment publishes Kestrel
// directly (docker-compose.yml), so no proxy compresses in its place.
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.MimeTypes = [.. ResponseCompressionDefaults.MimeTypes, "image/svg+xml", "application/manifest+json"];
});

// The sign-in cookie becomes a principal with the account id, the username and the admin role.
builder.Services.AddAuthentication(YapCookieAuthHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, YapCookieAuthHandler>(YapCookieAuthHandler.SchemeName, null);
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(YapCookieAuthHandler.AdminPolicy, policy => policy.RequireRole(YapCookieAuthHandler.AdminRole));

// Persistence (optional database support)
builder.Services.AddChatPersistence(builder.Configuration);
// A stop waits for the writer to put the queue and the coalesced read states on disk. The default grace is 30 s; a
// backlog of tens of thousands of writes needs more, and systemd's default stop timeout is 90 s, so 60 s fits under it.
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(60));

// Push subscription persistence (Json file or Database)
var pushStorage = builder.Configuration.GetValue<string>("ChatSettings:PushSubscriptionStorage") ?? "Json";
if (pushStorage.Equals("Database", StringComparison.OrdinalIgnoreCase))
    builder.Services.AddSingleton<IPushSubscriptionPersistence, DbPushSubscriptionPersistence>();
else
    builder.Services.AddSingleton<IPushSubscriptionPersistence, JsonPushSubscriptionPersistence>();

// Named HttpClient for link preview OG scraping
builder.Services.AddHttpClient("LinkPreview", client =>
{
    client.Timeout = TimeSpan.FromSeconds(10);
    // Use a real browser UA: some sites (YouTube especially) serve a bot/consent page with no
    // OpenGraph tags to non-browser user agents, so previews come back empty. Accept-Language
    // helps avoid region-based consent interstitials.
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-US,en;q=0.9");
    // No size cap here: the service streams the response and stops at </head> itself.
})
// A scraper must not keep cookies. YouTube sets a pending-consent cookie (SOCS) on the redirect
// hop of /shorts and youtu.be links; seeing it on the final request, it serves the "Before you
// continue" interstitial (no og: tags, wrong title) instead of the video page.
.FetchesPublicAddressesOnly(useCookies: false);

// Named HttpClient for pulling media files (TikTok slideshow images) straight from a CDN.
// The browser UA matters: TikTok's CDN rejects bare clients, and the caller adds the Referer.
builder.Services.AddHttpClient("MediaFetch", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
}).FetchesPublicAddressesOnly();

// Named HttpClient for the GIF provider (Klipy today). Shared for API requests + CDN downloads.
builder.Services.AddHttpClient("Klipy", client =>
{
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; YapBot/1.0)");
}).FetchesPublicAddressesOnly();   // the provider's item URLs are the client's words

// Chat services
builder.Services.AddSingleton<LinkPreviewSettingsService>();
builder.Services.AddSingleton<LinkPreviewService>();
builder.Services.AddSingleton<MediaCacheService>();
// GIF feature: registered before ChatService since ChatService depends on GifService.
builder.Services.AddSingleton<GifAdminSettingsService>();
builder.Services.AddSingleton<GifFfmpegHelper>();
builder.Services.AddSingleton<IGifSourceProvider, KlipyGifProvider>();
builder.Services.AddSingleton<GifService>();
builder.Services.AddSingleton<GeoLocationService>();
builder.Services.AddSingleton<CustomEmojiService>();
builder.Services.AddSingleton<EmojiImages>();
builder.Services.AddSingleton<UploadPaths>();
builder.Services.AddSingleton<MediaSizes>();   // picture and poster sizes, read from the files once: the row's box before the load
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<VideoService>();
builder.Services.AddSingleton<VideoPosterBackfill>();   // posters for the videos in memory that have none: the row's box
builder.Services.AddSingleton<VoiceService>();
builder.Services.AddSingleton<PushSubscriptionStore>();
builder.Services.AddSingleton<PushNotificationService>();
builder.Services.AddSingleton<PresenceService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PresenceService>());   // the 10 s presence sweep
builder.Services.AddSingleton<NotificationAudit>();  // Push + unread audit trails (admin diagnostics)
builder.Services.AddSingleton<UserService>();     // User management with token auth
builder.Services.AddSingleton<LinkTokenService>(); // PWA start_url login link tokens
builder.Services.AddSingleton<AccessLinkService>(); // invite / login links (/invite/{code})
builder.Services.AddSingleton<NotificationSettingsService>();  // per-channel mute rules (read by ChatService)
builder.Services.AddSingleton<ChatService>();
builder.Services.AddSingleton<MessageMapper>();   // the one mapping from a message to its wire shape
builder.Services.AddSingleton<ChatHubBroadcaster>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ChatHubBroadcaster>());   // service events -> hub messages
builder.Services.AddSingleton<SystemBotService>();
builder.Services.AddSingleton<AccountDeletionService>();   // the admin's account deletion, across every service that knows a person (AD-39)
builder.Services.AddSingleton<RegistrationGateService>();
builder.Services.AddSingleton<SignInService>();
builder.Services.AddSingleton<ServerConfig>();

// Request logging
builder.Services.AddSingleton<RequestLogQueue>();
builder.Services.AddHostedService<RequestLogWriter>();

builder.Services.AddSingleton<UserActionLogService>();
builder.Services.AddSingleton<MediaUploadLogService>();
builder.Services.AddSingleton<MediaCleanupService>();

// Diagnostics collector (captures snapshots every 30s for admin charts)
builder.Services.AddSingleton<DiagnosticsCollectorService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DiagnosticsCollectorService>());
builder.Services.AddSingleton<LoadCounters>();          // bumped by the hub broadcaster, the request middleware and the presence sweep
builder.Services.AddSingleton<LoadMetrics>();           // 1 s samples for GET /api/admin/load (stress tests)
builder.Services.AddHostedService(sp => sp.GetRequiredService<LoadMetrics>());
builder.Services.AddHostedService<TusCleanupService>();   // expired unfinished uploads leave the disk
builder.Services.AddSingleton<ProxyWatch>();              // the notice about a proxy that is not trusted
builder.Services.AddSingleton<CloudflareIps>();           // Cloudflare's ranges: the one proxy trusted without a listing (IpHelper)
builder.Services.AddHostedService<CloudflareIpsRefresh>();
builder.Services.AddHttpClient("Cloudflare", client => client.Timeout = TimeSpan.FromSeconds(15));

// CORS for upload subdomain (tus uploads may come from a different origin)
builder.Services.AddCors(options =>
{
    options.AddPolicy("TusUpload", policy =>
    {
        policy.SetIsOriginAllowed(_ => true) // Allow any origin (app serves both domains)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials()
              .WithExposedHeaders("Upload-Offset", "Upload-Length", "Tus-Resumable", "Location");
    });
});

var app = builder.Build();

// Fill memory from the database, in dependency order: users first (channels and links point at them),
// mute rules before the chat (unread counting reads them), the bot last (it subscribes to the others).
await app.Services.InitializePersistenceAsync();   // migrations
await app.Services.GetRequiredService<UserService>().LoadUsersAsync();
await app.Services.GetRequiredService<AccessLinkService>().LoadAsync();
await app.Services.GetRequiredService<NotificationSettingsService>().InitializeAsync();
await app.Services.GetRequiredService<ChatService>().InitializeAsync();
app.Services.GetRequiredService<VideoService>();   // the ffmpeg probe (a child process, up to 3 s) runs here, not inside the first upload
app.Services.GetRequiredService<VoiceService>();   // its ffmpeg detection (the GIF helper's) must be done before the first voice upload is judged
await app.Services.GetRequiredService<GifService>().InitializeAsync();
app.Services.GetRequiredService<ChatService>().RefreshPinMedia();   // after the GIF entries: a pinned GIF resolves through them
app.Services.GetRequiredService<VideoPosterBackfill>().Start();   // after the pins: it refreshes them again when it makes a poster
await app.Services.GetRequiredService<PushSubscriptionStore>().InitializeAsync();
await app.Services.GetRequiredService<SystemBotService>().InitializeAsync();

// Clean up old action logs (keep last 100 per user, delete older than 6 months)
await app.Services.GetRequiredService<UserActionLogService>().CleanupAsync();

var uploads = app.Services.GetRequiredService<UploadPaths>();

// Clear the uploads folder on start when asked. Off when the key is absent: a config without it must not delete files.
if (builder.Configuration.GetValue<bool>("ChatSettings:ClearUploadsOnStart", false))
{
    var uploadsPath = uploads.Root;
    if (Directory.Exists(uploadsPath))
    {
        foreach (var file in Directory.GetFiles(uploadsPath))
        {
            try { File.Delete(file); } catch { /* ignore errors */ }
        }
    }
}

// Configure the HTTP request pipeline.
// First: the proxies in ChatSettings:TrustedProxies may say who the client is and which scheme it used. A forwarded
// header from any other peer stays on the request, and IpHelper then reports the address as unknown (AU-09).
// Cloudflare is the exception: IpHelper knows its ranges and reads CF-Connecting-IP behind a Cloudflare hop.
app.UseForwardedHeaders(TrustedProxies.Options(builder.Configuration));
var proxyWatch = app.Services.GetRequiredService<ProxyWatch>();
if (proxyWatch.Trusted.Count > 0) app.Logger.LogInformation("Trusted proxies: {Proxies}", string.Join(", ", proxyWatch.Trusted));
else app.Logger.LogWarning("Trusted proxies: none. Behind a reverse proxy (Caddy, nginx, Cloudflare) list it in ChatSettings:TrustedProxies; until then every client address counts as unknown and smart login is off");
// The notice reaches the admin in three places: this log, the bot's message, and the admin page (ProxyWatch).
app.Use(async (context, next) =>
{
    if (proxyWatch.Note(context))   // the first request with a forwarded header from a peer that is not trusted
    {
        app.Logger.LogWarning("A request from {Peer} carries X-Forwarded-For {ForwardedFor}, and that peer is not in ChatSettings:TrustedProxies. Client addresses count as unknown and smart login is off until the proxy is listed", proxyWatch.UntrustedPeer, proxyWatch.ForwardedFor);
        app.Services.GetRequiredService<SystemBotService>().NotifyAdminOfUntrustedProxy();
    }
    await next();
});
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler();   // ProblemDetails; there is no error page any more
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}
app.UseCors();
app.UseHttpsRedirection();
app.UseResponseCompression();

// Serve custom branding overrides from Data/branding/ (favicon, PWA icons, etc.)
// Files here override same-named files from wwwroot, no rebuild needed.
// Registered before every static file handler so it wins.
// Exception: manifest.webmanifest is never served raw, see the skip below.
var brandingPath = Path.Combine(app.Environment.ContentRootPath, "Data", "branding");
Directory.CreateDirectory(brandingPath);
var brandingProvider = new PhysicalFileProvider(brandingPath);
var brandingContentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
app.Use(async (context, next) =>
{
    // The manifest is exempt: it's generated by MapPwaEndpoints (tokenized start_url for
    // the PWA login hand-off), which merges Data/branding/manifest.webmanifest itself.
    // Serving the raw file from here would strip the token.
    if (context.Request.Path != "/manifest.webmanifest")
    {
        var fileInfo = brandingProvider.GetFileInfo(context.Request.Path.Value ?? "");
        if (fileInfo.Exists && !fileInfo.IsDirectory && fileInfo.PhysicalPath != null
            && brandingContentTypes.TryGetContentType(fileInfo.Name, out var contentType))
        {
            context.Response.ContentType = contentType;
            context.Response.ContentLength = fileInfo.Length;
            await context.Response.SendFileAsync(fileInfo.PhysicalPath);
            return;
        }
    }
    await next();
});

// Content-addressed uploads use GUID/hash filenames that are never reused, so they are safe to cache forever.
// immutable = the browser never revalidates; max-age is the fallback for browsers that don't support immutable.
Action<Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext> cacheImmutable = ctx =>
    ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";

var uploadsRoot = uploads.Root;
var profilesRoot = uploads.Profiles;
Directory.CreateDirectory(profilesRoot); // PhysicalFileProvider throws if the root is missing

// The unfinished uploads of tus live under the uploads root (tus-temp); nothing there is ever a public file.
app.Use((context, next) =>
{
    if (!context.Request.Path.StartsWithSegments("/uploads/" + UploadPaths.TusTempFolder)) return next();
    context.Response.StatusCode = StatusCodes.Status404NotFound;
    return Task.CompletedTask;
});

// Profile pictures live at a STABLE path (/uploads/profiles/{userId}.webp) that's overwritten when
// the avatar changes, so they must NOT be immutable. The stored URL carries ?v=<upload time>, so a new
// picture is a new URL for every client (ImageService). The short max-age covers a client that still
// holds the old URL.
// Registered before the general /uploads handler so it wins for the profiles subtree.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(profilesRoot),
    RequestPath = "/uploads/profiles",
    OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=300"
});

// Everything else under /uploads (image thumbnails, gif/webp, video posters, voice messages) is content-addressed.
// Registered before the generic UseStaticFiles so it wins for /uploads/* and attaches the header.
var uploadContentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
uploadContentTypes.Mappings[".m4a"] = "audio/mp4";   // voice messages (VoiceService); spelled out so the answer never depends on the default map
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadsRoot),
    RequestPath = "/uploads",
    ContentTypeProvider = uploadContentTypes,
    OnPrepareResponse = ctx =>
    {
        cacheImmutable(ctx);
        // A file that a person uploaded is never a page of this site. nosniff: the browser takes the type from the
        // extension, which the server checked (TusEndpoints), and does not guess one from the bytes. sandbox: a file
        // opened by its URL runs no script and gets no access to the site's cookie and API. This holds also for a
        // file stored before the server checked the extension of every upload.
        ctx.Context.Response.Headers.XContentTypeOptions = "nosniff";
        ctx.Context.Response.Headers.ContentSecurityPolicy = "sandbox";
    }
});

// Built-in emoji packs (wwwroot/emoji-packs/{pack}/) ship in the build output at a STABLE url, so
// they must NOT be immutable: redrawing one has to propagate on the next deploy. A day of max-age
// still stops the per-image revalidation that every picker render would otherwise trigger.
// This header reaches only a browser without the worker (the first visit, workers off) and the
// worker's own fetch on a miss. The service worker (service-worker.js, EMOJI_CACHE) answers these
// paths cache-first and never revalidates, so a device that has an image keeps the old drawing
// until EMOJI_CACHE gets a new name or the pack URLs carry a stamp. A redraw alone does not propagate.
var emojiPacksPath = Path.Combine(app.Environment.WebRootPath, "emoji-packs");
Directory.CreateDirectory(emojiPacksPath); // PhysicalFileProvider throws if the root is missing
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(emojiPacksPath),
    RequestPath = "/emoji-packs",
    OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=86400"
});

// A script or stylesheet URL with the build stamp (?v=, written by the import map and the page) never changes its
// content: immutable, so the browser and a Cloudflare edge keep it for a year. A bare URL (an old page's late import)
// revalidates on every load, as before, so it is never stale. The fonts are immutable by file name: a changed font
// needs a new name, see the @font-face comment in app.css. Icons, images and the sound keep the default (an ETag);
// the service worker answers them from its cache.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        var name = ctx.File.Name;
        if (name.EndsWith(".js") || name.EndsWith(".css"))
            ctx.Context.Response.Headers.CacheControl = ctx.Context.Request.Query.ContainsKey("v") ? "public, max-age=31536000, immutable" : "no-cache";
        else if (name.EndsWith(".woff2"))
            ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    }
});

// Serve custom emojis from Data/custom-emojis/ folder
var customEmojisPath = Path.Combine(app.Environment.ContentRootPath, "Data", "custom-emojis");
Directory.CreateDirectory(customEmojisPath);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(customEmojisPath),
    RequestPath = "/custom-emojis"
});

// Serve welcome page assets from Data/welcome/ folder
var welcomePath = Path.Combine(app.Environment.ContentRootPath, "Data", "welcome");
Directory.CreateDirectory(welcomePath);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(welcomePath),
    RequestPath = "/welcome-content"
});

// Serve cached media from Data/media-cache/ folder
var mediaCachePath = Path.Combine(app.Environment.ContentRootPath, "Data", "media-cache");
Directory.CreateDirectory(mediaCachePath);
var mediaCacheContentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
mediaCacheContentTypes.Mappings[".opus"] = "audio/ogg";
mediaCacheContentTypes.Mappings[".m4a"] = "audio/mp4";
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(mediaCachePath),
    RequestPath = "/media-cache",
    ContentTypeProvider = mediaCacheContentTypes,
    OnPrepareResponse = cacheImmutable
});

// Serve cached GIFs from Data/gif-cache/ folder (separate from user uploads so eviction can sweep it)
var gifCachePath = Path.Combine(app.Environment.ContentRootPath, "Data", "gif-cache");
Directory.CreateDirectory(gifCachePath);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(gifCachePath),
    RequestPath = "/gif-cache",
    OnPrepareResponse = cacheImmutable
});

// Custom middlewares, positioned after UseStaticFiles() to skip static file requests
app.UseAuthentication();
app.UseAuthorization();
app.UseMiddleware<RequestLoggingMiddleware>();

app.MapHub<ChatHub>("/hub");
app.MapSignIn();

var api = app.MapGroup("/api").RequireAuthorization();
api.MapBootstrap();   // anonymous inside: it answers both states
api.MapRooms();
api.MapMessages();
api.MapAccount();
api.MapGifs();

// These map their own full paths (/api/tus, /api/push, and the PWA files at the root), so they take the app, not the /api group.
app.MapTusEndpoints();
app.MapPushEndpoints();
app.MapPwaEndpoints();
app.MapAdminEndpoints();
app.MapBeaconEndpoints();
app.MapShell();   // last: the client routes, every one answering index.html

app.Run();

// The test project hosts the app through WebApplicationFactory<Program>, which needs this type to be public.
public partial class Program { }
