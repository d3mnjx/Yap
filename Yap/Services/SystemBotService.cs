using System.Collections.Concurrent;
using System.Text.Json;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Singleton service that manages the system bot user.
/// The bot appears as a regular user in the sidebar, sends welcome DMs to new users,
/// notifies admin when users join, and auto-replies with a placeholder when users DM it.
/// </summary>
public class SystemBotService
{
    private readonly UserService _userService;
    private readonly ChatService _chatService;
    private readonly AccessLinkService _accessLinks;
    private readonly IConfiguration _configuration;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<SystemBotService> _logger;

    private Guid _botUserId;
    private string _botUsername = "";
    private bool _initialized;

    // Debounce auto-replies: username -> last reply time
    private readonly ConcurrentDictionary<string, DateTime> _lastReplyTimes = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan ReplyDebounce = TimeSpan.FromSeconds(30);

    // Track users who have already received a welcome DM (prevents duplicates)
    private readonly HashSet<string> _welcomedUsers = new(StringComparer.OrdinalIgnoreCase);

    // Welcome message loaded from file (persisted) or config (default)
    private string? _welcomeMessageFromFile;

    private const string BotSessionId = "system-bot-session";
    private const string BotAvatarUrl = "/images/bot-avatar.svg";
    private const string DefaultWelcomeMessage = "👋 Hey! Welcome to {0}! I am bot for sending system messages.";

    public SystemBotService(
        UserService userService,
        ChatService chatService,
        AccessLinkService accessLinks,
        IConfiguration configuration,
        IWebHostEnvironment env,
        ILogger<SystemBotService> logger)
    {
        _userService = userService;
        _chatService = chatService;
        _accessLinks = accessLinks;
        _configuration = configuration;
        _env = env;
        _logger = logger;
    }

    private string SettingsFilePath => Path.Combine(_env.ContentRootPath, "Data", "bot-settings.json");

    private bool BotEnabled => _configuration.GetValue<bool>("ChatSettings:Bot:Enabled", true);
    private string BotUsernameConfig => _configuration["ChatSettings:Bot:Username"] ?? "ping";
    private string BotDisplayNameConfig => _configuration["ChatSettings:Bot:DisplayName"] ?? "Ping";
    private string ProjectName => _configuration["ChatSettings:ProjectName"] ?? "Yap";

    /// <summary>
    /// Gets the current welcome message template.
    /// Priority: file override → appsettings.json → hardcoded default.
    /// {0} is replaced with the project name when sent.
    /// </summary>
    public string WelcomeMessage
    {
        get => _welcomeMessageFromFile
               ?? _configuration["ChatSettings:Bot:WelcomeMessage"]
               ?? DefaultWelcomeMessage;
    }

    /// <summary>
    /// Updates the welcome message and persists it to Data/bot-settings.json.
    /// </summary>
    public async Task UpdateWelcomeMessageAsync(string message)
    {
        _welcomeMessageFromFile = message;
        await SaveSettingsAsync();
    }

    /// <summary>
    /// Initializes the bot user and subscribes to events.
    /// Must be called after UserService.LoadUsersAsync() and ChatService initialization.
    /// </summary>
    public async Task InitializeAsync()
    {
        // Load persisted settings (welcome message override)
        LoadSettings();

        if (!BotEnabled)
        {
            _logger.LogInformation("System bot is disabled");
            return;
        }

        var botUsername = BotUsernameConfig;
        var botDisplayName = BotDisplayNameConfig;

        // Look up or create the bot user
        var botUser = _userService.GetByUsername(botUsername);
        if (botUser == null)
        {
            botUser = await _userService.CreateUserAsync(botUsername);
            if (botUser == null)
            {
                _logger.LogError("Failed to create bot user '{Username}'", botUsername);
                return;
            }

            // Bot should never be admin — if it was made admin (first user), revoke it
            if (botUser.IsAdmin)
            {
                _userService.RevokeAdmin(botUser.Id);
                _logger.LogWarning("Bot was created as admin (first user) — revoking admin status");
            }

            await _userService.UpdateProfileAsync(
                botUser.Id,
                displayName: botDisplayName,
                profilePictureUrl: BotAvatarUrl,
                bio: "I'm a bot! 🤖",
                country: null);

            _logger.LogInformation("Created bot user '{Username}' with ID {UserId}", botUsername, botUser.Id);
        }
        else
        {
            // Update display name and avatar if changed
            if (botUser.DisplayName != botDisplayName || botUser.ProfilePictureUrl != BotAvatarUrl)
            {
                await _userService.UpdateProfileAsync(
                    botUser.Id,
                    displayName: botDisplayName,
                    profilePictureUrl: BotAvatarUrl,
                    bio: botUser.Bio ?? "I'm a bot! 🤖",
                    country: botUser.Country);
            }

            _logger.LogInformation("Found existing bot user '{Username}' with ID {UserId}", botUsername, botUser.Id);
        }

        _botUserId = botUser.Id;
        _botUsername = botUser.Username;
        _initialized = true;

        // Register bot as always-online
        await _chatService.AddUserAsync(BotSessionId, _botUserId, _botUsername);

        // Subscribe to events
        _chatService.OnUserChanged += HandleUserChanged;
        _accessLinks.OnBrakeTripped += HandleBrakeTripped;
        _chatService.OnMessageReceived += HandleMessageReceived;

        _logger.LogInformation("System bot initialized: {Username} ({UserId})", _botUsername, _botUserId);
    }

