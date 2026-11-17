using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Yap.Models;
using Yap.Models.Accounts;
using Yap.Models.Notifications;
using Yap.Services.Persistence;

namespace Yap.Services.Accounts;

/// <summary>
/// Singleton service for user management with in-memory cache.
/// Handles user creation, authentication, and lookups.
/// </summary>
public class UserService
{
    private readonly IDbContextFactory<ChatDbContext>? _dbFactory;   // startup load only
    private readonly PersistenceWriter _writer;
    private readonly ILogger<UserService> _logger;

    // In-memory cache (mirrors database, like ChatService pattern)
    private readonly ConcurrentDictionary<Guid, User> _users = new();
    private readonly ConcurrentDictionary<string, Guid> _usernameToId = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, Guid> _tokenToId = new();

    /// <summary>Display name, avatar, bio or location changed; everyone redraws the person (ST-07).</summary>
    public event Action<User>? OnProfileChanged;

    /// <summary>The recent emoji of a person changed (PK-07).</summary>
    public event Action<Guid, List<string>>? OnRecentEmojiChanged;

    /// <summary>A setting of the account changed; the person's other devices merge the fields (ST-10, PK-07).</summary>
    public event Action<Guid, object>? OnSettingsChanged;

    // Admin tracking
    private Guid? _adminUserId;
    private readonly object _adminLock = new();

    public UserService(IServiceProvider serviceProvider, PersistenceWriter writer, ILogger<UserService> logger)
    {
        _logger = logger;
        _writer = writer;
        _dbFactory = serviceProvider.GetService<IDbContextFactory<ChatDbContext>>();
    }

    /// <summary>
    /// Loads users from database on startup.
    /// </summary>
    public async Task LoadUsersAsync()
    {
        if (_dbFactory is null) return;

        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync();
            var users = await db.Users.AsNoTracking().ToListAsync();

            foreach (var user in users)
            {
                _users[user.Id] = user;
                _usernameToId[user.Username] = user.Id;
                _tokenToId[user.Token] = user.Id;

                if (user.IsAdmin)
                {
                    _adminUserId = user.Id;
                }
            }

            _logger.LogInformation("Loaded {Count} users", users.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load users from database");
        }
    }

    /// <summary>
    /// Creates a new user with a generated token.
    /// </summary>
    public User? CreateUser(string username)
    {
        // Generate a secure random token
        var token = GenerateToken();

        // Determine if this user should be admin (first user)
        // Single lock block to prevent two users both seeing null and both becoming admin
        bool isAdmin;
        lock (_adminLock)
        {
            isAdmin = _adminUserId == null;
        }

        // No passphrase at birth. New accounts get a login link instead, minted by the caller
        // (AuthEndpoints) because AccessLinkService sits above this service; the link's code
        // is what the verification page takes typed (AU-12). The secret code is retired
        // (AU-13): an account from before links keeps its passphrase, and Settings can only
        // disable it. The reason a credential must exist from day one stands: a context that
        // starts signed out (installed PWA, second browser) otherwise has no way back in, and
        // one real user forked into seven accounts that way.
        var user = new User(username, token) { IsAdmin = isAdmin };

        // Atomic uniqueness check — TryAdd returns false if username already exists
        if (!_usernameToId.TryAdd(user.Username, user.Id))
        {
            _logger.LogWarning("Attempted to create user with existing username: {Username}", username);
            return null;
        }

        _users[user.Id] = user;
        _tokenToId[user.Token] = user.Id;

        if (isAdmin)
        {
            lock (_adminLock)
            {
                // Double-check: another thread may have set admin between our check and here
                if (_adminUserId == null)
                {
                    _adminUserId = user.Id;
                }
                else
                {
                    // Someone else became admin first — demote this user
                    isAdmin = false;
                    user.IsAdmin = false;
                }
            }
        }

        _writer.Enqueue(Writes.NewUser(user));
        _logger.LogInformation("Created new user: {Username} (Admin: {IsAdmin})", username, isAdmin);
        OnProfileChanged?.Invoke(user);   // the people lists of the open clients learn the name (SH-33)

        return user;
    }

