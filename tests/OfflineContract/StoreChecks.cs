using Microsoft.Extensions.DependencyInjection;
using Yap.Models;
using Yap.Services;

static class StoreChecks
{
    public static async Task Run(IServiceProvider services, User user)
    {
        var chat = services.GetRequiredService<ChatService>();
        var store = services.GetRequiredService<IChatStore>();
        var channel = chat.GetLobbyId();
        var sent = await chat.SendTextAsync(user, channel, Guid.NewGuid(), "object identity");
        var target = chat.GetMessageById(channel, sent.MessageId)!;
        await chat.MutateMessageAsync(user, channel, target.Id, Guid.NewGuid(), "edit", "same object", null, false);
        Check(ReferenceEquals(target, chat.GetMessageById(channel, target.Id)) && target.Content == "same object",
            "accepted mutation updates the existing live object without reloading a storage row");
        var other = (await services.GetRequiredService<UserService>().CreateUserAsync("collisionfixture"))!;
        var collision = await chat.SendTextAsync(other, channel, sent.OperationId, "collision");
        Check(sent.MessageId != sent.OperationId && collision.MessageId != sent.MessageId,
            "accounts can reuse an operation ID without choosing or colliding message primary keys");
        Check((await chat.SendTextAsync(other, channel, sent.OperationId, "collision")).MessageId == collision.MessageId,
            "same-account retry keeps the server-generated message ID");
        using var scope = services.CreateScope();
        var snapshots = scope.ServiceProvider.GetRequiredService<Yap.Offline.OfflineSnapshotService>();
        var projected = snapshots.Message(target);
        Check(projected.OperationId == null && snapshots.Message(target, other.Id).OperationId == null
            && snapshots.Message(target, user.Id).OperationId == sent.OperationId
            && snapshots.ForViewer(projected, target, other).OperationId == null
            && snapshots.ForViewer(projected, target, user).OperationId == sent.OperationId,
            "windows and shared fan-out reveal operation IDs only to the sender");
        await chat.MutateMessageAsync(user, channel, target.Id, Guid.NewGuid(), "reaction", null, "👍", true);
        await chat.MutateMessageAsync(other, channel, target.Id, Guid.NewGuid(), "reaction", null, "❤️", true);
        Check(snapshots.Message(target).Reactions.Select(r => r.Emoji).SequenceEqual(new[] { "👍", "❤️" }),
            "reaction pills retain first-used order instead of sorting by codepoint");
        var stored = await store.GetAcceptedMessageAsync(target.Id);
        Check(stored?.Content == target.Content && stored.IsEdited, "storage and live mutation agree");
        await chat.SendMessageAsync(channel, user.Id, user.Username, "server acceptance");
        var serverMessage = chat.GetMessages(channel, 100).Single(m => m.Content == "server acceptance");
        await chat.MutateMessageAsync(user, channel, serverMessage.Id, Guid.NewGuid(), "reaction", null, "👍", true);
        Check(serverMessage.Reactions.Count == 1 && await store.GetTextReceiptAsync(user.Id, serverMessage.OperationId!.Value) != null,
            "server messages use receipt acceptance and support ordinary mutations");
        var media = await chat.SendTextAsync(user, channel, Guid.NewGuid(), "", images: ["/uploads/fixture.png"]);
        try
        {
            await chat.MutateMessageAsync(user, channel, media.MessageId, Guid.NewGuid(), "edit", "forbidden", null, false);
            throw new Exception("Media edit should fail");
        }
        catch (ChatSendException error) { Check(error.Code == "media_message", "media edit policy is enforced before either backend"); }

        // Competing messages must not reuse one mutation receipt, even in the memory store.
        var operation = Guid.NewGuid();
        var results = await Task.WhenAll(new[] { target.Id, serverMessage.Id }.Select(async id =>
        {
            try
            {
                await chat.MutateMessageAsync(user, channel, id, operation, "edit", "shared operation", null, false);
                return true;
            }
            catch (ChatSendException error) when (error.Status == 409) { return false; }
        }));
        Check(results.Count(r => r) == 1 && new[] { target, serverMessage }.Count(m => m.Content == "shared operation") == 1,
            "one operation ID cannot accept mutations of two messages concurrently");

        var old = new ChatMessage(channel, user.Id, user.Username, "expired receipt", DateTime.UtcNow);
        var receipt = new TextSendReceipt
        {
            UserId = user.Id,
            OperationId = Guid.NewGuid(),
            MessageId = old.Id,
            ChannelId = channel,
            ContentHash = "expiry fixture",
            AcceptedAt = DateTime.UtcNow.AddDays(-2)
        };
        await store.PersistTextAcceptanceAsync(old, receipt);
        await store.PruneReceiptsAsync(DateTime.UtcNow - ChatReceiptCleanup.Retention);
        Check(await store.GetTextReceiptAsync(user.Id, receipt.OperationId) == null
            && await store.GetTextReceiptAsync(user.Id, sent.OperationId) != null,
            "receipt cleanup removes expired entries and preserves the retry window in both backends");
        Check(await store.GetAcceptedMessageAsync(old.Id) != null, "receipt expiry never deletes accepted messages");
        var env = services.GetRequiredService<Microsoft.AspNetCore.Hosting.IWebHostEnvironment>();
        var folder = Path.Combine(env.ContentRootPath, "Data", "upload-receipts", user.Id.ToString("N"));
        Directory.CreateDirectory(folder);
        var expired = Guid.NewGuid().ToString("N");
        var fresh = Guid.NewGuid().ToString("N");
        File.WriteAllText(Path.Combine(folder, expired + ".json"), "{}");
        File.WriteAllText(Path.Combine(folder, fresh + ".json"), "{}");
        File.SetLastWriteTimeUtc(Path.Combine(folder, expired + ".json"), DateTime.UtcNow.AddDays(-2));
        Check(Yap.Endpoints.TusEndpoints.Completed(env, user.Id, expired) == null
            && Yap.Endpoints.TusEndpoints.Completed(env, user.Id, fresh) != null
            && Yap.Endpoints.TusEndpoints.Completed(env, other.Id, fresh) == null,
            "upload receipt lookup enforces lifetime and account isolation before cleanup");
        Yap.Endpoints.TusEndpoints.PruneReceipts(env, DateTime.UtcNow - ChatReceiptCleanup.Retention);
        Check(!File.Exists(Path.Combine(folder, expired + ".json"))
            && Yap.Endpoints.TusEndpoints.Completed(env, user.Id, fresh) != null
            && Yap.Endpoints.TusEndpoints.Completed(env, user.Id, fresh) != null,
            "upload cleanup removes expired files and preserves replayable fresh receipts");
    }
    static void Check(bool condition, string label)
    {
        if (!condition)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
}
