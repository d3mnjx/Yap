namespace Yap.Configuration;

/// <summary>
/// The server's settings as the code reads them: the values of appsettings.json under ChatSettings, and the
/// configured text lists with their fallbacks (GEN-12). The client picks a text from a list when its context
/// appears; the server only hands the lists over.
/// </summary>
public sealed class ServerConfig(IConfiguration configuration)
{
    public string ProjectName => configuration["ChatSettings:ProjectName"] ?? "Yap";
    public bool WelcomePageEnabled => configuration.GetValue("ChatSettings:WelcomePageEnabled", true);
    public string UploadUrl => configuration["ChatSettings:UploadUrl"] ?? "";
    public string Ipv4BeaconUrl => configuration["ChatSettings:Ipv4BeaconUrl"] ?? "";
    public int MaxUploadSizeMB => configuration.GetValue("ChatSettings:MaxUploadSizeMB", 100);   // IB-32

    // The system bot (AD-09). The welcome text has no default here: the admin's saved text comes before the configured
    // one, and SystemBotService keeps the default beside the other parts of the welcome DM, which appsettings cannot set.
    public bool BotEnabled => configuration.GetValue("ChatSettings:Bot:Enabled", true);
    public string BotUsername => configuration["ChatSettings:Bot:Username"] ?? "ping";
    public string BotDisplayName => configuration["ChatSettings:Bot:DisplayName"] ?? "Ping";
    public string? BotWelcomeMessage => configuration["ChatSettings:Bot:WelcomeMessage"];

    /// <summary>Every configured list, for a signed-in client.</summary>
    public TextsDto Texts() => new(
        RoomHeaders: List("RoomHeaders", "# {0}"),                                      // SH-05
        Placeholders: List("MessagePlaceholders", "Type a message..."),                 // IB-16
        TypingOne: List("TypingIndicators:Single", "{0} is typing.."),                  // IB-60
        TypingTwo: List("TypingIndicators:Double", "{0} and {1} are typing.."),
        TypingMany: List("TypingIndicators:Multiple", "{0} and {1} others are typing.."),
        PeopleHeaders: List("OnlineUsersHeader", "Online Users ({0})"),                 // SH-28
        JoinLines: List("SystemMessages:UserJoined", "{0} joined the chat"),            // MR-73
        LeaveLines: List("SystemMessages:UserLeft", "{0} left the chat"),
        PillTexts: List("NewMessagesPill", "New messages"),                              // TL-17
        SearchPlaceholders: List("Search:Placeholder", "Search"),                        // SR-32; {0} is the name of the conversation
        SearchEmpty: List("Search:NoResults", "No results"),                             // SR-32; {0} is the query
        LoginHeadings: List("WelcomeMessages", "Welcome to {0}!"),                       // AU-07
        LoginButtons: List("JoinButtonTexts", "Join Chat"),
        LoginPlaceholders: List("UsernamePlaceholders", "Enter your username"));

    /// <summary>The lists a signed-out page needs, and nothing else.</summary>
    public LoginTextsDto LoginTexts() => new(
        List("WelcomeMessages", "Welcome to {0}!"), List("JoinButtonTexts", "Join Chat"), List("UsernamePlaceholders", "Enter your username"));

    private string[] List(string key, string fallback) =>
        configuration.GetSection($"ChatSettings:FunnyTexts:{key}").Get<string[]>() is { Length: > 0 } items ? items : [fallback];
}

public sealed record TextsDto(
    string[] RoomHeaders, string[] Placeholders, string[] TypingOne, string[] TypingTwo, string[] TypingMany,
    string[] PeopleHeaders, string[] JoinLines, string[] LeaveLines, string[] PillTexts,
    string[] SearchPlaceholders, string[] SearchEmpty,
    string[] LoginHeadings, string[] LoginButtons, string[] LoginPlaceholders);

public sealed record LoginTextsDto(string[] LoginHeadings, string[] LoginButtons, string[] LoginPlaceholders);
