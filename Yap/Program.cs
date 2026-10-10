using Yap.Offline;
using System.Net;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Components.Server;
using Microsoft.AspNetCore.Components.Server.Circuits;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.FileProviders;
using Yap.Components;
using Yap.Endpoints;
using Yap.Extensions;
using Yap.Middleware;
using Yap.Services;
using Yap.Services.Gifs;

var builder = WebApplication.CreateBuilder(args);

// Deployments use different proxies and dynamic container addresses. Accept forwarded
// scheme/client IP by default; an explicit address/network list opts into restricted trust.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    // Keep dynamic proxy chains working, but never let X-Forwarded-Host choose a login-link host.
    // Only the nearest hop supplies scheme/IP; PublicOrigin handles proxies that hide the public Host.
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.ForwardLimit = 1;
    var proxies = builder.Configuration.GetSection("ReverseProxy:KnownProxies").Get<string[]>() ?? [];
    var networks = builder.Configuration.GetSection("ReverseProxy:KnownNetworks").Get<string[]>() ?? [];
    if (proxies.Length == 0 && networks.Length == 0)
    {
        options.KnownProxies.Clear();
        options.KnownIPNetworks.Clear();
    }
    foreach (var address in proxies)
        options.KnownProxies.Add(IPAddress.Parse(address));
    foreach (var network in networks)
        options.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
});

// No framework-level size limits — actual limit enforced in upload endpoint via ChatSettings:MaxUploadSizeMB
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = null;
});
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = long.MaxValue;
});

// Load config from Data folder if exists (for Docker deployment)
// Replaces the default appsettings.json entirely to avoid .NET's array merge behavior
var dataConfigPath = Path.Combine(builder.Environment.ContentRootPath, "Data", "appsettings.json");
var dataDir = Path.GetDirectoryName(dataConfigPath)!;
if (Directory.Exists(dataDir) && !File.Exists(dataConfigPath))
{
    // Seed the Data folder with default config so deployers have a template to edit
    var defaultPath = Path.Combine(builder.Environment.ContentRootPath, "appsettings.json");
    if (File.Exists(defaultPath))
        File.Copy(defaultPath, dataConfigPath);
}
if (File.Exists(dataConfigPath))
{
    var defaultSource = builder.Configuration.Sources
        .OfType<Microsoft.Extensions.Configuration.Json.JsonConfigurationSource>()
        .FirstOrDefault(s => s.Path == "appsettings.json");
    if (defaultSource != null)
        builder.Configuration.Sources.Remove(defaultSource);

    builder.Configuration.AddJsonFile(dataConfigPath, optional: false, reloadOnChange: true);
}

// =============================================================================
// BLAZOR SERVER CIRCUIT CONFIGURATION (.NET 10)
// =============================================================================
// Blazor Server uses "circuits" to maintain state for each connected user.
// When the WebSocket connection drops (e.g., user closes laptop), the circuit
// becomes "disconnected" but is kept alive for a grace period.
//
// There are TWO retention periods to understand:
// 1. DisconnectedCircuitRetentionPeriod - How long the circuit stays "warm"
//    waiting for the SAME WebSocket to reconnect (default: 3 minutes)
// 2. PersistedCircuitInMemoryRetentionPeriod - How long the STATE is kept
//    AFTER the circuit is evicted, allowing a NEW circuit to restore it
//    via Blazor.resumeCircuit() (default: 2 hours)
// =============================================================================

var presenceOptions = builder.Configuration.GetSection("Presence").Get<PresenceOptions>() ?? new();
presenceOptions.Validate();
builder.Services.AddSingleton(presenceOptions);
builder.Services.AddSingleton(TimeProvider.System);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        // Keep component state warm for reconnects (e.g. laptop sleep/app switching).
        // Presence uses the same configured circuit retention; hub sessions have no state
        // to resume and use their own, shorter retention.
        options.DisconnectedCircuitRetentionPeriod = presenceOptions.CircuitRetention;

        // Maximum number of disconnected circuits to retain (default: 100).
        // Increase this if you expect many concurrent users going idle.
        options.DisconnectedCircuitMaxRetained = 1000;

        // Show detailed errors in browser console (useful for debugging)
        options.DetailedErrors = builder.Environment.IsDevelopment() || builder.Configuration.GetValue<bool>("DetailedErrors");
    })
    // =============================================================================
    // PERSISTENT SERVICES (.NET 10)
    // =============================================================================
    // RegisterPersistentService tells Blazor to automatically persist properties
    // marked with [PersistentState] when a circuit is evicted. When the user
    // reconnects and calls Blazor.resumeCircuit(), these properties are restored.
    // This allows users to "resume" their session even after long disconnections.
    // =============================================================================
    .RegisterPersistentService<UserStateService>(RenderMode.InteractiveServer)
    .RegisterPersistentService<ChatNavigationState>(RenderMode.InteractiveServer);