    /// <summary>
    /// Authenticates a user by their token.
    /// </summary>
    public User? AuthenticateByToken(string token)
    {
        if (string.IsNullOrEmpty(token))
            return null;

        if (_tokenToId.TryGetValue(token, out var userId) && _users.TryGetValue(userId, out var user))
        {
            return user;
        }

        return null;
    }

    /// <summary>
    /// Gets a user by their ID.
    /// </summary>
    public User? GetById(Guid userId)
    {
        return _users.TryGetValue(userId, out var user) ? user : null;
    }

    /// <summary>
    /// Gets a user by their username.
    /// </summary>
    public User? GetByUsername(string username)
    {
        if (_usernameToId.TryGetValue(username, out var userId))
        {
            return _users.TryGetValue(userId, out var user) ? user : null;
        }
        return null;
    }

    /// <summary>
    /// Finds the user whose display name matches (case-insensitive).
    /// Login guard: a display name typed into the login form must not silently
    /// become a brand-new account (the doppelgänger / duplicate-DM-channel bug).
    /// </summary>
    public User? FindByDisplayName(string displayName) =>
        string.IsNullOrWhiteSpace(displayName)
            ? null
            : _users.Values.FirstOrDefault(u =>
                string.Equals(u.DisplayName, displayName.Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Gets all registered users.
    /// </summary>
    public List<User> GetAllUsers() => _users.Values.ToList();

    /// <summary>
    /// Updates the user's LastSeenAt timestamp.
    /// </summary>
    public void UpdateLastSeen(Guid userId)
    {
        if (_users.TryGetValue(userId, out var user))
        {
            user.LastSeenAt = DateTime.UtcNow;
            _writer.Enqueue(Writes.User(user));
        }
    }

    /// <summary>
    /// Gets the admin user ID.
    /// </summary>
    public Guid? GetAdminUserId()
    {
        lock (_adminLock)
        {
            return _adminUserId;
        }
    }

    /// <summary>
    /// Checks if a user is the admin.
    /// </summary>
    public bool IsAdmin(Guid userId)
    {
        lock (_adminLock)
        {
            return _adminUserId == userId;
        }
    }

    /// <summary>
    /// Gets the admin username.
    /// </summary>
    public string? GetAdminUsername()
    {
        lock (_adminLock)
        {
            if (_adminUserId.HasValue && _users.TryGetValue(_adminUserId.Value, out var user))
            {
                return user.Username;
            }
            return null;
        }
    }

    /// <summary>
    /// Revokes admin status from a user (e.g., bot user that was created first).
    /// </summary>
    public void RevokeAdmin(Guid userId)
    {
        lock (_adminLock)
        {
            if (_adminUserId == userId)
            {
                _adminUserId = null;
                if (_users.TryGetValue(userId, out var user))
                    user.IsAdmin = false;
            }
        }
    }

    /// <summary>
    /// Forgets the account (AD-40): the cookie, the passphrase and smart login all resolve through these dictionaries
    /// and fail from now on, and the username is free again. The admin is refused: without an admin the next sign-up
    /// would become one (AU-06). Everything the account owns elsewhere is AccountDeletionService's job.
    /// </summary>
    public User? Remove(Guid userId)
    {
        if (IsAdmin(userId) || !_users.TryRemove(userId, out var user)) return null;
        _usernameToId.TryRemove(user.Username, out _);
        _tokenToId.TryRemove(user.Token, out _);
        _writer.Enqueue(Writes.DeleteUser(userId));
        _logger.LogInformation("Deleted user: {Username}", user.Username);
        return user;
    }

    /// <summary>
    /// Updates a user's profile (display name, profile picture, bio).
    /// </summary>
    public string? UpdateProfile(Guid userId, string? displayName, string? profilePictureUrl, string? bio, string? country)
    {
        if (!_users.TryGetValue(userId, out var user)) return "Unknown user.";
        if (displayName is { Length: > 64 }) return "A display name has at most 64 characters.";   // ST-05
        if (bio is { Length: > 150 }) return "A bio has at most 150 characters.";                   // ST-06
        if (country is { Length: > 100 }) return "A location has at most 100 characters.";

        user.DisplayName = displayName;
        user.ProfilePictureUrl = profilePictureUrl;
        user.Bio = bio;
        user.Country = country;

        _writer.Enqueue(Writes.User(user));
        OnProfileChanged?.Invoke(user);
        return null;
    }

    /// <summary>
    /// Mutes or unmutes every notification for a user. <paramref name="until"/> is null for
    /// "until I turn it back on"; unmuting clears it.
    /// </summary>
    public void SetServerMute(Guid userId, bool muted, DateTime? until)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        var expiry = muted ? until : null;
        user.NotifServerMuted = muted;
        user.NotifServerMuteUntil = expiry;

        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Sets how DMs notify (allow all, mute all, or per-channel).
    /// </summary>
    public void SetDmNotificationMode(Guid userId, NotificationMode mode)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifDmMode = mode;

        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Sets how rooms notify (allow all, mute all, or per-channel).
    /// </summary>
    public void SetRoomNotificationMode(Guid userId, NotificationMode mode)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifRoomMode = mode;

        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Sets whether a DM partner with no override row notifies (Individual DM mode only).
    /// </summary>
    public void SetNewDmsMuted(Guid userId, bool muted)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifNewDmsMuted = muted;

        _writer.Enqueue(Writes.User(user));
    }

    public void SetSmartLoginOptOut(Guid userId, bool optOut)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.SmartLoginOptOut = optOut;

        _writer.Enqueue(Writes.User(user));
        OnSettingsChanged?.Invoke(userId, new { smartLoginOptOut = user.SmartLoginOptOut });
    }

