namespace Yap.Models;

/// <summary>
/// Tracks when a user last read a channel and their unread count.
/// Uses a composite primary key of (UserId, ChannelId).
/// </summary>
public class ChannelReadState
{
    /// <summary>
    /// The user whose read state this represents.
    /// </summary>
    public Guid UserId { get; set; }

    /// <summary>
    /// The channel being tracked.
    /// </summary>
    public Guid ChannelId { get; set; }

    /// <summary>
    /// When the user last read/viewed this channel.
    /// </summary>
    public DateTime LastReadAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Denormalized unread count for fast reads.
    /// Incremented when messages arrive, reset when channel is viewed.
    /// </summary>
    public int UnreadCount { get; set; }

    // Monotonic checkpoints: offline reads may acknowledge only the received count they observed.
    public long ReceivedCount { get; set; }
    public long ReadThrough { get; set; }

    // Navigation properties
    public User User { get; set; } = null!;
    public Channel Channel { get; set; } = null!;
}