// =============================================================================
// PERSISTED CIRCUIT STATE RETENTION (.NET 10)
// =============================================================================
// After a circuit is evicted (disconnected longer than DisconnectedCircuitRetentionPeriod),
// the [PersistentState] data is still kept in memory for this duration.
// This is separate from the circuit itself - it's just the serialized state.
// =============================================================================
builder.Services.Configure<CircuitOptions>(options =>
{
    // Keep persisted state for 24 hours (default: 2 hours).
    // This means a user can close their browser, come back the next day,
    // and still have their username/navigation state restored.
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(48);

    // Maximum number of persisted states to keep (default: 1000).
    options.PersistedCircuitInMemoryMaxRetained = 5000;
});

// Persistence (optional database support)
builder.Services.AddChatPersistence(builder.Configuration);

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
.ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { UseCookies = false });

// Named HttpClient for pulling media files (TikTok slideshow images) straight from a CDN.
// The browser UA matters: TikTok's CDN rejects bare clients, and the caller adds the Referer.
builder.Services.AddHttpClient("MediaFetch", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
});

// Named HttpClient for the GIF provider (Klipy today). Shared for API requests + CDN downloads.
builder.Services.AddHttpClient("Klipy", client =>
{
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; YapBot/1.0)");
});

// Chat services
builder.Services.AddSingleton<LinkPreviewSettingsService>();
builder.Services.AddSingleton<LinkPreviewService>();
builder.Services.AddSingleton<MediaCacheService>();
// GIF feature — registered before ChatService since ChatService depends on GifService.
builder.Services.AddSingleton<GifAdminSettingsService>();
builder.Services.AddSingleton<GifFfmpegHelper>();
builder.Services.AddSingleton<IGifSourceProvider, KlipyGifProvider>();
builder.Services.AddSingleton<GifService>();
builder.Services.AddSingleton<GeoLocationService>();
builder.Services.AddSingleton<CustomEmojiService>();
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<VideoService>();
builder.Services.AddSingleton<PushSubscriptionStore>();
builder.Services.AddSingleton<PushNotificationService>();
builder.Services.AddSingleton<CircuitTracker>();  // Circuit diagnostics
builder.Services.AddSingleton<NotificationAudit>();  // Push + unread audit trails (admin diagnostics)
builder.Services.AddSingleton<UserService>();     // User management with token auth
builder.Services.AddSingleton<LinkTokenService>(); // PWA start_url login link tokens
builder.Services.AddSingleton<AccessLinkService>(); // invite / login links (/invite/{code})
builder.Services.AddSingleton<NotificationSettingsService>();  // per-channel mute rules (read by ChatService)
builder.Services.AddSingleton<ChatService>();
builder.Services.AddSignalR();
builder.Services.AddAntiforgery(options => options.HeaderName = "X-CSRF-TOKEN");
builder.Services.AddSingleton<OfflineSnapshotService>();
builder.Services.AddSingleton<OfflineSync>();
builder.Services.AddSingleton<ChatLimits>();
builder.Services.AddSingleton<OfflineChangeSignal>();
builder.Services.AddSingleton<OfflineFanout>();
builder.Services.AddSingleton<OfflineLiveService>();
builder.Services.AddHostedService<OfflineLiveCleanup>();
builder.Services.AddSingleton<SystemBotService>();
builder.Services.AddSingleton<RegistrationGateService>();
builder.Services.AddSingleton<ChatConfigService>();
builder.Services.AddScoped<EmojiService>();
builder.Services.AddScoped<UserStateService>();
builder.Services.AddScoped<ChatNavigationState>();
builder.Services.AddScoped<CircuitHandler, ChatCircuitHandler>();
builder.Services.AddScoped<CircuitIdentity>();    // circuit-id bridge so components can report per-circuit telemetry

