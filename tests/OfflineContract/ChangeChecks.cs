using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Yap.Models;
using Yap.Offline;
using Yap.Services;
using Yap.Services.Gifs;

static class ChangeChecks
{
    public static async Task Run(IServiceProvider services, User alice, User bob)
    {
        // Behavior checks below exercise real publications; an event-name allowlist
        // cannot prove that a producer reaches browser clients.
        var chat = services.GetRequiredService<ChatService>();
        var fanout = services.GetRequiredService<OfflineFanout>();
        var changes = services.GetRequiredService<OfflineChangeSignal>();
        var channel = chat.GetOrCreateDMChannel(alice.Id, alice.Username, bob.Id, bob.Username);
        using var subscription = fanout.Subscribe(alice, new Dictionary<Guid, string>());
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await subscription.Read(timeout.Token);
        var target = await chat.SendTextAsync(bob, channel.Id, Guid.NewGuid(), "original quote");
        var reply = await chat.SendTextAsync(alice, channel.Id, Guid.NewGuid(), "reply", target.MessageId);
        await subscription.Read(timeout.Token);
        await chat.MutateMessageAsync(bob, channel.Id, target.MessageId, Guid.NewGuid(), "edit", "edited quote", null, false);
        var edit = await subscription.Read(timeout.Token);
        Check(edit.SelectMany(u => u.Conversations).SelectMany(c => c.Messages).Any(m => m.Id == reply.MessageId && m.Reply?.Content == "edited quote"),
            "target edit refreshes reply previews without other room activity");
        await chat.MutateMessageAsync(bob, channel.Id, target.MessageId, Guid.NewGuid(), "delete", null, null, false);
        var deletion = await subscription.Read(timeout.Token);
        Check(deletion.SelectMany(u => u.Conversations).SelectMany(c => c.Messages).Any(m => m.Id == reply.MessageId && m.Reply == null),
            "target deletion clears reply previews without other room activity");

        var room = chat.GetChannel(chat.GetLobbyId())!;
        var previousLimit = room.HistoryLimit;
        room.HistoryLimit = HistoryLimit.OneDay;
        changes.Touch(room.Id);
        await subscription.Read(timeout.Token);
        var restricted = await chat.SendTextAsync(bob, room.Id, Guid.NewGuid(), "restricted target");
        var restrictedReply = await chat.SendTextAsync(alice, room.Id, Guid.NewGuid(), "restricted reply", restricted.MessageId);
        await subscription.Read(timeout.Token);
        await chat.MutateMessageAsync(bob, room.Id, restricted.MessageId, Guid.NewGuid(), "delete", null, null, false);
        var restrictedDelete = (await subscription.Read(timeout.Token)).SelectMany(u => u.Conversations).Single(c => c.Id == room.Id);
        Check(restrictedDelete.Invalidate && restrictedDelete.BaseRevision != null && restrictedDelete.Removed.Length == 0
            && restrictedDelete.Messages.Any(m => m.Id == restrictedReply.MessageId && m.Reply == null),
            "restricted delete and reply in one batch retain invalidation without exposing the deleted ID");
        room.HistoryLimit = previousLimit;
        changes.Touch(room.Id);
        await subscription.Read(timeout.Token);

        var uploader = (await services.GetRequiredService<UserService>().CreateUserAsync("uploaderprofilefixture"))!;
        var gifs = services.GetRequiredService<GifService>();
        var gif = new GifEntry(null, null, uploader.Id) { GifUrl = "/uploads/profile-fixture.webp", Width = 1, Height = 1 };
        var entries = (System.Collections.Concurrent.ConcurrentDictionary<Guid, GifEntry>)typeof(GifService)
            .GetField("_entries", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(gifs)!;
        entries[gif.Id] = gif;
        var attributed = await chat.SendTextAsync(bob, channel.Id, Guid.NewGuid(), "GIF attribution", gifs: [new GifAttachment(gif.Id, 1, 1)]);
        await subscription.Read(timeout.Token);
        await services.GetRequiredService<UserService>().UpdateProfileAsync(uploader.Id, "Updated uploader", null, null, null);
        var profile = (await subscription.Read(timeout.Token)).SelectMany(u => u.Conversations).ToArray();
        Check(profile.Any(c => c.Id == channel.Id && c.Invalidate),
            "GIF uploader profile invalidates conversations where the uploader never posted or participated");
        using (var scope = services.CreateScope())
        {
            var projection = scope.ServiceProvider.GetRequiredService<OfflineSnapshotService>()
                .Message(chat.GetMessageById(channel.Id, attributed.MessageId)!, alice.Id);
            Check(System.Text.Json.JsonSerializer.Serialize(projection.Gifs).Contains("Updated uploader"),
                "refilled GIF attribution uses the uploader's current display name");
        }

        // Hold the real lazy-description worker while two references arrive. Completing local
        // sidecars then exercises the normal callback without network/provider dependencies.
        var media = services.GetRequiredService<MediaCacheService>();
        var descriptionGate = (SemaphoreSlim)typeof(MediaCacheService).GetField("_describeSemaphore", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(media)!;
        await descriptionGate.WaitAsync();
        await descriptionGate.WaitAsync();
        var mediaUrl = "https://example.com/lazy-description-contract";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(mediaUrl)))[..16].ToLowerInvariant();
        var folder = Path.Combine(services.GetRequiredService<IWebHostEnvironment>().ContentRootPath, "Data", "media-cache");
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, hash + ".mp4"), [0]);
        File.WriteAllBytes(Path.Combine(folder, hash + "_poster.webp"), [0]);
        File.WriteAllText(Path.Combine(folder, hash + ".title"), "Lazy title");
        services.GetRequiredService<LinkPreviewService>().GetOrCreatePreview(mediaUrl);
        TextSendReceipt firstMedia, secondMedia;
        try
        {
            firstMedia = await chat.SendTextAsync(alice, channel.Id, Guid.NewGuid(), mediaUrl);
            secondMedia = await chat.SendTextAsync(bob, channel.Id, Guid.NewGuid(), mediaUrl);
            await subscription.Read(timeout.Token);
            File.WriteAllText(Path.Combine(folder, hash + ".dims"), "640x360");
        }
        finally { descriptionGate.Release(2); }
        var enriched = new HashSet<Guid>();
        while (enriched.Count < 2)
            foreach (var message in (await subscription.Read(timeout.Token)).SelectMany(u => u.Conversations).SelectMany(c => c.Messages))
                if ((message.Id == firstMedia.MessageId || message.Id == secondMedia.MessageId)
                    && message.Previews?.Any(p => p.MediaWidth == 640 && p.MediaHeight == 360 && p.Title == "Lazy title") == true)
                    enriched.Add(message.Id);
        Check(enriched.Count == 2, "lazy media description updates every message sharing the URL with no other activity");

        // Lose a publication deliberately, then verify the periodic digest still advertises
        // the new revision without projecting message bodies or rebuilding a snapshot.
        var before = changes.ContentVersion(channel.Id);
        changes.Touch(channel.Id, reply.MessageId);
        await subscription.Read(timeout.Token); // stand in for a dropped client packet
        var slots = (System.Collections.Concurrent.ConcurrentDictionary<Guid, long>)typeof(OfflineFanout.Subscription)
            .GetProperty("Channels", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(subscription)!;
        slots[channel.Id] = before; // Simulate a publication that never reached this subscriber.
        await subscription.Digest();
        var digest = await subscription.Read(timeout.Token);
        Check(digest.SelectMany(u => u.Conversations).Any(c => c.Id == channel.Id && c.Invalidate && long.Parse(c.Revision) > before)
            && digest.SelectMany(u => u.Conversations).All(c => c.Messages.Length == 0), "periodic digest repairs missed revisions using metadata only");
        await subscription.Digest();
        using (var quiet = new CancellationTokenSource(50))
        {
            try
            {
                await subscription.Read(quiet.Token);
                throw new Exception("unchanged digest produced a record");
            }
            catch (OperationCanceledException) { Check(true, "unchanged digest emits no metadata or invalidations"); }
        }
        slots[channel.Id] = before;
        await subscription.Digest();
        var digestRevision = changes.ContentVersion(channel.Id).ToString();
        await chat.SendTextAsync(alice, channel.Id, Guid.NewGuid(), "digest overlap");
        var overlap = (await subscription.Read(timeout.Token)).SelectMany(u => u.Conversations).Single(c => c.Id == channel.Id);
        Check(!overlap.Invalidate && overlap.BaseRevision == digestRevision && overlap.Messages.Length == 1,
            "digest coalesced with contiguous arrival retains the delta chain");
        var users = services.GetRequiredService<UserService>();
        await users.SetServerMuteAsync(alice.Id, true, DateTime.UtcNow.AddSeconds(-1));
        await subscription.Read(timeout.Token);
        await subscription.Digest();
        var expired = await subscription.Read(timeout.Token);
        Check(!alice.NotifServerMuted && expired.SelectMany(u => u.Conversations).Any(c => c.Id == channel.Id && !c.State.Muted),
            "timed mute expiry is persisted and reaches connected clients");
    }

    private static void Check(bool condition, string label)
    {
        if (!condition)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
}