    /// <summary>
    /// Updates the user's selected color theme ID.
    /// </summary>
    public string? UpdateTheme(Guid userId, string? themeId)
    {
        if (!_users.TryGetValue(userId, out var user)) return "Unknown user.";
        if (themeId is not null && !ThemeRegistry.IsKnown(themeId)) return "Unknown theme.";   // ST-08

        user.Theme = themeId;

        _writer.Enqueue(Writes.User(user));
        OnSettingsChanged?.Invoke(userId, new { theme = user.Theme });
        return null;
    }

    private static readonly int[] FontSizes = [14, 15, 16, 17, 18, 20];   // the six choices of Settings (ST-10)

    /// <summary>The root font size in px. 16 is the browser default and is stored as null (ST-10).</summary>
    public string? UpdateFontSize(Guid userId, int? fontSize)
    {
        if (!_users.TryGetValue(userId, out var user)) return "Unknown user.";
        if (fontSize is { } size && !FontSizes.Contains(size)) return "Unknown text size.";

        user.FontSize = fontSize == 16 ? null : fontSize;

        _writer.Enqueue(Writes.User(user));
        OnSettingsChanged?.Invoke(userId, new { fontSize = user.FontSize });
        return null;
    }

    /// <summary>
    /// Updates the user's timezone and locale (detected from browser).
    /// </summary>
    public void UpdateLocale(Guid userId, string? timeZone, string? locale, string? dateFormat = null)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.TimeZone = timeZone;
        user.Locale = locale;
        // The first locale fixes the date order and the clock (ST-19): every device then reads one stored value.
        if (user.DateFormat is null && !string.IsNullOrEmpty(locale)) user.DateFormat = LocaleResolver.GuessDateFormatFromLocale(locale);
        if (dateFormat != null)
            user.DateFormat = dateFormat;