// HTTP context accessor (for device detection in Blazor components)
builder.Services.AddHttpContextAccessor();

// Request logging
builder.Services.AddSingleton<RequestLogQueue>();
builder.Services.AddHostedService<RequestLogWriter>();

// User action logging (queued, flushed to database periodically)
builder.Services.AddSingleton<UserActionLogService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<UserActionLogService>());

// Media upload logging (queued, flushed to database periodically)
builder.Services.AddSingleton<MediaUploadLogService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MediaUploadLogService>());

// Diagnostics collector (captures snapshots every 30s for admin charts)
builder.Services.AddSingleton<DiagnosticsCollectorService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DiagnosticsCollectorService>());

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

builder.Services.AddSingleton<Microsoft.AspNetCore.Routing.MatcherPolicy, ChatRootPolicy>();
builder.Services.AddSingleton<AuthCookieRenewal>();
var app = builder.Build();

// Initialize persistence (migrations + load data) if enabled
await app.Services.InitializePersistenceAsync();

// Initialize users from database (must be before ChatService.InitializeAsync)
await app.Services.GetRequiredService<UserService>().LoadUsersAsync();

// Invite / login links (after users, which the rows point at; before the bot, which subscribes to the brake)
await app.Services.GetRequiredService<AccessLinkService>().LoadAsync();

// Initialize GIF library (warm in-memory index from DB)
await app.Services.GetRequiredService<GifService>().InitializeAsync();

// Load push subscriptions from database
await app.Services.GetRequiredService<PushSubscriptionStore>().InitializeAsync();

// Initialize system bot (must be after UserService + ChatService)
await app.Services.GetRequiredService<SystemBotService>().InitializeAsync();

// Start shared revision/profile subscriptions before the first bootstrap or hub connection.
_ = app.Services.GetRequiredService<OfflineFanout>();

// Clean up old action logs (keep last 100 per user, delete older than 6 months)
await app.Services.GetRequiredService<UserActionLogService>().CleanupAsync();

// Clear uploads folder on start if configured
if (builder.Configuration.GetValue<bool>("ChatSettings:ClearUploadsOnStart", true))
{
    var uploadsPath = Path.Combine(app.Environment.WebRootPath, "uploads");
    if (Directory.Exists(uploadsPath))
    {
        foreach (var file in Directory.GetFiles(uploadsPath))
        {
            try { File.Delete(file); } catch { /* ignore errors */ }
        }
    }
}

// Configure the HTTP request pipeline.
app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}
app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
app.UseCors();
app.UseHttpsRedirection();
app.UseAntiforgery();

app.Use(async (context, next) =>
{
    // These stable URLs change between releases. The worker owns offline caching; browser
    // and CDN caches must revalidate so an upgrade/rollback can replace that worker promptly.
    if (context.Request.Path is var assetPath && (assetPath == "/service-worker.js" || assetPath == "/service-worker-module.js" || assetPath.StartsWithSegments("/chat-client")))
        context.Response.OnStarting(() => { context.Response.Headers.CacheControl = context.Request.Path == "/chat-client/manifest.json" ? "no-store" : "no-cache"; return Task.CompletedTask; });
    await next(context);
});

