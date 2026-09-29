using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Yap.Data;
using Yap.Models;

namespace Yap.Services;

/// <summary>
/// Invite and login links (<c>/invite/{code}</c>): mints codes, resolves them, and keeps the
/// in-memory mirror of the AccessLinks table (loaded once at startup, like UserService).
/// </summary>
/// <remarks>
/// Deliberately independent of sessions and of <see cref="User.Token"/>. "Sign out other
/// devices" rotates the token and the passphrase but leaves links alone, so the link a user
/// keeps in their messenger stays the way back in. A leaked link needs an explicit revoke.
///
/// A code has no username in front of it, so one guess is a guess at every account at once.
/// Every failed lookup therefore feeds one global brake: after <see cref="BrakeFailureLimit"/>
/// failures inside <see cref="BrakeWindow"/>, all code sign-ins pause for
/// <see cref="BrakeDuration"/> and <see cref="OnBrakeTripped"/> fires (the bot DMs the admin).
/// Real users click links, so they almost never fail. The invite page counts misses too;
/// otherwise the page itself would be a free validity oracle.
/// </remarks>
public class AccessLinkService
{
    private const int BrakeFailureLimit = 20;
    private static readonly TimeSpan BrakeWindow = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan BrakeDuration = TimeSpan.FromMinutes(10);

    private readonly IDbContextFactory<ChatDbContext>? _dbFactory;
    private readonly ILogger<AccessLinkService> _logger;

    private readonly ConcurrentDictionary<Guid, AccessLink> _links = new();
    // Keyed by the compact form ("bluefox4821") so "Blue Fox 4821" and "blue-fox-4821" both resolve.
    private readonly ConcurrentDictionary<string, Guid> _byCompactCode = new();
    private readonly object _lock = new();

    private readonly Queue<DateTime> _failures = new();
    private DateTime? _brakedUntil;
    private volatile string? _publicOrigin;

    /// <summary>Fired once per trip with the failure count. Subscribed by SystemBotService.</summary>
    public event Action<int>? OnBrakeTripped;

    public AccessLinkService(IServiceProvider serviceProvider, ILogger<AccessLinkService> logger)
    {
        _dbFactory = serviceProvider.GetService<IDbContextFactory<ChatDbContext>>();
        _logger = logger;
    }

    private bool PersistenceEnabled => _dbFactory != null;

