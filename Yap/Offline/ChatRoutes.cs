namespace Yap.Offline;

/// <summary>
/// Classifies chat shell, API and hub paths so middleware applies the correct authentication and
/// response policy.
/// </summary>
public static class ChatRoutes
{
    public static bool IsShell(PathString path) => path.Equals("/chat", StringComparison.OrdinalIgnoreCase)
        || path.Equals("/lobby", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/room") || path.StartsWithSegments("/dm");
    public static bool IsApi(PathString path) => path.StartsWithSegments("/api/chat");
    public static bool IsHub(PathString path) => path.StartsWithSegments("/hubs/chat");
}