// Serve custom branding overrides from Data/branding/ (favicon, PWA icons, etc.)
// Files here override same-named files from wwwroot — no rebuild needed.
// Uses raw middleware to guarantee priority over MapStaticAssets in production.
// Exception: manifest.webmanifest is never served raw — see the skip below.
var brandingPath = Path.Combine(app.Environment.ContentRootPath, "Data", "branding");
Directory.CreateDirectory(brandingPath);
var brandingProvider = new PhysicalFileProvider(brandingPath);
var brandingContentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
app.Use(async (context, next) =>
{
    // The manifest is exempt: it's generated by MapPwaEndpoints (tokenized start_url for
    // the PWA login hand-off), which merges Data/branding/manifest.webmanifest itself —
    // serving the raw file from here would strip the token.
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

// Content-addressed uploads use GUID/hash filenames that are never reused → safe to cache forever.
// immutable = the browser never revalidates; max-age is the fallback for browsers that don't
// support immutable (the same policy .NET applies to its own fingerprinted assets).
Action<Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext> cacheImmutable = ctx =>
    ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";

var uploadsRoot = Path.Combine(app.Environment.WebRootPath, "uploads");
var profilesRoot = Path.Combine(uploadsRoot, "profiles");
Directory.CreateDirectory(profilesRoot); // PhysicalFileProvider throws if the root is missing

// Profile pictures live at a STABLE url (/uploads/profiles/{userId}.webp) that's overwritten when
// the avatar changes, so they must NOT be immutable. Short max-age = fast reuse + quick propagation.
// Registered before the general /uploads handler so it wins for the profiles subtree.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(profilesRoot),
    RequestPath = "/uploads/profiles",
    OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=300"
});

// Everything else under /uploads (image thumbnails, gif/webp, video posters) is content-addressed.
// Registered before the generic UseStaticFiles so it wins for /uploads/* and attaches the header.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadsRoot),
    RequestPath = "/uploads",
    OnPrepareResponse = cacheImmutable
});

// Built-in emoji packs (wwwroot/emoji-packs/{pack}/) ship in the build output at a STABLE url, so
// they must NOT be immutable — redrawing one has to propagate on the next deploy. A day of max-age
// still kills the per-image revalidation that every picker render would otherwise trigger.
var emojiPacksPath = Path.Combine(app.Environment.WebRootPath, "emoji-packs");
Directory.CreateDirectory(emojiPacksPath); // PhysicalFileProvider throws if the root is missing
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(emojiPacksPath),
    RequestPath = "/emoji-packs",
    OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=86400"
});

app.UseStaticFiles();

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

// Custom middlewares - positioned after UseStaticFiles() to skip static file requests
// Reuse the legacy cookie, validating both handshake and long-lived stream.
app.Use(async (context, next) =>
{
    if (ChatRoutes.IsApi(context.Request.Path) || ChatRoutes.IsHub(context.Request.Path))
    {
        var statusPages = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IStatusCodePagesFeature>();
        if (statusPages != null) statusPages.Enabled = false;
        if (ChatRoutes.IsApi(context.Request.Path) && HttpMethods.IsPost(context.Request.Method))
        {
            var sizeLimit = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (sizeLimit is { IsReadOnly: false }) sizeLimit.MaxRequestBodySize = context.RequestServices.GetRequiredService<ChatLimits>().MaxPostBytes;
        }
    }
    if (ChatRoutes.IsHub(context.Request.Path))
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!ChatProtocol.Accepts(context.Request, hub: true))
        { context.Response.StatusCode = 426; await context.Response.WriteAsJsonAsync(new { code = "update_required" }); return; }
        // Browser metadata survives proxy URL rewriting. Missing metadata is accepted
        // for older clients; every hub request still requires a valid account cookie.
        if (context.Request.Headers["Sec-Fetch-Site"] == "cross-site")
        { context.Response.StatusCode = 403; return; }
        var token = context.Request.Cookies[AuthMiddleware.CookieName] ?? "";
        if (context.RequestServices.GetRequiredService<UserService>().AuthenticateByToken(token) == null)
        { context.Response.StatusCode = 401; return; }
    }
    await next(context);
});
app.UseMiddleware<AuthMiddleware>();
app.UseMiddleware<DeviceDetectionMiddleware>();
app.UseMiddleware<RequestLoggingMiddleware>();

app.MapStaticAssets();
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

// =============================================================================
// API ENDPOINTS (organized in Yap/Endpoints/)
// =============================================================================
app.MapTusEndpoints();
app.MapPushEndpoints();
app.MapAuthEndpoints();
app.MapPwaEndpoints();
app.MapAdminEndpoints();
app.MapDiagnosticsEndpoints();
app.MapGifLibraryEndpoints();
app.MapOfflineChat();

app.Run();