    /// <summary>
    /// Checks if the given username is the bot.
    /// </summary>
    public bool IsBotUser(string? username)
    {
        if (!_initialized || string.IsNullOrEmpty(username))
            return false;
        return _botUsername.Equals(username, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Checks if the given user ID is the bot.
    /// </summary>
    public bool IsBotUser(Guid userId)
    {
        if (!_initialized)
            return false;
        return _botUserId == userId;
    }

    /// <summary>
    /// Gets the bot's user ID, or null if not initialized.
    /// </summary>
    public Guid? BotUserId => _initialized ? _botUserId : null;

    /// <summary>
    /// Gets the bot's username, or null if not initialized.
    /// </summary>
    public string? BotUsername => _initialized ? _botUsername : null;

    /// <summary>
    /// Updates the bot's display name at runtime (from admin panel).
    /// </summary>
    public async Task UpdateDisplayNameAsync(string newDisplayName)
    {
        if (!_initialized) return;

        var botUser = _userService.GetById(_botUserId);
        if (botUser == null) return;

        await _userService.UpdateProfileAsync(
            _botUserId,
            displayName: newDisplayName,
            profilePictureUrl: botUser.ProfilePictureUrl,
            bio: botUser.Bio,
            country: botUser.Country);

        _logger.LogInformation("Bot display name updated to '{DisplayName}'", newDisplayName);
    }

    #region Settings File (Data/bot-settings.json)

    private void LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsFilePath))
            {
                var json = File.ReadAllText(SettingsFilePath);
                var settings = JsonSerializer.Deserialize<BotSettings>(json);
                if (settings?.WelcomeMessage != null)
                    _welcomeMessageFromFile = settings.WelcomeMessage;

                _logger.LogInformation("Loaded bot settings from {Path}", SettingsFilePath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load bot settings from {Path}", SettingsFilePath);
        }
    }

