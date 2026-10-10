namespace Yap.Offline;

/// <summary>
/// Classifies chat shell, API and hub paths so middleware applies the correct authentication and
/// response policy.
/// </summary>
public static class ChatRoutes
{
    public static bool IsAuthenticatedRoot(HttpContext http) => HttpMethods.IsGet(http.Request.Method)
        && http.Request.Path == "/" && !http.Request.Query.ContainsKey("returnUrl")
        && http.RequestServices.GetRequiredService<Yap.Services.UserService>()
            .AuthenticateByToken(http.Request.Cookies[Yap.Middleware.AuthMiddleware.CookieName] ?? "") != null;
    public static bool IsShell(HttpContext http) => IsShell(http.Request.Path) || IsAuthenticatedRoot(http);
    public static bool IsShell(PathString path) => path.Equals("/chat", StringComparison.OrdinalIgnoreCase)
        || path.Equals("/lobby", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/room") || path.StartsWithSegments("/dm");
    public static bool IsApi(PathString path) => path.StartsWithSegments("/api/chat");
    public static bool IsHub(PathString path) => path.StartsWithSegments("/hubs/chat");
}
