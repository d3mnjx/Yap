using System.Collections.Concurrent;
using System.Text.Json;
using Yap.Configuration;
using Yap.Models;
using Yap.Models.Accounts;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Admin;
using Yap.Services.Media;
using Yap.Services.Presence;

namespace Yap.Services.Chat;

/// <summary>
/// Singleton service that manages the system bot user.
/// The bot appears as a regular user in the sidebar, sends welcome DMs to new users,
/// notifies admin when users join, and auto-replies with a placeholder when users DM it.
/// </summary>
public class SystemBotService
{
    private readonly UserService _userService;
    private readonly ChatService _chatService;
    private readonly PresenceService _presence;
    private readonly AccessLinkService _accessLinks;
    private readonly IConfiguration _configuration;
    private readonly ServerConfig _config;
    private readonly IWebHostEnvironment _env;
    private readonly ImageService _images;
    private readonly ILogger<SystemBotService> _logger;

    private Guid _botUserId;
    private string _botUsername = "";
    private bool _initialized;
    private readonly ProxyWatch _proxyWatch;
    private bool _proxyNoticeSent;   // the admin hears of an untrusted proxy once per run

    // Debounce auto-replies: username -> last reply time
    private readonly ConcurrentDictionary<string, DateTime> _lastReplyTimes = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan ReplyDebounce = TimeSpan.FromSeconds(30);

    // Track users who have already received a welcome DM (prevents duplicates)
    private readonly HashSet<string> _welcomedUsers = new(StringComparer.OrdinalIgnoreCase);

    // The three parts of the welcome DM, from Data/bot-settings.json once the admin saved them (AD-09)
    private string? _welcomeMessageFromFile, _phoneMessageFromFile, _linkMessageFromFile;

    // The return notice (PR-18): hours away before the admin hears that a person is back. From the same file.
    private int? _returnAfterHoursFromFile;
    private const int DefaultReturnAfterHours = 2;
    public const int MaxReturnAfterHours = 720;   // 30 days; the admin page offers the same range

    // A restart reconnects everyone within a minute, and LastSeenAt of a session the restart cut is that
    // session's start (the hub stamps it on connect and on disconnect, and a crash skips the disconnect).
    // Every such join would read as a long absence, so no return notice goes out this soon after start.
    internal DateTime StartedAt { get; set; } = DateTime.UtcNow;
    private static readonly TimeSpan StartupQuiet = TimeSpan.FromMinutes(2);

    public const string DefaultAvatarUrl = "/images/bot-avatar.svg";
    private const string DefaultWelcomeMessage = "👋 Hey! Welcome to {server}! I am bot for sending system messages.";
    private const string DefaultPhoneMessage = "📱 I noticed you're on a phone. It's a much better experience if you [pwa-install] to your homescreen — it will look and feel like a normal app. Please also allow notifications when prompted so you don't miss messages. You can change this anytime in Settings.";
    private const string DefaultLinkMessage = "🔗 One more thing — this is your personal login link: {link}\n" +
        "Open it on any device or browser and you're straight back in this account (new phone, reinstalled app, second browser). " +
        "Save it somewhere safe, like your notes. Don't share it — anyone who has it can sign in as you. " +
        "Can't open it? On the login page, type your username and this code: {code}. You can manage the link anytime in Settings.";

    public SystemBotService(
        UserService userService,
        ChatService chatService,
        PresenceService presence,
        AccessLinkService accessLinks,
        IConfiguration configuration,
        ServerConfig config,
        IWebHostEnvironment env,
        ProxyWatch proxyWatch,
        ImageService images,
        ILogger<SystemBotService> logger)
    {
        _userService = userService;
        _chatService = chatService;
        _presence = presence;
        _accessLinks = accessLinks;
        _configuration = configuration;
        _config = config;
        _env = env;
        _images = images;
        _proxyWatch = proxyWatch;
        _logger = logger;
    }

    private string SettingsFilePath => Path.Combine(_env.ContentRootPath, "Data", "bot-settings.json");

    private bool BotEnabled => _configuration.GetValue<bool>("ChatSettings:Bot:Enabled", true);
    private string BotUsernameConfig => _configuration["ChatSettings:Bot:Username"] ?? "ping";
    private string BotDisplayNameConfig => _configuration["ChatSettings:Bot:DisplayName"] ?? "Ping";
    private string ProjectName => _config.ProjectName;

    /// <summary>
    /// The first part of the welcome DM. The admin's saved text wins over appsettings, which wins over the default.
    /// {server} (or the older {0}) is the server name.
    /// </summary>
    public string WelcomeMessage => _welcomeMessageFromFile ?? _configuration["ChatSettings:Bot:WelcomeMessage"] ?? DefaultWelcomeMessage;

