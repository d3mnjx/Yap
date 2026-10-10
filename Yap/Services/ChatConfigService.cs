namespace Yap.Services;

public class ChatConfigService
{
    private readonly IConfiguration _configuration;

    public ChatConfigService(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public string ProjectName => _configuration["ChatSettings:ProjectName"] ?? "Yap";
    public string RoomName => _configuration["ChatSettings:RoomName"] ?? "lobby";
    public bool WelcomePageEnabled => _configuration.GetValue<bool>("ChatSettings:WelcomePageEnabled", true);
    public string UploadUrl => _configuration["ChatSettings:UploadUrl"] ?? "";
    public int MaxUploadSizeMB => _configuration.GetValue<int>("ChatSettings:MaxUploadSizeMB", 100);
    public int GifPackMaxSizeMB => _configuration.GetValue<int>("ChatSettings:GifSettings:MaxPackSizeMB", 1024);

    // Bot settings
    public bool BotEnabled => _configuration.GetValue<bool>("ChatSettings:Bot:Enabled", true);
    public string BotUsername => _configuration["ChatSettings:Bot:Username"] ?? "ping";
    public string BotDisplayName => _configuration["ChatSettings:Bot:DisplayName"] ?? "Ping";

    public string GetRandomWelcomeMessage()
        => GetRandomText("WelcomeMessages", "Welcome to {0}!", ProjectName);

    public string GetRandomJoinButtonText()
        => GetRandomText("JoinButtonTexts", "Join Chat");

    public string GetRandomUsernamePlaceholder()
        => GetRandomText("UsernamePlaceholders", "Enter your username");

    public string GetRandomTypingIndicator(List<string> typingUsers, string currentUser)
    {
        var others = typingUsers.Where(u => u != currentUser).ToList();
        if (others.Count == 0) return "";

        var (configKey, defaultMsg, formatArgs) = others.Count switch
        {
            1 => ("TypingIndicators:Single", "{0} is typing..", new object[] { others[0] }),
            2 => ("TypingIndicators:Double", "{0} and {1} are typing..", new object[] { others[0], others[1] }),
            _ => ("TypingIndicators:Multiple", "{0} and {1} others are typing..", new object[] { others[0], others.Count - 1 })
        };

        return GetRandomText(configKey, defaultMsg, formatArgs);
    }

    public string GetRandomOnlineUsersHeader(int count)
        => GetRandomText("OnlineUsersHeader", "Online Users ({0})", count);

    public string GetRandomRoomHeader()
        => GetRandomRoomHeader(RoomName);

    public string GetRandomRoomHeader(string roomName)
        => GetRandomText("RoomHeaders", "# {0}", roomName);

    private string GetRandomText(string configKey, string fallback, params object[] args)
    {
        var items = _configuration.GetSection($"ChatSettings:FunnyTexts:{configKey}").Get<string[]>()
            ?? [fallback];
        var text = items[Random.Shared.Next(items.Length)];
        return args.Length > 0 ? string.Format(text, args) : text;
    }
}
