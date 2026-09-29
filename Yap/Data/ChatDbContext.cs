using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Yap.Models;

namespace Yap.Data;

public class ChatDbContext : DbContext
{
    public DbSet<User> Users { get; set; } = null!;
    public DbSet<Channel> Channels { get; set; } = null!;
    public DbSet<ChatMessage> Messages { get; set; } = null!;
    public DbSet<Reaction> Reactions { get; set; } = null!;
    public DbSet<ChannelReadState> ChannelReadStates { get; set; } = null!;
    public DbSet<ChannelNotificationSetting> ChannelNotificationSettings { get; set; } = null!;
    public DbSet<PushSubscription> PushSubscriptions { get; set; } = null!;
    public DbSet<UserActionLog> UserActionLogs { get; set; } = null!;
    public DbSet<UserNote> UserNotes { get; set; } = null!;
    public DbSet<MediaUploadLog> MediaUploadLogs { get; set; } = null!;
    public DbSet<GifEntry> GifEntries { get; set; } = null!;
    public DbSet<FavoriteGif> FavoriteGifs { get; set; } = null!;
    public DbSet<AccessLink> AccessLinks { get; set; } = null!;

    public ChatDbContext(DbContextOptions<ChatDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // User configuration
        modelBuilder.Entity<User>(entity =>
        {
            entity.HasKey(u => u.Id);
            entity.HasIndex(u => u.Username).IsUnique();
            entity.HasIndex(u => u.Token).IsUnique();
            entity.Property(u => u.Username).HasMaxLength(32);
            entity.Property(u => u.DisplayName).HasMaxLength(64);
            entity.Property(u => u.Token).HasMaxLength(64);
            entity.Property(u => u.ProfilePictureUrl).HasMaxLength(256);
            entity.Property(u => u.Bio).HasMaxLength(150);
            entity.Property(u => u.Password).HasMaxLength(64);
            entity.Property(u => u.RecentEmojis).HasMaxLength(2048);
            entity.Property(u => u.EmojiCounts).HasMaxLength(2048);
            entity.Property(u => u.RecentGifs).HasMaxLength(2048);
            entity.Property(u => u.Theme).HasMaxLength(32);

            entity.Property(u => u.NotifDmMode).HasConversion<int>();
            // Rooms are muted by default, so existing rows must land on MuteAll rather than the
            // enum's 0 (AllowAll) — otherwise the migration would start pushing every room message
            // to every user who has ever installed the PWA.
            //
            // The sentinel is load-bearing next to HasDefaultValue: without it EF treats the CLR
            // default (0 = AllowAll) as "not set" and omits the column on INSERT, so a user
            // deliberately created with rooms allowed would silently land on MuteAll. -1 is not a
            // valid NotificationMode, so every insert now writes the real value.
            entity.Property(u => u.NotifRoomMode).HasConversion<int>()
                  .HasDefaultValue(NotificationMode.MuteAll)
                  .HasSentinel((NotificationMode)(-1));

            // Ignore computed property
            entity.Ignore(u => u.EffectiveDisplayName);
        });

        // Channel configuration
        modelBuilder.Entity<Channel>(entity =>
        {
            entity.HasKey(c => c.Id);
            entity.Property(c => c.Type).HasConversion<int>();
            entity.HasIndex(c => new { c.Type, c.Name });
            entity.HasIndex(c => new { c.Participant1Id, c.Participant2Id });

            entity.HasMany(c => c.Messages)
                  .WithOne(m => m.Channel)
                  .HasForeignKey(m => m.ChannelId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasMany(c => c.ReadStates)
                  .WithOne(rs => rs.Channel)
                  .HasForeignKey(rs => rs.ChannelId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(c => c.Creator)
                  .WithMany()
                  .HasForeignKey(c => c.CreatedById)
                  .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne(c => c.Participant1User)
                  .WithMany()
                  .HasForeignKey(c => c.Participant1Id)
                  .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne(c => c.Participant2User)
                  .WithMany()
                  .HasForeignKey(c => c.Participant2Id)
                  .OnDelete(DeleteBehavior.SetNull);

            entity.Property(c => c.Description).HasMaxLength(500);
            entity.Property(c => c.WritePermission).HasConversion<int>();
            entity.Property(c => c.HistoryLimit).HasConversion<int>();

            // Ignore computed property
            entity.Ignore(c => c.IsDirectMessage);
        });

        // ChatMessage configuration
        modelBuilder.Entity<ChatMessage>(entity =>
        {
            entity.HasKey(m => m.Id);
            entity.HasIndex(m => m.ChannelId);
            entity.HasIndex(m => m.UserId);
            entity.HasIndex(m => m.Timestamp);
            entity.HasIndex(m => new { m.ChannelId, m.Timestamp });

            // Store ImageUrls as JSON
            entity.Property(m => m.ImageUrls).HasConversion(
                v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
                v => JsonSerializer.Deserialize<List<string>>(v, (JsonSerializerOptions?)null) ?? new List<string>()
            );

            // Store VideoUrls as JSON (guard null/empty for existing rows before migration)
            entity.Property(m => m.VideoUrls).HasConversion(
                v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
                v => string.IsNullOrEmpty(v) ? new List<string>() : JsonSerializer.Deserialize<List<string>>(v, (JsonSerializerOptions?)null) ?? new List<string>()
            );

            // Store GifAttachments as JSON (guard null/empty for existing rows before migration)
            entity.Property(m => m.GifAttachments).HasConversion(
                v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
                v => string.IsNullOrEmpty(v) ? new List<GifAttachment>() : JsonSerializer.Deserialize<List<GifAttachment>>(v, (JsonSerializerOptions?)null) ?? new List<GifAttachment>()
            );

            entity.HasMany(m => m.Reactions)
                  .WithOne(r => r.Message)
                  .HasForeignKey(r => r.MessageId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(m => m.User)
                  .WithMany()
                  .HasForeignKey(m => m.UserId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.Property(m => m.ReplyToMessageId);

            // Ignore computed properties
            entity.Ignore(m => m.HasImages);
            entity.Ignore(m => m.HasVideos);
            entity.Ignore(m => m.HasGifs);
            entity.Ignore(m => m.HasMedia);
        });

        // GifEntry configuration
        modelBuilder.Entity<GifEntry>(entity =>
        {
            entity.HasKey(g => g.Id);
            entity.Property(g => g.SourceProviderId).HasMaxLength(32);
            entity.Property(g => g.SourceId).HasMaxLength(128);
            entity.Property(g => g.Mp4Url).HasMaxLength(512);
            entity.Property(g => g.WebmUrl).HasMaxLength(512);
            entity.Property(g => g.GifUrl).HasMaxLength(512);
            entity.Property(g => g.PreviewUrl).HasMaxLength(512);
            entity.Property(g => g.RemoteMp4Url).HasMaxLength(1024);
            entity.Property(g => g.RemoteWebmUrl).HasMaxLength(1024);
            entity.Property(g => g.RemoteGifUrl).HasMaxLength(1024);
            entity.Property(g => g.OriginalContentType).HasMaxLength(64);
            entity.Property(g => g.TranscodeStatus).HasConversion<int>();
            entity.Property(g => g.Tags).HasMaxLength(2048);
            entity.Property(g => g.ServerFolder).HasMaxLength(64);
            entity.Property(g => g.ContentHash).HasMaxLength(64);

            // Unique-when-not-null is enforced via filtered index where supported (SQL Server).
            // For SQLite/Postgres we accept duplicates and dedup in code (the in-memory provider+sourceId
            // index in GifService prevents duplicate inserts in practice).
            entity.HasIndex(g => new { g.SourceProviderId, g.SourceId });
            entity.HasIndex(g => g.LastUsedAt);
            entity.HasIndex(g => g.UploadedByUserId);

            entity.HasOne(g => g.UploadedByUser)
                  .WithMany()
                  .HasForeignKey(g => g.UploadedByUserId)
                  .OnDelete(DeleteBehavior.SetNull);
        });

        // FavoriteGif configuration (composite primary key, like ChannelReadState)
        modelBuilder.Entity<FavoriteGif>(entity =>
        {
            entity.HasKey(f => new { f.UserId, f.GifEntryId });
            entity.Property(f => f.Folder).HasMaxLength(64);

            entity.HasOne(f => f.User)
                  .WithMany()
                  .HasForeignKey(f => f.UserId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(f => f.GifEntry)
                  .WithMany()
                  .HasForeignKey(f => f.GifEntryId)
                  .OnDelete(DeleteBehavior.Cascade);

            entity.HasIndex(f => f.GifEntryId);
        });

        // AccessLink configuration (invite / login links)
        modelBuilder.Entity<AccessLink>(entity =>
        {
            entity.HasKey(l => l.Id);
            entity.HasIndex(l => l.Code).IsUnique();
            entity.HasIndex(l => l.UserId);
            entity.Property(l => l.Code).HasMaxLength(64);
            entity.Property(l => l.Note).HasMaxLength(64);

            // The owner's link dies with the owner. CreatedById has no FK on purpose: the
            // admin who minted an invite is bookkeeping, not a dependency.
            entity.HasOne<User>()
                  .WithMany()
                  .HasForeignKey(l => l.UserId)
                  .OnDelete(DeleteBehavior.Cascade);

            // Computed state, never columns
            entity.Ignore(l => l.IsRevoked);
            entity.Ignore(l => l.IsExpired);
            entity.Ignore(l => l.IsActive);
            entity.Ignore(l => l.IsClaimed);
            entity.Ignore(l => l.AdminCanSeeCode);
        });

        // Reaction configuration
        modelBuilder.Entity<Reaction>(entity =>
        {
            entity.HasKey(r => r.Id);
            entity.HasIndex(r => new { r.MessageId, r.Emoji, r.UserId }).IsUnique();

            entity.HasOne(r => r.User)
                  .WithMany()
                  .HasForeignKey(r => r.UserId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        // ChannelReadState configuration (composite primary key)
        modelBuilder.Entity<ChannelReadState>(entity =>
        {
            entity.HasKey(rs => new { rs.UserId, rs.ChannelId });

            entity.HasOne(rs => rs.User)
                  .WithMany()
                  .HasForeignKey(rs => rs.UserId)
                  .OnDelete(DeleteBehavior.Cascade);
        });

        // ChannelNotificationSetting configuration (composite primary key, like ChannelReadState)
        modelBuilder.Entity<ChannelNotificationSetting>(entity =>
        {
            entity.HasKey(s => new { s.UserId, s.ChannelId });

            entity.HasOne(s => s.User)
                  .WithMany()
                  .HasForeignKey(s => s.UserId)
                  .OnDelete(DeleteBehavior.Cascade);

            // No FK to Channel: a deleted room should not silently drop the override, and the
            // in-memory evaluation ignores rows whose channel is gone anyway.
            entity.HasIndex(s => s.ChannelId);
        });

        // PushSubscription configuration
        modelBuilder.Entity<PushSubscription>(entity =>
        {
            entity.HasKey(p => p.Endpoint);
            entity.Property(p => p.Endpoint).HasMaxLength(2048);
            entity.HasIndex(p => p.Username);
        });

        // UserNote configuration
        modelBuilder.Entity<UserNote>(entity =>
        {
            entity.HasKey(n => n.Id);
            entity.HasIndex(n => new { n.AuthorId, n.TargetId }).IsUnique();
            entity.Property(n => n.Text).HasMaxLength(256);
        });

        // UserActionLog configuration
        modelBuilder.Entity<UserActionLog>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.HasIndex(e => e.UserUid);
            entity.HasIndex(e => e.Date);
            entity.HasIndex(e => e.Action);
            entity.Property(e => e.UserUid).HasMaxLength(64);
            entity.Property(e => e.Url).HasMaxLength(2048);
            entity.Property(e => e.Info).HasMaxLength(1024);
            entity.Property(e => e.IP).HasMaxLength(45); // IPv6 max
            entity.Property(e => e.UserAgent).HasMaxLength(512);
        });

        // MediaUploadLog configuration
        modelBuilder.Entity<MediaUploadLog>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.HasIndex(e => e.Date);
            entity.HasIndex(e => e.UserId);
            entity.HasIndex(e => e.FileType);
            entity.Property(e => e.Username).HasMaxLength(32);
            entity.Property(e => e.OriginalFileName).HasMaxLength(512);
            entity.Property(e => e.StoredFileName).HasMaxLength(256);
            entity.Property(e => e.FileType).HasMaxLength(16);
            entity.Property(e => e.Extension).HasMaxLength(16);
        });
    }
}