    /// <summary>The part added for a person on a phone. The client turns [pwa-install] into the install link (MR-74). Empty: no phone part.</summary>
    public string PhoneMessage => _phoneMessageFromFile ?? DefaultPhoneMessage;

    /// <summary>The part added when the person has a login link: {link} is the URL, {code} its code. Empty: no link part.</summary>
    public string LinkMessage => _linkMessageFromFile ?? DefaultLinkMessage;

    /// <summary>Hours a person must be away before the admin hears that the person is back (PR-18). 0 turns the notice off.</summary>
    public int ReturnAfterHours => _returnAfterHoursFromFile ?? DefaultReturnAfterHours;

    /// <summary>Saves what the admin edited to Data/bot-settings.json. A null value keeps the current one.</summary>
    public async Task UpdateSettingsAsync(string? welcome, string? phone, string? link, int? returnAfterHours)
    {
        if (welcome is not null) _welcomeMessageFromFile = welcome;
        if (phone is not null) _phoneMessageFromFile = phone;
        if (link is not null) _linkMessageFromFile = link;
        if (returnAfterHours is not null) _returnAfterHoursFromFile = Math.Clamp(returnAfterHours.Value, 0, MaxReturnAfterHours);
        await SaveSettingsAsync();
    }

    /// <summary>
    /// A part with its placeholders filled: {server} and {0} with the server name, {link} and {code} with the
    /// person's login link. A plain Replace, not string.Format: a stray brace in an edited text must not throw
    /// and cost someone their welcome.
    /// </summary>
    public string Fill(string text, (string Url, string Code)? link = null) => text
        .Replace("{server}", ProjectName).Replace("{0}", ProjectName)
        .Replace("{link}", link?.Url ?? "").Replace("{code}", link?.Code ?? "");

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
            botUser = _userService.CreateUser(botUsername);
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

            _userService.UpdateProfile(
                botUser.Id,
                displayName: botDisplayName,
                profilePictureUrl: DefaultAvatarUrl,
                bio: "I'm a bot! 🤖",
                country: null);

