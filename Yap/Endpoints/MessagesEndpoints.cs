using System.Security.Claims;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Chat;
using Yap.Services.Gifs;
using Yap.Services.Media;

namespace Yap.Endpoints;

/// <summary>
/// POST /api/channels/{id}/messages and POST /api/dm/{username}/messages: the one way to send. HTTP and not the
/// hub, because the offline outbox and the service worker's background sync must send without a hub connection
/// (docs/architecture/message-path.md). The second route addresses a direct message by its partner: a message
/// queued offline for a person whose direct message was never opened on the device has no channel id yet (OF-08).
/// Idempotent on (sender, clientId): a repeated send returns the first message with 200.
/// </summary>
public static class MessagesEndpoints
{
    public static void MapMessages(this RouteGroupBuilder api)
    {
        // Both routes are timed for the diagnostics table (AD-26): a send is HTTP, so the hub filter never sees it.
        api.MapPost("/channels/{channelId:guid}/messages", (Guid channelId, SendMessageRequest body, ClaimsPrincipal me,
            ChatService chat, GifService gifs, MessageMapper map) => SendAsync(channelId, body, me, chat, gifs, map))
            .AddEndpointFilter<ApiLatencyFilter>();

        api.MapPost("/dm/{username}/messages", (string username, SendMessageRequest body, ClaimsPrincipal me,
            ChatService chat, GifService gifs, MessageMapper map) =>
            chat.GetOrCreateDm(me.Id(), username) is { } dm
                ? SendAsync(dm.Id, body, me, chat, gifs, map)
                : Task.FromResult(Results.Problem("Unknown user", statusCode: 404)))
            .AddEndpointFilter<ApiLatencyFilter>();
    }

    private static async Task<IResult> SendAsync(Guid channelId, SendMessageRequest body, ClaimsPrincipal me, ChatService chat, GifService gifs, MessageMapper map)
    {
        // Media URLs come from this server's own upload endpoint. Anything else would let a message embed a
        // remote image, which is a tracking pixel for everyone who reads the room, or a path of this server
        // outside the uploads, which every reader's browser then asks for with the reader's cookie.
        if (body.Images?.Any(NotAnUpload) == true || body.Videos?.Any(NotAnUpload) == true || (body.Voice is { } v && NotAnUpload(v.Url ?? "")))
            return Results.Problem("Media must be uploaded first.", statusCode: 400);

        // Every GIF of the pick goes into the one message (IB-33); one that is gone refuses the whole send (PK-20).
        List<GifAttachment>? attachments = null;
        foreach (var gif in body.Gifs ?? [])
        {
            var attachment = gif.EntryId is { } entryId
                ? await gifs.SendCachedGifAsync(entryId, gif.SearchText, me.Id(), me.Username())
                : gif.Provider is { } item ? gifs.SendProviderGif(item, gif.SearchText, me.Id(), me.Username()) : null;
            if (attachment is null)
                return Results.Problem("That GIF isn't available anymore — try another one.", statusCode: 400);
            (attachments ??= []).Add(attachment);
        }

        var result = chat.Send(new SendMessage(channelId, me.Id(), me.Username(), body.Text ?? "")
        {
            ClientId = body.ClientId,
            ReplyToMessageId = body.ReplyToId,
            ImageUrls = body.Images,
            VideoUrls = body.Videos,
            GifAttachments = attachments,
            Voice = body.Voice,
        });
        return result.Message is { } message
            ? Results.Ok(map.From(message, me.Id()))
            : Results.Problem(result.Error, statusCode: result.Status);
    }

    private static bool NotAnUpload(string url) => !UploadPaths.IsUploadUrl(url);
}

/// <summary>The body of a send. Text, media or both. Each GIF is one entry of the library or one item from the provider.
/// A voice message comes alone, with the upload's URL and duration and the recorder's waveform (IB-70).</summary>
public sealed record SendMessageRequest(Guid? ClientId, string? Text, Guid? ReplyToId, List<string>? Images, List<string>? Videos, List<GifRequest>? Gifs, VoiceAttachment? Voice);

/// <summary><see cref="SearchText"/> becomes a tag of the GIF (PK-20).</summary>
public sealed record GifRequest(Guid? EntryId, GifSearchItem? Provider, string? SearchText);
