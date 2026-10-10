namespace Yap.Offline;

public static class ChatProtocol
{
    public const string Version = "2";
    public const string Header = "X-Yap-Chat-Protocol";
    public static bool Accepts(HttpRequest request, bool hub = false)
        => (!request.Headers.TryGetValue(Header, out var header) || header == Version)
            // Browsers cannot set WebSocket handshake headers. The query accompanies
            // negotiation and every transport; explicit conflicts fail on either path.
            && (!hub || !request.Query.TryGetValue("protocol", out var query) || query == Version);
}