            _logger.LogInformation("Created bot user '{Username}' with ID {UserId}", botUsername, botUser.Id);
        }
        else
        {
            // The admin page owns the display name and the picture after creation (AD-09), so a restart keeps
            // them. Only a blank gets the default: a row from before the bot had a picture, or a cleared name.
            if (string.IsNullOrWhiteSpace(botUser.DisplayName) || string.IsNullOrEmpty(botUser.ProfilePictureUrl))
            {
                _userService.UpdateProfile(
                    botUser.Id,
                    displayName: string.IsNullOrWhiteSpace(botUser.DisplayName) ? botDisplayName : botUser.DisplayName,
                    profilePictureUrl: string.IsNullOrEmpty(botUser.ProfilePictureUrl) ? DefaultAvatarUrl : botUser.ProfilePictureUrl,
                    bio: botUser.Bio ?? "I'm a bot! 🤖",
                    country: botUser.Country);
            }

            _logger.LogInformation("Found existing bot user '{Username}' with ID {UserId}", botUsername, botUser.Id);
        }

        _botUserId = botUser.Id;
        _botUsername = botUser.Username;
        _initialized = true;
        StartedAt = DateTime.UtcNow;

        _presence.RegisterPermanent(_botUserId, _botUsername);   // the bot is always online (PR-09)

        // Subscribe to events
        _presence.OnPresenceChanged += HandlePresenceChanged;
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

    /// <summary>An account is deleted (AD-40). Both guards are keyed by username, and the name is free again: a
    /// newcomer who takes it gets a welcome of their own.</summary>
    public void Forget(string username)
    {
        lock (_welcomedUsers) _welcomedUsers.Remove(username);
        _lastReplyTimes.TryRemove(username, out _);
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
    public void UpdateDisplayName(string newDisplayName)
    {
        if (!_initialized) return;

        var botUser = _userService.GetById(_botUserId);
        if (botUser == null) return;

        _userService.UpdateProfile(
            _botUserId,
            displayName: newDisplayName,
            profilePictureUrl: botUser.ProfilePictureUrl,
            bio: botUser.Bio,
            country: botUser.Country);

        _logger.LogInformation("Bot display name updated to '{DisplayName}'", newDisplayName);
    }

    /// <summary>
    /// A picture the admin uploaded (AD-09), through the same path as a person's own: a 128 px WebP under
    /// /uploads/profiles, and the profile broadcast redraws it everywhere. Null when the image could not be read.
    /// </summary>
    public async Task<string?> SetAvatarAsync(Stream image)
    {
        if (!_initialized || _userService.GetById(_botUserId) is not { } bot) return null;
        var url = await _images.GenerateProfilePictureAsync(image, _botUserId);
        if (url is null) return null;
        _userService.UpdateProfile(_botUserId, bot.DisplayName, url, bot.Bio, bot.Country);
        return url;
    }

    /// <summary>Back to the built-in robot.</summary>
    public void ResetAvatar()
    {
        if (!_initialized || _userService.GetById(_botUserId) is not { } bot) return;
        _images.DeleteProfilePicture(_botUserId);
        _userService.UpdateProfile(_botUserId, bot.DisplayName, DefaultAvatarUrl, bot.Bio, bot.Country);
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
                _welcomeMessageFromFile = settings?.WelcomeMessage;
                _phoneMessageFromFile = settings?.PhoneMessage;
                _linkMessageFromFile = settings?.LinkMessage;
                _returnAfterHoursFromFile = settings?.ReturnAfterHours;

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
            var settings = new BotSettings
            {
                WelcomeMessage = _welcomeMessageFromFile, PhoneMessage = _phoneMessageFromFile, LinkMessage = _linkMessageFromFile,
                ReturnAfterHours = _returnAfterHoursFromFile,
            };
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
        public string? PhoneMessage { get; set; }
        public string? LinkMessage { get; set; }
        public int? ReturnAfterHours { get; set; }
    }

    #endregion

    /// <summary>The bot's direct message with the admin, or null before an admin account exists (a fresh install).</summary>
    private Channel? AdminDm()
    {
        var adminUsername = _userService.GetAdminUsername();
        if (adminUsername == null || _userService.GetByUsername(adminUsername) is not { } admin) return null;
        return _chatService.GetOrCreateDm(_botUserId, admin.Id);
    }

    /// <summary>
    /// Notifies admin via bot DM that a user is requesting to join (approval mode).
    /// </summary>
    public async Task NotifyAdminOfPendingUserAsync(string username)
    {
        if (!_initialized || AdminDm() is not { } channel) return;
        _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
            $"👋 **{username}** is requesting to join. Go to the Admin panel to approve or reject."));
    }

    /// <summary>
    /// The admin hears once that requests come through a proxy that is not in TrustedProxies (ProxyWatch): the chat
    /// is the place the admin reads every day. Sent at the first such request, or at the admin's first join when the
    /// account did not exist yet (a fresh install, where that first request is the admin's own sign-up).
    /// </summary>
    public void NotifyAdminOfUntrustedProxy()
    {
        if (!_initialized || _proxyNoticeSent) return;
        var status = _proxyWatch.Status();
        if (status.UntrustedPeer is null || AdminDm() is not { } channel) return;
        _proxyNoticeSent = true;
        _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
            $"⚠️ Requests reach {ProjectName} through a proxy at **{status.UntrustedPeer}** that is not in `ChatSettings:TrustedProxies`. " +
            "Every client address counts as unknown and smart login is off for everyone. " +
            "Add the proxy's address or network to TrustedProxies in Data/appsettings.json and restart. The Admin page shows the details."));
    }

    /// <summary>
    /// When a person joins: a new account gets a welcome DM and the admin hears of it; an account that was
    /// away for long tells the admin that the person is back.
    /// </summary>
    private void HandlePresenceChanged(string username, EffectiveStatus status, PresenceChange change)
    {
        if (change != PresenceChange.Join) return;   // the first connection of a person (PR-17, PR-18)
        if (IsBotUser(username)) return;
        // LastSeenAt is read here, inside the raise, while it still holds the end of the previous visit: the hub
        // tells PresenceService about the connection first and stamps LastSeenAt after, for this one reader.
        var lastSeen = _userService.GetByUsername(username)?.LastSeenAt;
        // Not async void: the welcome waits a minute, and an async void handler makes the raiser's
        // synchronization context (xUnit's, for one) wait with it. The task owns its errors.
        _ = GreetAsync(username, lastSeen);
    }

    private async Task GreetAsync(string username, DateTime? lastSeen)
    {
        try
        {
            var joiningUser = _userService.GetByUsername(username);
            if (joiningUser == null) return;

            // A new account's first join: the admin hears of it at once, the person a minute later (PR-18, AU-26).
            // Any later join: the admin hears of it when the person was away long enough (PR-18).
            if (joiningUser.CreatedAt > DateTime.UtcNow.AddMinutes(-5)) await NotifyAdminOfJoinAsync(joiningUser);
            else if (lastSeen is { } seen) NotifyAdminOfReturn(joiningUser, DateTime.UtcNow - seen);
            if (_userService.IsAdmin(joiningUser.Id)) NotifyAdminOfUntrustedProxy();   // the notice waited for an admin to exist
            await SendWelcomeDmAsync(joiningUser);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in bot HandlePresenceChanged for {Username}", username);
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
        var existingDms = _chatService.DmChannelsOf(_botUserId);
        if (existingDms.Any(c => c.CanAccess(user.Username)))
            return;

        // Delay so the user has time to settle in before getting a notification
        await Task.Delay(TimeSpan.FromMinutes(1));

        var channel = _chatService.GetOrCreateDm(_botUserId, user.Id);
        if (channel is null) return;

        // The welcome DM is three parts the admin edits (AD-09): the welcome, the phone part on a phone, and the way
        // back in. An empty part is left out, its separator with it. The link fills {link} and {code} in any part.
        var link = _accessLinks.GetActiveForUser(user.Id) is { } active ? ((string, string)?)(_accessLinks.BuildUrl(active.Code, user.Id), active.Code) : null;
        var parts = new List<string> { Fill(WelcomeMessage, link) };
        if (_presence.IsMobile(user.Id)) parts.Add(Fill(PhoneMessage, link));

        // Their way back in, born with the account. This DM is the one place they can always
        // find it again: when a fresh context greets them with the login page (installed app,
        // new browser, new device), the link is the way back into THIS account instead of
        // registering a doppelgänger. New accounts get a login link; accounts from before
        // links existed still carry a passphrase.
        if (link is not null) parts.Add(Fill(LinkMessage, link));
        else if (user.Password != null)
            parts.Add($"🔑 One more thing — your secret code is: {user.Password}\n" +
                      "If you ever see the login screen again (new device, new browser, reinstalled app), " +
                      "enter your username and this code to get back into your account. " +
                      "You can view or change it anytime in Settings.");

        var message = string.Join("\n\n", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
        if (message.Length == 0) return;   // the admin emptied every part
        _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername, message));
        _logger.LogInformation("Sent welcome DM to {Username} (mobile={IsMobile})", user.Username, _presence.IsMobile(user.Id));
    }

    private async Task NotifyAdminOfJoinAsync(User joiningUser)
    {
        if (_userService.IsAdmin(joiningUser.Id)) return;   // not about the admin's own join
        if (AdminDm() is not { } channel) return;
        _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
            $"👋 {joiningUser.EffectiveDisplayName} just joined the chat!"));
    }

    /// <summary>The admin hears that a person is back after at least ReturnAfterHours away (PR-18).</summary>
    private void NotifyAdminOfReturn(User user, TimeSpan away)
    {
        var hours = ReturnAfterHours;
        if (hours <= 0 || away < TimeSpan.FromHours(hours)) return;
        if (_userService.IsAdmin(user.Id)) return;   // not about the admin's own return
        if (DateTime.UtcNow - StartedAt < StartupQuiet) return;   // see StartedAt
        if (AdminDm() is not { } channel) return;
        _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
            $"👋 {user.EffectiveDisplayName} is back after {Describe(away)}."));
    }

    /// <summary>"3 hours", "1 day", "12 days": whole units, days from two days on.</summary>
    internal static string Describe(TimeSpan away)
    {
        var (n, unit) = away.TotalHours < 48 ? ((int)away.TotalHours, "hour") : ((int)away.TotalDays, "day");
        return n == 1 ? $"1 {unit}" : $"{n} {unit}s";
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

            var channel = _chatService.GetOrCreateDm(_botUserId, user.Id);
            if (channel is null) return;

            var methodLabel = loginMethod switch
            {
                "smart" => "smart login (same network)",
                "link" => "your login link",
                _ => "secret code"
            };
            var message = $"🔐 New device sign-in detected for your account using **{methodLabel}** from IP `{ip}`. If this wasn't you, open **Settings** and use **Sign out all other devices** immediately.";

            _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername, message));
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
            var channel = _chatService.GetOrCreateDm(_botUserId, user.Id);
            if (channel is null) return;
            _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
                $"🔗 An admin created a new login link for you: {_accessLinks.BuildUrl(link.Code, user.Id)}\n" +
                "Your previous link no longer works. Save this one somewhere safe."));
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
            if (AdminDm() is not { } channel) return;
            _chatService.Send(new SendMessage(channel.Id, _botUserId, _botUsername,
                $"🚨 {failures} failed login-link attempts in the last few minutes. Code sign-ins are paused for 10 minutes. " +
                "Someone may be guessing codes — check the Logs tab in Admin for LOGIN_FAIL entries."));
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
        if (message.Kind != MessageKind.Normal) return;   // a pin line in a DM with the bot is not a message to answer (MR-80)

        try
        {
            // Check if this message is in a DM channel where bot is a participant
            var channels = _chatService.DmChannelsOf(_botUserId);
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

            _chatService.Send(new SendMessage(dmChannel.Id, _botUserId, _botUsername,
                "Beep boop! 🤖 I'm not interactive yet, but hopefully soon!"));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in bot HandleMessageReceived");
        }
    }
}
