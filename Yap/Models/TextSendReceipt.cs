namespace Yap.Models;

// Independent of Messages/Channels so deletion never makes an accepted operation reusable.
public class TextSendReceipt
{
    public Guid UserId { get; set; }
    public Guid OperationId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid MessageId { get; set; }
    public string ContentHash { get; set; } = "";
    public DateTime AcceptedAt { get; set; }
}
