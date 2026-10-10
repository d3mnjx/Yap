using Yap.Models;

namespace Yap.Services;

// A validated change, applied identically to the storage row and the existing live object.
// Ownership, visibility and media-edit policy belong to ChatService.Actions.
public sealed record ChatMutation(string Kind, string? Content, string? Emoji, bool Active, Guid UserId, string Username)
{
    public void Apply(ChatMessage message)
    {
        if (Kind == "edit")
        {
            message.Content = Content!;
            message.IsEdited = true;
        }
        else if (Kind == "reaction")
        {
            if (!Active) message.Reactions.RemoveAll(r => r.UserId == UserId && r.Emoji == Emoji);
            else if (!message.Reactions.Any(r => r.UserId == UserId && r.Emoji == Emoji))
                message.Reactions.Add(new Reaction { MessageId = message.Id, UserId = UserId, Username = Username, Emoji = Emoji! });
        }
    }
}
