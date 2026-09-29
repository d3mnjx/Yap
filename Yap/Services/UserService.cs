using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Yap.Data;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Singleton service for user management with in-memory cache.
/// Handles user creation, authentication, and lookups.
/// </summary>
public class UserService
{
    private readonly IDbContextFactory<ChatDbContext>? _dbFactory;
    private readonly ILogger<UserService> _logger;
    private readonly bool _persistenceEnabled;

    // In-memory cache (mirrors database, like ChatService pattern)
    private readonly ConcurrentDictionary<Guid, User> _users = new();
    private readonly ConcurrentDictionary<string, Guid> _usernameToId = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, Guid> _tokenToId = new();

    // Admin tracking
    private Guid? _adminUserId;
    private readonly object _adminLock = new();

    // Dirty tracking for emoji data (flushed periodically, like UserActionLogService pattern)
    private readonly ConcurrentDictionary<Guid, byte> _dirtyEmojiUsers = new();
    private CancellationTokenSource? _flushCts;

    public UserService(IServiceProvider serviceProvider, ILogger<UserService> logger)
    {
        _logger = logger;
        _dbFactory = serviceProvider.GetService<IDbContextFactory<ChatDbContext>>();
        _persistenceEnabled = _dbFactory != null;

        // Register shutdown callback for final flush
        var lifetime = serviceProvider.GetService<IHostApplicationLifetime>();
        lifetime?.ApplicationStopping.Register(() => FlushDirtyEmojiDataAsync().GetAwaiter().GetResult());
    }

    /// <summary>
    /// Loads users from database on startup.
    /// </summary>
    public async Task LoadUsersAsync()
    {
        if (!_persistenceEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            var users = await db.Users.AsNoTracking().ToListAsync();

            var flattenedIds = new List<Guid>();
            foreach (var user in users)
            {
                _users[user.Id] = user;
                _usernameToId[user.Username] = user.Id;
                _tokenToId[user.Token] = user.Id;

                if (user.IsAdmin)
                {
                    _adminUserId = user.Id;
                }

                // Collapse raw usage counts to dense ranks once on load. Keeps the column
                // bounded and stops long-dead favorites from sitting at the top forever —
                // only relative order matters for quick reactions, not the magnitudes.
                if (FlattenEmojiCounts(user))
                    flattenedIds.Add(user.Id);
            }

            // Persist the collapsed counts back so the stored column actually shrinks.
            // Idempotent: once dense, re-flattening is a no-op and this loop stays empty.
            foreach (var id in flattenedIds)
            {
                if (!_users.TryGetValue(id, out var u)) continue;
                await db.Users
                    .Where(x => x.Id == id)
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.EmojiCounts, u.EmojiCounts));
            }

            _logger.LogInformation(
                "Loaded {Count} users; flattened emoji counts for {Flattened}",
                users.Count, flattenedIds.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load users from database");
        }