    /// <summary>Loads every link from the database. Called once at startup, after users.</summary>
    public async Task LoadAsync()
    {
        if (!PersistenceEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            var rows = await db.AccessLinks.AsNoTracking().ToListAsync();
            foreach (var link in rows)
            {
                _links[link.Id] = link;
                _byCompactCode[Compact(link.Code)] = link.Id;
            }
            _logger.LogInformation("Loaded {Count} access links", rows.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load access links");
        }
    }

    #region Lookup

    /// <summary>Case- and separator-insensitive key: "Blue Fox 4821" → "bluefox4821".</summary>
    public static string Compact(string raw) =>
        new(raw.Where(char.IsAsciiLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    /// <summary>The link whose code matches, in any state. Callers check <see cref="AccessLink.IsActive"/>.</summary>
    public AccessLink? Find(string? rawCode)
    {
        if (string.IsNullOrEmpty(rawCode)) return null;
        var key = Compact(rawCode);
        return key.Length > 0 && _byCompactCode.TryGetValue(key, out var id) && _links.TryGetValue(id, out var link)
            ? link
            : null;
    }

    public AccessLink? GetActiveForUser(Guid userId) =>
        _links.Values.FirstOrDefault(l => l.UserId == userId && l.IsActive);

    public bool HasActiveLink(Guid userId) => GetActiveForUser(userId) != null;

    /// <summary>
    /// The typed-code path (VerifyDevice, /auth/signin with a password): the code must belong
    /// to this user. Keeping the username as a factor there also rules out any clash with an
    /// old passphrase that happens to read the same.
    /// </summary>
    public AccessLink? VerifyCodeForUser(Guid userId, string typedCode)
    {
        var link = Find(typedCode);
        return link is { IsActive: true } && link.UserId == userId ? link : null;
    }

    public IReadOnlyList<AccessLink> GetAll() => _links.Values.ToList();

    #endregion

    #region Minting and state changes

    /// <summary>An open invite: nobody owns it until the first person to open it picks a username.</summary>
    public Task<AccessLink?> CreateInviteAsync(Guid adminId, string? note, DateTime? expiresAt) =>
        InsertAsync(new AccessLink
        {
            CreatedById = adminId,
            Note = string.IsNullOrWhiteSpace(note) ? null : note.Trim(),
            ExpiresAt = expiresAt
        });

    /// <summary>
    /// Mints the user's login link. One active link per user: the previous one is revoked.
    /// That single rule is "New Link" in Settings, the link every new account is born with,
    /// and the admin's rescue for someone who lost every device.
    /// </summary>
    public async Task<AccessLink?> CreateForUserAsync(Guid userId, Guid createdById, DateTime? expiresAt = null)
    {
        var link = await InsertAsync(new AccessLink { UserId = userId, CreatedById = createdById, ExpiresAt = expiresAt });
        if (link == null) return null;

        foreach (var old in _links.Values.Where(l => l.UserId == userId && l.Id != link.Id && !l.IsRevoked).ToList())
            await RevokeAsync(old.Id);

        return link;
    }

    private async Task<AccessLink?> InsertAsync(AccessLink link)
    {
        lock (_lock)
        {
            // Loop only on the (practically impossible) collision with an existing code.
            do link.Code = AccessLinkCodes.Generate();
            while (!_byCompactCode.TryAdd(Compact(link.Code), link.Id));
            _links[link.Id] = link;
        }

        if (PersistenceEnabled)
        {
            try
            {
                await using var db = await _dbFactory!.CreateDbContextAsync();
                db.AccessLinks.Add(link);
                await db.SaveChangesAsync();
            }
            catch (Exception ex)
            {
                _links.TryRemove(link.Id, out _);
                _byCompactCode.TryRemove(Compact(link.Code), out _);
                _logger.LogError(ex, "Failed to persist new access link");
                return null;
            }
        }

        return link;
    }

    public async Task RevokeAsync(Guid linkId)
    {
        if (!_links.TryGetValue(linkId, out var link) || link.IsRevoked) return;

        var at = DateTime.UtcNow;
        link.RevokedAt = at;
        await PersistAsync(linkId, "revoke", q => q.ExecuteUpdateAsync(s => s.SetProperty(l => l.RevokedAt, at)));
    }

    public async Task SetExpiryAsync(Guid linkId, DateTime? expiresAt)
    {
        if (!_links.TryGetValue(linkId, out var link)) return;

        link.ExpiresAt = expiresAt;
        await PersistAsync(linkId, "expiry", q => q.ExecuteUpdateAsync(s => s.SetProperty(l => l.ExpiresAt, expiresAt)));
    }

    /// <summary>Counts one successful sign-in through the link.</summary>
    public async Task RecordUseAsync(AccessLink link)
    {
        DateTime? first;
        DateTime last;
        int count;
        lock (_lock)
        {
            last = DateTime.UtcNow;
            link.FirstUsedAt ??= last;
            link.LastUsedAt = last;
            link.UseCount++;
            first = link.FirstUsedAt;
            count = link.UseCount;
        }

        await PersistAsync(link.Id, "use", q => q.ExecuteUpdateAsync(s => s
            .SetProperty(l => l.FirstUsedAt, first)
            .SetProperty(l => l.LastUsedAt, last)
            .SetProperty(l => l.UseCount, count)));
    }

    /// <summary>
    /// Turns an open invite into the new account's login link. False when someone else
    /// claimed it first; the lock makes the check-and-set atomic.
    /// </summary>
    public async Task<bool> ClaimAsync(AccessLink link, Guid userId)
    {
        lock (_lock)
        {
            if (link.UserId != null || !link.IsActive) return false;
            link.UserId = userId;
        }

        await PersistAsync(link.Id, "claim", q => q.ExecuteUpdateAsync(s => s.SetProperty(l => l.UserId, userId)));
        await RecordUseAsync(link);
        return true;
    }

    private async Task PersistAsync(Guid linkId, string what, Func<IQueryable<AccessLink>, Task> update)
    {
        if (!PersistenceEnabled) return;

        try
        {
            await using var db = await _dbFactory!.CreateDbContextAsync();
            await update(db.AccessLinks.Where(l => l.Id == linkId));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist access link {What} ({LinkId})", what, linkId);
        }
    }

    #endregion

    #region Failure brake

    public bool IsBraked
    {
        get { lock (_lock) return _brakedUntil is { } until && until > DateTime.UtcNow; }
    }

    /// <summary>
    /// Call on every failed code check: the invite page, the redeem endpoint, and the typed
    /// code on VerifyDevice (which also covers passphrase guessing, a bonus).
    /// </summary>
    public void RecordFailure()
    {
        var tripped = 0;
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            _failures.Enqueue(now);
            while (_failures.Count > 0 && now - _failures.Peek() > BrakeWindow)
                _failures.Dequeue();

            var alreadyBraked = _brakedUntil is { } until && until > now;
            if (_failures.Count >= BrakeFailureLimit && !alreadyBraked)
            {
                _brakedUntil = now + BrakeDuration;
                tripped = _failures.Count;
                _failures.Clear();
            }
        }

        if (tripped > 0)
        {
            _logger.LogWarning("Access-link brake tripped after {Count} failures; code sign-ins paused for {Minutes} min",
                tripped, BrakeDuration.TotalMinutes);
            OnBrakeTripped?.Invoke(tripped);
        }
    }

    #endregion

    #region Public URL

    /// <summary>
    /// Learns the site's public origin from real page loads (AuthMiddleware), so bot DMs can
    /// carry a clickable absolute link without a config key. Honors X-Forwarded-Proto: the
    /// app sits behind a TLS-terminating proxy, where Request.Scheme would say http.
    /// </summary>
    public void ObserveOrigin(HttpContext context)
    {
        var scheme = context.Request.Headers["X-Forwarded-Proto"].FirstOrDefault()?.Split(',')[0].Trim();
        if (string.IsNullOrEmpty(scheme)) scheme = context.Request.Scheme;

        var host = context.Request.Host;
        if (!host.HasValue) return;

        var origin = $"{scheme}://{host.Value}";
        if (origin != _publicOrigin) _publicOrigin = origin;
    }

    /// <summary>Absolute when the origin is known, else site-relative (still works as an href).</summary>
    public string BuildUrl(string code) => $"{_publicOrigin}/invite/{code}";

    #endregion
}