        _writer.Enqueue(Writes.User(user));
        OnSettingsChanged?.Invoke(userId, new { timeZone = user.TimeZone, locale = user.Locale, dateFormat = user.DateFormat });
    }

    /// <summary>
    /// Records that the user was seen running Yap as an installed PWA (display-mode: standalone).
    /// Updates <see cref="User.PwaInstalledAt"/> to now. Idempotent per connect; only called by the
    /// client when it detects standalone mode, so non-PWA sessions never touch this.
    /// </summary>
    public void MarkPwaInstalled(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        var now = DateTime.UtcNow;
        user.PwaInstalledAt = now;

        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Sets a passphrase for the user (enables multi-device login).
    /// </summary>
    public void SetPassword(Guid userId, string? password)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.Password = password;

        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Verifies a password for an existing user. Returns the user if credentials match.
    /// </summary>
    public User? VerifyPassword(string username, string password)
    {
        var user = GetByUsername(username);
        if (user == null || user.Password == null)
            return null;

        return string.Equals(user.Password, password, StringComparison.Ordinal) ? user : null;
    }

    /// <summary>
    /// Checks if a user has a passphrase set.
    /// </summary>
    public bool HasPassword(string username)
    {
        var user = GetByUsername(username);
        return user?.Password != null;
    }

    /// <summary>
    /// Gets the stored passphrase for a user (for display in Settings).
    /// </summary>
    public string? GetPassword(Guid userId)
    {
        return _users.TryGetValue(userId, out var user) ? user.Password : null;
    }

    #region Smart Login Known IPs

    // Smart login's IP memory. Exact-string matches only — never prefixes: CGNAT pools
    // are shared with thousands of strangers, and a /24-wide match would let them log in
    // as each other. The TTL bounds how long a recycled IP + username grants passwordless
    // entry; the SmartMode and per-user SmartLoginOptOut gates still apply at call sites.
    private static readonly TimeSpan KnownIpTtl = TimeSpan.FromDays(14);
    private static readonly TimeSpan KnownIpRefreshThrottle = TimeSpan.FromHours(1);
    private const int MaxKnownIps = 5;

    private sealed record KnownIpEntry(string Ip, DateTime LastSeenUtc);

    /// <summary>
    /// Records that this user was seen from an IP (login, authenticated page load).
    /// Throttled so routine page loads from an already-known IP do not rewrite the row.
    /// </summary>
    public void RecordKnownIp(Guid userId, string? ip)
    {
        if (string.IsNullOrEmpty(ip) || !_users.TryGetValue(userId, out var user))
            return;

        var entries = ParseKnownIps(user.KnownIps);

        var existing = entries.FirstOrDefault(e => string.Equals(e.Ip, ip, StringComparison.Ordinal));
        if (existing != null && DateTime.UtcNow - existing.LastSeenUtc < KnownIpRefreshThrottle)
            return;

        entries.RemoveAll(e => string.Equals(e.Ip, ip, StringComparison.Ordinal));
        entries.Insert(0, new KnownIpEntry(ip, DateTime.UtcNow));
        if (entries.Count > MaxKnownIps)
            entries.RemoveRange(MaxKnownIps, entries.Count - MaxKnownIps);

        user.KnownIps = System.Text.Json.JsonSerializer.Serialize(entries);
        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Smart login: was this user seen from this exact IP within the TTL? Complements
    /// ChatService.HasActiveSessionFromIp so smart login keeps working after restarts
    /// and closed sessions instead of requiring a live connection.
    /// </summary>
    /// <summary>"Sign out all other devices" forgets the remembered networks, so a signed-out device on the same
    /// network does not walk back in through smart login (AU-20).</summary>
    public void ForgetKnownIps(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user)) return;
        user.KnownIps = null;
        _writer.Enqueue(Writes.User(user));
    }

    // ---- known devices (AU-20): a device cannot sign the others out within its first hour ----

    public static readonly TimeSpan NewDevicePeriod = TimeSpan.FromHours(1);
    private const int MaxKnownDevices = 20;
    private sealed record KnownDeviceEntry(string Id, DateTime FirstSeenUtc);

    /// <summary>The first hub connection of a device records it. The entry is never refreshed: its age is the point.
    /// A given <paramref name="firstSeenUtc"/> replaces the entry (a test makes a device old).</summary>
    public void RecordDevice(Guid userId, string? deviceId, DateTime? firstSeenUtc = null)
    {
        if (string.IsNullOrEmpty(deviceId) || deviceId == "unknown" || !_users.TryGetValue(userId, out var user)) return;
        var entries = ParseKnownDevices(user.KnownDevices);
        if (firstSeenUtc is null && entries.Any(e => e.Id == deviceId)) return;
        entries.RemoveAll(e => e.Id == deviceId);
        entries.Add(new KnownDeviceEntry(deviceId, firstSeenUtc ?? DateTime.UtcNow));
        if (entries.Count > MaxKnownDevices) entries.RemoveRange(0, entries.Count - MaxKnownDevices);   // the oldest go; an old device dropped here counts as new again, which errs on the safe side
        user.KnownDevices = System.Text.Json.JsonSerializer.Serialize(entries);
        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>When this device may sign the others out: now for a device older than an hour, else the end of its
    /// first hour. A device the server never saw counts as new, so a made-up id gains nothing.</summary>
    public DateTime SignOutOthersAllowedAt(Guid userId, string? deviceId)
    {
        var now = DateTime.UtcNow;
        if (string.IsNullOrEmpty(deviceId) || !_users.TryGetValue(userId, out var user)) return now + NewDevicePeriod;
        var entry = ParseKnownDevices(user.KnownDevices).FirstOrDefault(e => e.Id == deviceId);
        if (entry is null) return now + NewDevicePeriod;
        var allowedAt = entry.FirstSeenUtc + NewDevicePeriod;
        return allowedAt <= now ? now : allowedAt;
    }

    /// <summary>After "Sign out all other devices": only the device that did it stays known. The others sign in
    /// again as new devices, with the hour that comes with it.</summary>
    public void ForgetOtherDevices(Guid userId, string deviceId)
    {
        if (!_users.TryGetValue(userId, out var user)) return;
        var entries = ParseKnownDevices(user.KnownDevices).Where(e => e.Id == deviceId).ToList();
        user.KnownDevices = entries.Count == 0 ? null : System.Text.Json.JsonSerializer.Serialize(entries);
        _writer.Enqueue(Writes.User(user));
    }

    private static List<KnownDeviceEntry> ParseKnownDevices(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try { return System.Text.Json.JsonSerializer.Deserialize<List<KnownDeviceEntry>>(json) ?? []; }
        catch { return []; }
    }

    public bool HasRecentKnownIp(string username, string? ip)
    {
        if (string.IsNullOrEmpty(ip))
            return false;

        var user = GetByUsername(username);
        if (user == null)
            return false;

        return ParseKnownIps(user.KnownIps).Any(e =>
            string.Equals(e.Ip, ip, StringComparison.Ordinal) &&
            DateTime.UtcNow - e.LastSeenUtc <= KnownIpTtl);
    }

    private static List<KnownIpEntry> ParseKnownIps(string? json)
    {
        if (string.IsNullOrEmpty(json))
            return [];

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<List<KnownIpEntry>>(json) ?? [];
        }
        catch
        {
            return []; // corrupt blob — start fresh rather than break logins
        }
    }

    #endregion

    /// <summary>
    /// Generates a random passphrase in "color animal NN" format.
    /// </summary>
    public static string GeneratePassphrase()
    {
        var colors = new[] { "red", "blue", "green", "gold", "pink", "cyan", "lime", "teal",
            "plum", "mint", "ruby", "jade", "coral", "amber", "ivory", "peach", "sage", "navy", "rust", "wine" };
        var animals = new[] { "cat", "dog", "fox", "owl", "bee", "bat", "elk", "ant", "emu", "yak",
            "ape", "cod", "cow", "hen", "jay", "koi", "ram", "rat", "ray", "seal",
            "wolf", "bear", "deer", "frog", "hawk", "lion", "lynx", "moth", "puma", "swan" };

        var color = colors[RandomNumberGenerator.GetInt32(colors.Length)];
        var animal = animals[RandomNumberGenerator.GetInt32(animals.Length)];
        var number = RandomNumberGenerator.GetInt32(10, 100);

        return $"{color} {animal} {number}";
    }

    /// <summary>
    /// Rotates the auth token for a user. Invalidates the old token and returns the new one.
    /// Used when signing out all other devices — caller sets the new token on the current device's cookie.
    /// </summary>
    public string? RotateToken(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return null;

        var oldToken = user.Token;
        var newToken = GenerateToken();

        _tokenToId.TryRemove(oldToken, out _);
        _tokenToId[newToken] = userId;
        user.Token = newToken;

        _writer.Enqueue(Writes.User(user));
        _logger.LogInformation("Rotated token for user {Username}", user.Username);

        return newToken;
    }

    /// <summary>
    /// The status the person picked in the status menu (PR-01). PresenceService calls this and tells the
    /// person's other devices.
    /// </summary>
    public void SetStatus(Guid userId, UserStatus status)
    {
        if (!_users.TryGetValue(userId, out var user)) return;
        user.Status = status;
        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// One use of an emoji from a reaction (MR-44) or a tab of an older build (SH-50).
    /// </summary>
    public void RecordEmojiUse(Guid userId, string? emoji)
    {
        if (string.IsNullOrEmpty(emoji) || emoji.Length > 64) return;
        RecordEmojiUses(userId, [emoji]);
    }

    /// <summary>
    /// Moves each emoji to the front of the 20 recent emoji in order: the last item becomes the first cell,
    /// the same as tapping them one by one in the picker (PK-07).
    /// </summary>
    public void RecordEmojiUses(Guid userId, IReadOnlyList<string>? emojis)
    {
        if (emojis is null || emojis.Count == 0 || !_users.TryGetValue(userId, out var user)) return;
        List<string>? snapshot = null;
        // Protects the read-modify-write of RecentEmojis across concurrent hub calls.
        // It does not guard PersistenceWriter, which reads the User fields later on its own thread (Writes.cs:90).
        lock (user)
        {
            var recent = GetRecentEmojis(user.Username);
            var before = user.RecentEmojis;
            var anyValid = false;
            foreach (var emoji in emojis.TakeLast(20))   // the list is in the order of use, so its end holds the newest; Take(20) kept the oldest
            {
                if (string.IsNullOrEmpty(emoji) || emoji.Length > 64) continue;
                recent.Remove(emoji);
                recent.Insert(0, emoji);
                anyValid = true;
            }
            if (!anyValid) return;
            if (recent.Count > 20) recent.RemoveRange(20, recent.Count - 20);
            var serialized = System.Text.Json.JsonSerializer.Serialize(recent);
            if (serialized != before)
            {
                user.RecentEmojis = serialized;
                snapshot = recent;
            }
        }
        if (snapshot is not null)
        {
            _writer.Enqueue(Writes.User(user));
            OnRecentEmojiChanged?.Invoke(userId, snapshot);
        }
    }

    /// <summary>
    /// Gets the recent emojis list for a user (deserialized from in-memory User).
    /// </summary>
    public List<string> GetRecentEmojis(string username)
    {
        var user = GetByUsername(username);
        if (user?.RecentEmojis == null) return new();

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<List<string>>(user.RecentEmojis) ?? new();
        }
        catch
        {
            return new();
        }
    }

    /// <summary>
    /// Gets the recent GIF entry IDs for a user (deserialized from in-memory User).
    /// </summary>
    public List<Guid> GetRecentGifs(string username)
    {
        var user = GetByUsername(username);
        if (user?.RecentGifs == null) return new();

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<List<Guid>>(user.RecentGifs) ?? new();
        }
        catch
        {
            return new();
        }
    }

    public void UpdateRecentGifs(Guid userId, List<Guid> gifIds)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.RecentGifs = System.Text.Json.JsonSerializer.Serialize(gifIds);
        _writer.Enqueue(Writes.User(user));
    }

    /// <summary>
    /// Generates a secure random token.
    /// </summary>
    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }
}
