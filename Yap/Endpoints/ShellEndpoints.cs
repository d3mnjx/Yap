using System.Net;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Yap.Configuration;
using Yap.Helpers;
using Yap.Models.Admin;
using Yap.Services.Accounts;
using Yap.Services.Admin;

namespace Yap.Endpoints;

/// <summary>
/// The one HTML page and the service worker. Every client route answers wwwroot/index.html, so a deep link, a
/// reload and the installed app's start URL all land in the same shell and the router in the browser takes over
/// (SH-42). Both files are templates: the build stamp, the import map, the modulepreload links, the worker's shell
/// list and the client routes are written in at request time (ShellAssets), so the client and its worker know which
/// build they run (the new-version strip, the shell cache) and no list of files is kept by hand. The project name goes
/// into the page's title the same way: the worker serves the shell cache-first, so the title is the first thing the tab
/// shows, and a fixed "Yap" there flashed before the chat page set the real one (SH-45).
/// </summary>
public static class ShellEndpoints
{
    // The client's routes. wwwroot/js/router.js has their patterns and names the other places a new route needs.
    private static readonly string[] Routes =
    [
        "/", "/lobby", "/room/{id:guid}", "/dm/{user}", "/settings", "/admin",
        "/channel/new", "/channel/{id:guid}/settings", "/login", "/verify/{user}", "/invite/{code}",
    ];

    public static void MapShell(this WebApplication app)
    {
        var env = app.Environment;
        var assets = new ShellAssets(env.WebRootPath, BuildInfo.Time);
        var config = app.Services.GetRequiredService<ServerConfig>();   // a singleton; the name comes from appsettings and changes with a restart
        // The client routes as one pattern for the worker: "{id:guid}" and "{user}" become one path segment.
        var routePattern = string.Join("|", Routes.Select(r => Regex.Replace(r, @"\{[^}]*\}", "[^/]+")));
        string? cachedShell = null, cachedWorker = null;
        // Development reads the files on every request, so an edit shows on reload. Production reads them once.
        string Shell() => env.IsDevelopment() ? Read("index.html") : cachedShell ??= Read("index.html");
        string Worker() => env.IsDevelopment() ? Read("service-worker.js") : cachedWorker ??= Read("service-worker.js");
        string Read(string file)
        {
            using var reader = new StreamReader(env.WebRootFileProvider.GetFileInfo(file).CreateReadStream());
            return reader.ReadToEnd()
                .Replace("{{build}}", BuildInfo.Time)
                .Replace("{{project}}", WebUtility.HtmlEncode(config.ProjectName))
                .Replace("{{importmap}}", assets.ImportMap)
                .Replace("{{modulepreload}}", assets.ModulePreloads)
                .Replace("{{shell}}", assets.ShellList)
                .Replace("{{routes}}", routePattern);
        }

        foreach (var route in Routes)
        {
            app.MapGet(route, (HttpContext http, ClaimsPrincipal principal, ServerConfig config, UserActionLogService log, RegistrationGateService gate) =>
            {
                // A signed-out visitor at the root gets the welcome page when the deployment has one (AD-36).
                if (route == "/" && !principal.IsSignedIn() && config.WelcomePageEnabled
                    && File.Exists(Path.Combine(env.ContentRootPath, "Data", "welcome", "welcome.html")))
                    return Results.Content(Welcome(env, config.ProjectName), "text/html; charset=utf-8");

                // A signed-out load of the login page or of an invite is a visit for the Visitors tab (AD-20). The
                // invite's code stays out of the log: the admin may not see a claimed code (AD-17). Only a navigation
                // counts: the service worker also fetches /login to store the shell, with Sec-Fetch-Mode "same-origin".
                var mode = http.Request.Headers["Sec-Fetch-Mode"].ToString();
                if (!principal.IsSignedIn() && route is "/login" or "/invite/{code}" && (mode.Length == 0 || mode == "navigate"))
                    log.Log(null, UserActionLog.KnownActions.VISIT, url: route == "/login" ? "/login" : "/invite",
                        info: route == "/login" && gate.RegistrationClosed ? "registration_closed" : null,
                        ip: IpHelper.GetClientIp(http), userAgent: http.Request.Headers.UserAgent.ToString());

                http.Response.Headers.CacheControl = "no-cache";   // always revalidate: the service worker, not the HTTP cache, serves the shell
                return Results.Content(Shell(), "text/html; charset=utf-8");
            });
        }

        // The worker names its cache after the build written in here, so a deploy is a byte change the browser sees
        // when it fetches the worker at the next registration. no-cache: that fetch must reach the server.
        app.MapGet("/service-worker.js", (HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "no-cache";
            return Results.Content(Worker(), "text/javascript; charset=utf-8");
        });
    }

    // Data/welcome/welcome.html is a fragment (styles and markup) that the admin edits. It gets a document
    // around it and the one behaviour it had: the #yap-enter element leads to the login page, after the
    // .welcome-bg "awaken" animation when the fragment has one.
    private static string Welcome(IWebHostEnvironment env, string projectName)
    {
        var fragment = File.ReadAllText(Path.Combine(env.ContentRootPath, "Data", "welcome", "welcome.html"));
        return $$"""
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>{{WebUtility.HtmlEncode(projectName)}}</title>
            <link rel="icon" type="image/svg+xml" href="/icon.svg">
            </head>
            <body>
            {{fragment}}
            <script>
            (() => {
              const enter = document.getElementById('yap-enter');
              if (!enter) return;
              enter.style.cursor = 'pointer';
              enter.addEventListener('click', () => {
                const go = () => location.assign('/login');
                const bg = document.querySelector('.welcome-bg');
                if (bg) { enter.classList.add('lit'); bg.classList.add('awaken'); setTimeout(go, 2200); } else go();
              }, { once: true });
            })();
            </script>
            </body>
            </html>
            """;
    }
}