    private async Task SaveSettingsAsync()
    {
        try
        {
            var settings = new BotSettings { WelcomeMessage = _welcomeMessageFromFile };
            var json = JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(SettingsFilePath, json);
            _logger.LogInformation("Saved bot settings to {Path}", SettingsFilePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save bot settings to {Path}", SettingsFilePath);
        }
    }

    private class BotSettings
    {
        public string? WelcomeMessage { get; set; }
    }

    #endregion

    /// <summary>
    /// Notifies admin via bot DM that a user is requesting to join (approval mode).
    /// </summary>
    public async Task NotifyAdminOfPendingUserAsync(string username)
    {
        if (!_initialized) return;

        var adminUsername = _chatService.GetAdmin();
        if (adminUsername == null) return;

        var adminUser = _userService.GetByUsername(adminUsername);
        if (adminUser == null) return;

        var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, adminUser.Id, adminUser.Username);
        await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername,
            $"👋 **{username}** is requesting to join. Go to the Admin panel to approve or reject.");
    }

    /// <summary>
    /// When a new user joins: send them a welcome DM, and notify admin.
    /// </summary>
    private async void HandleUserChanged(string username, bool joined)
    {
        if (!joined) return;
        if (IsBotUser(username)) return;

        try
        {
            var joiningUser = _userService.GetByUsername(username);
            if (joiningUser == null) return;

            // Notify admin about the new user (immediately)
            await NotifyAdminOfJoinAsync(joiningUser);

            // Send welcome DM to the new user (delayed, once per user while app runs)
            await SendWelcomeDmAsync(joiningUser);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in bot HandleUserChanged for {Username}", username);
        }
    }

    private async Task SendWelcomeDmAsync(User user)
    {
        // Only welcome once per user (in-memory guard for current app lifetime)
        lock (_welcomedUsers)
        {
            if (!_welcomedUsers.Add(user.Username))
                return;
        }

        // Skip if bot already has a DM channel with this user (survives app restarts)
        var existingDms = _chatService.GetDMChannels(_botUsername);
        if (existingDms.Any(c => c.CanAccess(user.Username)))
            return;

        // Delay so the user has time to settle in before getting a notification
        await Task.Delay(TimeSpan.FromMinutes(1));

        var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, user.Id, user.Username);

        // Build welcome message: base message + PWA install line for mobile users + secret code
        var message = string.Format(WelcomeMessage, ProjectName);

        if (_chatService.IsUserMobile(user.Username))
        {
            message += "\n\n📱 I noticed you're on a phone. It's a much better experience if you [pwa-install] to your homescreen — it will look and feel like a normal app. Please also allow notifications when prompted so you don't miss messages. You can change this anytime in Settings.";
        }

        // Their way back in, born with the account. This DM is the one place they can always
        // find it again: when a fresh context greets them with the login page (installed app,
        // new browser, new device), the link is the way back into THIS account instead of
        // registering a doppelgänger. New accounts get a login link; accounts from before
        // links existed still carry a passphrase.
        if (_accessLinks.GetActiveForUser(user.Id) is { } link)
        {
            message += $"\n\n🔗 One more thing — this is your personal login link: {_accessLinks.BuildUrl(link.Code)}\n" +
                       "Open it on any device or browser and you're straight back in this account (new phone, reinstalled app, second browser). " +
                       "Save it somewhere safe, like your notes. Don't share it — anyone who has it can sign in as you. " +
                       $"On the login page you can also type its code, {link.Code}, as your secret code. " +
                       "You can manage the link anytime in Settings.";
        }
        else if (user.Password != null)
        {
            message += $"\n\n🔑 One more thing — your secret code is: {user.Password}\n" +
                       "If you ever see the login screen again (new device, new browser, reinstalled app), " +
                       "enter your username and this code to get back into your account. " +
                       "You can view or change it anytime in Settings.";
        }

        await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername, message);
        _logger.LogInformation("Sent welcome DM to {Username} (mobile={IsMobile})", user.Username, _chatService.IsUserMobile(user.Username));
    }

    private async Task NotifyAdminOfJoinAsync(User joiningUser)
    {
        var adminUsername = _chatService.GetAdmin();
        if (adminUsername == null) return;

        // Don't DM admin about their own join
        if (adminUsername.Equals(joiningUser.Username, StringComparison.OrdinalIgnoreCase)) return;

        var adminUser = _userService.GetByUsername(adminUsername);
        if (adminUser == null) return;

        var displayName = joiningUser.EffectiveDisplayName;
        var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, adminUser.Id, adminUser.Username);

        await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername,
            $"👋 {displayName} just joined the chat!");
    }

    /// <summary>
    /// Notifies a user via bot DM that a new device login occurred.
    /// Called for both smart login (IP match) and passphrase login.
    /// </summary>
    public async Task NotifyNewDeviceLoginAsync(string username, string loginMethod, string ip)
    {
        if (!_initialized) return;

        try
        {
            var user = _userService.GetByUsername(username);
            if (user == null) return;

            var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, user.Id, user.Username);

            var methodLabel = loginMethod switch
            {
                "smart" => "smart login (same network)",
                "link" => "your login link",
                _ => "secret code"
            };
            var message = $"🔐 New device sign-in detected for your account using **{methodLabel}** from IP `{ip}`. If this wasn't you, open **Settings** and use **Sign out all other devices** immediately.";

            await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername, message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error notifying {Username} of new device login", username);
        }
    }

    /// <summary>
    /// Tells a user that an admin replaced their login link (the rescue for someone locked
    /// out of every device). Includes the new link: if they can still read this DM somewhere,
    /// that is the fastest hand-over.
    /// </summary>
    public async Task NotifyLinkReplacedByAdminAsync(User user, AccessLink link)
    {
        if (!_initialized) return;

        try
        {
            var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, user.Id, user.Username);
            await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername,
                $"🔗 An admin created a new login link for you: {_accessLinks.BuildUrl(link.Code)}\n" +
                "Your previous link no longer works. Save this one somewhere safe.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error notifying {Username} of replaced login link", user.Username);
        }
    }

    /// <summary>The access-link brake tripped: someone is probably guessing codes.</summary>
    private async void HandleBrakeTripped(int failures)
    {
        try
        {
            var adminUsername = _chatService.GetAdmin();
            var adminUser = adminUsername == null ? null : _userService.GetByUsername(adminUsername);
            if (adminUser == null) return;

            var channel = _chatService.GetOrCreateDMChannel(_botUserId, _botUsername, adminUser.Id, adminUser.Username);
            await _chatService.SendMessageAsync(channel.Id, _botUserId, _botUsername,
                $"🚨 {failures} failed login-link attempts in the last few minutes. Code sign-ins are paused for 10 minutes. " +
                "Someone may be guessing codes — check the Logs tab in Admin for LOGIN_FAIL entries.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error notifying admin of access-link brake");
        }
    }

    /// <summary>
    /// When someone DMs the bot, auto-reply with a placeholder (debounced).
    /// </summary>
    private async void HandleMessageReceived(ChatMessage message)
    {
        // Skip own messages
        if (IsBotUser(message.Username)) return;
        if (message.Username == "System") return;

        try
        {
            // Check if this message is in a DM channel where bot is a participant
            var channels = _chatService.GetDMChannels(_botUsername);
            var dmChannel = channels.FirstOrDefault(c => c.Id == message.ChannelId);
            if (dmChannel == null) return;

            // Debounce: max one reply per user per 30 seconds
            var now = DateTime.UtcNow;
            if (_lastReplyTimes.TryGetValue(message.Username, out var lastReply)
                && (now - lastReply) < ReplyDebounce)
            {
                return;
            }

            _lastReplyTimes[message.Username] = now;

            // Small delay to feel more natural
            await Task.Delay(800);

            await _chatService.SendMessageAsync(dmChannel.Id, _botUserId, _botUsername,
                "Beep boop! 🤖 I'm not interactive yet, but hopefully soon!");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in bot HandleMessageReceived");
        }
    }
}