        // Start periodic flush for dirty emoji data
        StartEmojiFlushLoop();
    }

    /// <summary>
    /// Creates a new user with a generated token.
    /// </summary>
    public async Task<User?> CreateUserAsync(string username)
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

        // No passphrase at birth any more. New accounts get a login link instead, minted by
        // the caller (AuthEndpoints) because AccessLinkService sits above this service, and
        // the link's code doubles as the typed secret code. Accounts that already have a
        // passphrase keep it, and Settings can still enable one. The reason a credential
        // must exist from day one stands: a context that starts signed out (installed PWA,
        // second browser) otherwise has no way back in, and one real user forked into
        // seven accounts that way.
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

        // Persist to database
        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                db.Users.Add(user);
                await db.SaveChangesAsync();
                _logger.LogInformation("Created new user: {Username} (Admin: {IsAdmin})", username, isAdmin);
            }
            catch (Exception ex)
            {
                // Rollback in-memory changes on failure
                _users.TryRemove(user.Id, out _);
                _usernameToId.TryRemove(user.Username, out _);
                _tokenToId.TryRemove(user.Token, out _);

                if (isAdmin)
                {
                    lock (_adminLock)
                    {
                        _adminUserId = null;
                    }
                }

                _logger.LogError(ex, "Failed to persist new user: {Username}", username);
                return null;
            }
        }

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
    /// Checks if a username is already taken.
    /// </summary>
    public bool IsUsernameTaken(string username)
    {
        return _usernameToId.ContainsKey(username);
    }

    /// <summary>
    /// Gets all registered usernames.
    /// </summary>
    public List<string> GetAllUsernames() => _usernameToId.Keys.ToList();

    /// <summary>
    /// Gets all registered users.
    /// </summary>
    public List<User> GetAllUsers() => _users.Values.ToList();

    /// <summary>
    /// Updates the user's LastSeenAt timestamp.
    /// </summary>
    public async Task UpdateLastSeenAsync(Guid userId)
    {
        if (_users.TryGetValue(userId, out var user))
        {
            user.LastSeenAt = DateTime.UtcNow;

            if (_persistenceEnabled)
            {
                try
                {
                    await using var db = await _dbFactory!.CreateDbContextAsync();
                    await db.Users
                        .Where(u => u.Id == userId)
                        .ExecuteUpdateAsync(setters => setters
                            .SetProperty(u => u.LastSeenAt, DateTime.UtcNow));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to update LastSeenAt for user {UserId}", userId);
                }
            }
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
    /// Checks if a username is the admin.
    /// </summary>
    public bool IsAdmin(string username)
    {
        if (_usernameToId.TryGetValue(username, out var userId))
        {
            return IsAdmin(userId);
        }
        return false;
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
    /// Deletes a user (used when signing out).
    /// </summary>
    public async Task DeleteUserAsync(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        // Remove from in-memory cache
        _users.TryRemove(userId, out _);
        _usernameToId.TryRemove(user.Username, out _);
        _tokenToId.TryRemove(user.Token, out _);

        // If this was the admin, clear admin status
        lock (_adminLock)
        {
            if (_adminUserId == userId)
            {
                _adminUserId = null;
            }
        }

        // Delete from database (including related read states)
        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                // Delete read states first (foreign key constraint)
                await db.ChannelReadStates.Where(r => r.UserId == userId).ExecuteDeleteAsync();
                // Delete user
                await db.Users.Where(u => u.Id == userId).ExecuteDeleteAsync();
                _logger.LogInformation("Deleted user: {Username}", user.Username);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to delete user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Updates a user's profile (display name, profile picture, bio).
    /// </summary>
    public async Task UpdateProfileAsync(Guid userId, string? displayName, string? profilePictureUrl, string? bio, string? country)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        // Update in-memory cache
        user.DisplayName = displayName;
        user.ProfilePictureUrl = profilePictureUrl;
        user.Bio = bio;
        user.Country = country;

        // Persist to database
        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.DisplayName, displayName)
                        .SetProperty(u => u.ProfilePictureUrl, profilePictureUrl)
                        .SetProperty(u => u.Bio, bio)
                        .SetProperty(u => u.Country, country));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update profile for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Mutes or unmutes every notification for a user. <paramref name="until"/> is null for
    /// "until I turn it back on"; unmuting clears it.
    /// </summary>
    public async Task SetServerMuteAsync(Guid userId, bool muted, DateTime? until)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        var expiry = muted ? until : null;
        user.NotifServerMuted = muted;
        user.NotifServerMuteUntil = expiry;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.NotifServerMuted, muted)
                        .SetProperty(u => u.NotifServerMuteUntil, expiry));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update server mute for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Sets how DMs notify (allow all, mute all, or per-channel).
    /// </summary>
    public async Task SetDmNotificationModeAsync(Guid userId, NotificationMode mode)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifDmMode = mode;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters.SetProperty(u => u.NotifDmMode, mode));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update DM notification mode for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Sets how rooms notify (allow all, mute all, or per-channel).
    /// </summary>
    public async Task SetRoomNotificationModeAsync(Guid userId, NotificationMode mode)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifRoomMode = mode;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters.SetProperty(u => u.NotifRoomMode, mode));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update room notification mode for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Sets whether a DM partner with no override row notifies (Individual DM mode only).
    /// </summary>
    public async Task SetNewDmsMutedAsync(Guid userId, bool muted)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.NotifNewDmsMuted = muted;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters.SetProperty(u => u.NotifNewDmsMuted, muted));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update new-DM mute default for user {UserId}", userId);
            }
        }
    }

    public async Task SetSmartLoginOptOutAsync(Guid userId, bool optOut)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.SmartLoginOptOut = optOut;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.SmartLoginOptOut, optOut));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update SmartLoginOptOut for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Updates the user's selected color theme ID.
    /// </summary>
    public async Task UpdateThemeAsync(Guid userId, string? themeId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.Theme = themeId;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.Theme, themeId));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update Theme for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Updates the user's root font size (px). Null resets to the browser default.
    /// </summary>
    public async Task UpdateFontSizeAsync(Guid userId, int? fontSize)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        // Out-of-range values are stored as null — see User.MinFontSize for why.
        if (fontSize is < User.MinFontSize or > User.MaxFontSize)
            fontSize = null;

        user.FontSize = fontSize;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.FontSize, fontSize));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update FontSize for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Updates the user's timezone and locale (detected from browser).
    /// </summary>
    public async Task UpdateLocaleAsync(Guid userId, string? timeZone, string? locale, string? dateFormat = null)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.TimeZone = timeZone;
        user.Locale = locale;
        if (dateFormat != null)
            user.DateFormat = dateFormat;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.TimeZone, timeZone)
                        .SetProperty(u => u.Locale, locale)
                        .SetProperty(u => u.DateFormat, dateFormat ?? user.DateFormat));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update locale for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Records that the user was seen running Yap as an installed PWA (display-mode: standalone).
    /// Updates <see cref="User.PwaInstalledAt"/> to now. Idempotent per connect; only called by the
    /// client when it detects standalone mode, so non-PWA sessions never touch this.
    /// </summary>
    public async Task MarkPwaInstalledAsync(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        var now = DateTime.UtcNow;
        user.PwaInstalledAt = now;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.PwaInstalledAt, now));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update PWA install state for user {UserId}", userId);
            }
        }
    }

    /// <summary>
    /// Sets a passphrase for the user (enables multi-device login).
    /// </summary>
    public async Task SetPasswordAsync(Guid userId, string? password)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.Password = password;

        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.Password, password));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update password for user {UserId}", userId);
            }
        }
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
    /// In-memory only; the DB write batches with the dirty-user flush. Throttled so
    /// routine page loads from an already-known IP don't churn the dirty set.
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
        _dirtyEmojiUsers.TryAdd(userId, 0);
    }

    /// <summary>
    /// Smart login: was this user seen from this exact IP within the TTL? Complements
    /// ChatService.HasActiveSessionFromIp so smart login keeps working after restarts
    /// and closed sessions instead of requiring a circuit to still be alive.
    /// </summary>
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
    public async Task<string?> RotateTokenAsync(Guid userId)
    {
        if (!_users.TryGetValue(userId, out var user))
            return null;

        var oldToken = user.Token;
        var newToken = GenerateToken();

        // Update in-memory
        _tokenToId.TryRemove(oldToken, out _);
        _tokenToId[newToken] = userId;
        user.Token = newToken;

        // Persist to database
        if (_persistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.Token, newToken));
                _logger.LogInformation("Rotated token for user {Username}", user.Username);
            }
            catch (Exception ex)
            {
                // Rollback in-memory on failure
                _tokenToId.TryRemove(newToken, out _);
                _tokenToId[oldToken] = userId;
                user.Token = oldToken;
                _logger.LogError(ex, "Failed to rotate token for user {UserId}", userId);
                return null;
            }
        }

        return newToken;
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
        _dirtyEmojiUsers.TryAdd(userId, 0);
    }

    /// <summary>
    /// Gets the emoji usage counts for a user (deserialized from in-memory User).
    /// </summary>
    public Dictionary<string, int> GetEmojiCounts(string username)
    {
        var user = GetByUsername(username);
        if (user?.EmojiCounts == null) return new();

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, int>>(user.EmojiCounts) ?? new();
        }
        catch
        {
            return new();
        }
    }

    /// <summary>
    /// Collapses a user's raw emoji usage counts to dense ranks (lowest count → 1, next
    /// distinct → 2, …), keeping the 40 highest-ranked. Only relative order matters for
    /// quick reactions, so this bounds the stored column and lets recent usage climb past
    /// stale favorites. Mutates user.EmojiCounts; returns true if the value actually changed.
    /// Idempotent — a dense 1..n sequence re-ranks to itself.
    /// </summary>
    private static bool FlattenEmojiCounts(User user)
    {
        if (string.IsNullOrEmpty(user.EmojiCounts)) return false;

        Dictionary<string, int>? counts;
        try { counts = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, int>>(user.EmojiCounts); }
        catch { return false; }
        if (counts is null || counts.Count == 0) return false;

        // Dense-rank the distinct count values: smallest → 1, largest → N.
        var ranks = counts.Values.Distinct().OrderBy(x => x)
            .Select((val, index) => new { val, index })
            .ToDictionary(x => x.val, x => x.index + 1);

        // Replace each emoji's count with its rank; keep the top 40, drop the long tail.
        var flattened = counts
            .Select(kvp => new { kvp.Key, Rank = ranks[kvp.Value] })
            .OrderByDescending(x => x.Rank)
            .Take(40)
            .ToDictionary(x => x.Key, x => x.Rank);

        var serialized = System.Text.Json.JsonSerializer.Serialize(flattened);
        if (serialized == user.EmojiCounts) return false; // already flat — skip the write

        user.EmojiCounts = serialized;
        return true;
    }

    /// <summary>
    /// Updates the recent emojis list for a user. In-memory only; DB write is batched.
    /// </summary>
    public void UpdateRecentEmojis(Guid userId, List<string> emojis)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.RecentEmojis = System.Text.Json.JsonSerializer.Serialize(emojis);
        _dirtyEmojiUsers.TryAdd(userId, 0);
    }

    /// <summary>
    /// Updates the emoji usage counts for a user. In-memory only; DB write is batched.
    /// </summary>
    public void UpdateEmojiCounts(Guid userId, Dictionary<string, int> counts)
    {
        if (!_users.TryGetValue(userId, out var user))
            return;

        user.EmojiCounts = System.Text.Json.JsonSerializer.Serialize(counts);
        _dirtyEmojiUsers.TryAdd(userId, 0);
    }

    #region Emoji Flush

    private static readonly TimeSpan EmojiFlushInterval = TimeSpan.FromSeconds(10);

    private void StartEmojiFlushLoop()
    {
        if (!_persistenceEnabled) return;

        _flushCts = new CancellationTokenSource();
        _ = EmojiFlushLoopAsync(_flushCts.Token);
    }

    private async Task EmojiFlushLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(EmojiFlushInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                await FlushDirtyEmojiDataAsync();
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task FlushDirtyEmojiDataAsync()
    {
        if (_dirtyEmojiUsers.IsEmpty || !_persistenceEnabled) return;

        // Snapshot and clear dirty set
        var dirtyIds = _dirtyEmojiUsers.Keys.ToList();
        foreach (var id in dirtyIds)
            _dirtyEmojiUsers.TryRemove(id, out _);

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();

            foreach (var userId in dirtyIds)
            {
                if (!_users.TryGetValue(userId, out var user)) continue;

                await db.Users
                    .Where(u => u.Id == userId)
                    .ExecuteUpdateAsync(setters => setters
                        .SetProperty(u => u.RecentEmojis, user.RecentEmojis)
                        .SetProperty(u => u.EmojiCounts, user.EmojiCounts)
                        .SetProperty(u => u.RecentGifs, user.RecentGifs)
                        .SetProperty(u => u.KnownIps, user.KnownIps));
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to flush emoji data for {Count} users", dirtyIds.Count);
        }
    }

    #endregion

    /// <summary>
    /// Generates a secure random token.
    /// </summary>
    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }
}
