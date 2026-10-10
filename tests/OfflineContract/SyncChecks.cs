using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class SyncChecks
{
    public static async Task Run(IServiceProvider services, HttpClient client, string csrf, User alice, User bob)
    {
        using var scope = services.CreateScope();
        var sync = scope.ServiceProvider.GetRequiredService<OfflineSync>();
        var snapshots = scope.ServiceProvider.GetRequiredService<OfflineSnapshotService>();
        var chat = services.GetRequiredService<ChatService>();
        var channel = chat.GetOrCreateDMChannel(alice.Id, alice.Username, bob.Id, bob.Username);
        var bootstrap = sync.Bootstrap(alice, "/dm/" + bob.Username);
        Check(bootstrap.Reset && bootstrap.Protocol == 2 && bootstrap.State!.Conversations.Length == 0,
            "bootstrap separates summaries from recent windows");
        Check(bootstrap.Conversations.Count(c => c.Window != null) == 1
            && bootstrap.Conversations.Single(c => c.Window != null).Id == channel.Id,
            "bootstrap contains only the active conversation window");
        var before = snapshots.Snapshot(alice);
        // Flatten independent wire packets only for assertions; the browser receives their
        // original per-conversation sequences, never this combined diagnostic value.
        static async Task<ChatUpdate> Read(OfflineFanout.Subscription subscription, CancellationToken token)
        {
            var packets = await subscription.Read(token);
            var latest = packets.Last();
            return latest with
            {
                State = packets.LastOrDefault(p => p.State != null)?.State,
                Conversations = packets.SelectMany(p => p.Conversations).GroupBy(c => c.Id).Select(g => g.Last()).ToArray(),
                Authors = packets.SelectMany(p => p.Authors).DistinctBy(a => a.Id).ToArray(),
                Reset = packets.Any(p => p.Reset)
            };
        }
        var fanout = services.GetRequiredService<OfflineFanout>();
        using var subscription = fanout.Subscribe(alice, bootstrap.Conversations.ToDictionary(c => c.Id, c => c.Revision));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await Read(subscription, timeout.Token);
        var operation = Guid.NewGuid();
        var receipt = await chat.SendTextAsync(alice, channel.Id, operation, "incremental contract");
        var after = snapshots.Snapshot(alice);
        var delta = await Read(subscription, timeout.Token);
        Check(after.Conversations.Single(c => c.Id == channel.Id).HistoryVersion == before.Conversations.Single(c => c.Id == channel.Id).HistoryVersion,
            "new arrivals preserve older history authority");
        Check(delta.Conversations.Sum(c => c.Messages.Length) == 1
            && delta.Conversations.All(c => c.Window == null && c.State.Messages.Length == 0),
            "live send transmits one message and no repeated history windows");
        Check(delta.Authors.Length == 1 && delta.Conversations.Single(c => c.Messages.Length > 0).Messages[0].AuthorId == alice.Id,
            "message authors are sent once per packet");
        await chat.DeleteMessageAsync(receipt.MessageId, channel.Id, alice.Username);
        var deleted = snapshots.Snapshot(alice);
        Check(deleted.Conversations.Single(c => c.Id == channel.Id).HistoryVersion > after.Conversations.Single(c => c.Id == channel.Id).HistoryVersion,
            "deletion invalidates cached history even outside the recent window");
        var deletion = await Read(subscription, timeout.Token);
        Check(deletion.Conversations.Any(c => c.Removed.Contains(receipt.MessageId))
            && deletion.Conversations.All(c => c.Messages.All(m => m.Id != receipt.MessageId) && c.Messages.Length <= 1), "delete sends removal and only necessary window backfill");
        var replay = sync.Conversation(alice, channel.Id, receipt.MessageId);
        Check(replay.Conversations[0].Removed.Contains(receipt.MessageId) && replay.Conversations[0].Messages.Length == 0,
            "compact receipt recovery reflects current deletion");

        using (var slow = fanout.Subscribe(alice, new Dictionary<Guid, string>(), capacity: 2))
        {
            await Read(slow, timeout.Token);
            for (var i = 0; i < 5; i++)
                await chat.SendTextAsync(bob, channel.Id, Guid.NewGuid(), "overflow " + i);
            var recovery = await Read(slow, timeout.Token);
            Check(slow.Overflows > 0 && recovery.Reset && recovery.Conversations.All(c => c.Invalidate), "paused subscriber overflows into bounded invalidation recovery");
            var window = sync.Conversation(alice, channel.Id, full: true);
            Check(window.Conversations[0].Messages.Last().Content == "overflow 4", "overflow window recovers the latest accepted content");
        }

        var users = services.GetRequiredService<UserService>();
        var outsider = users.GetByUsername("carolfixture")!;
        using (var privateObserver = fanout.Subscribe(outsider, new Dictionary<Guid, string>()))
        {
            await Read(privateObserver, timeout.Token);
            await chat.SendTextAsync(alice, channel.Id, Guid.NewGuid(), "private fanout");
            using var quiet = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
            var leaked = false;
            try
            {
                await Read(privateObserver, quiet.Token);
                leaked = true;
            }
            catch (OperationCanceledException) { }
            Check(!leaked, "private messages and recipient unread updates never wake unrelated accounts");
        }
        var parallel = Enumerable.Range(0, 12).Select(i => chat.SendTextAsync(bob, channel.Id, Guid.NewGuid(), "parallel " + i)).ToArray();
        await Task.WhenAll(parallel);
        var coalesced = await Read(subscription, timeout.Token);
        Check(coalesced.Conversations.SelectMany(c => c.Messages).Count(m => m.Content.StartsWith("parallel ")) == 12,
            "concurrent distinct sends remain complete when the stream coalesces its queue");
        var known = coalesced.Conversations.ToDictionary(c => c.Id, c => c.Revision);
        using (var reconnected = fanout.Subscribe(alice, known))
        {
            var baseline = await Read(reconnected, timeout.Token);
            Check(baseline.Conversations.Single(c => c.Id == channel.Id).Invalidate == false,
                "matching reconnect revision keeps the cached window");
        }
        known[channel.Id] = "stale";
        using (var stale = fanout.Subscribe(alice, known))
            Check((await Read(stale, timeout.Token)).Conversations.Single(c => c.Id == channel.Id).Invalidate,
                "mismatched reconnect revision requests an authorized window");

        await users.UpdateProfileAsync(bob.Id, "Fanout profile", bob.ProfilePictureUrl, bob.Bio, bob.Country);
        var profile = await Read(subscription, timeout.Token);
        Check(profile.State!.People.Any(p => p.Id == bob.Id && p.DisplayName == "Fanout profile")
            && profile.Conversations.Any(c => c.Id == channel.Id && c.Invalidate),
            "profile changes refresh the header and invalidate embedded author windows");
        await users.SetDmNotificationModeAsync(alice.Id, NotificationMode.MuteAll);
        var preferences = await Read(subscription, timeout.Token);
        Check(preferences.Conversations.Single(c => c.Id == channel.Id).State.Muted,
            "account preferences update its metadata without a snapshot poll");
        await users.SetDmNotificationModeAsync(alice.Id, NotificationMode.AllowAll);
        await Read(subscription, timeout.Token);
        var checkpoint = chat.GetReadCheckpoint(alice.Id, channel.Id);
        await chat.MarkObservedReadAsync(alice.Id, channel.Id, checkpoint.Received);
        var read = await Read(subscription, timeout.Token);
        Check(read.Conversations.All(c => c.Messages.Length == 0) && read.State == null,
            "observed-read acknowledgements send only recipient metadata");

        await chat.SendTextAsync(alice, channel.Id, Guid.NewGuid(), "before independent acknowledgement");
        var acknowledgement = sync.Conversation(alice, channel.Id);
        var lobby = chat.GetRooms().Single(c => c.IsDefault);
        await chat.SendTextAsync(alice, lobby.Id, Guid.NewGuid(), "later unrelated room");
        var independent = await subscription.Read(timeout.Token);
        Check(independent.Single(p => p.Conversations.Any(c => c.Id == channel.Id)).Sequence < acknowledgement.Sequence
            && independent.Single(p => p.Conversations.Any(c => c.Id == lobby.Id)).Sequence > acknowledgement.Sequence,
            "coalescing preserves independent conversation stamps across an intervening HTTP acknowledgement");

        async Task<HttpResponseMessage> Post(string path, object value, string? expectedUser = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/chat/" + path) { Content = JsonContent.Create(value) };
            request.Headers.Add("X-CSRF-TOKEN", csrf);
            request.Headers.Add("X-Yap-Chat-Protocol", "2");
            request.Headers.Add("X-Yap-Chat-User", expectedUser ?? alice.Id.ToString());
            return await client.SendAsync(request);
        }
        var first = Guid.NewGuid();
        using var response = await Post($"conversations/{channel.Id}/messages", new
        {
            operationId = first,
            content = "compact HTTP"
        });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Check(response.IsSuccessStatusCode && !result.TryGetProperty("snapshot", out _)
            && result.GetProperty("update").GetProperty("conversations")[0].GetProperty("messages").GetArrayLength() == 1,
            "HTTP acceptance returns a compact authoritative result without a follow-up GET");
        using var mismatch = await Post($"conversations/{channel.Id}/messages", new
        {
            operationId = Guid.NewGuid(),
            content = "wrong owner"
        }, bob.Id.ToString());
        Check(mismatch.StatusCode == HttpStatusCode.Conflict, "cached credentials cannot write under a changed cookie owner");
        var batch = new[] {
            new { operationId = Guid.NewGuid(), channelId = channel.Id, content = "batch one" },
            new { operationId = Guid.NewGuid(), channelId = channel.Id, content = "batch two" }
        };
        for (var i = 0; i < 2; i++)
        {
            using var accepted = await Post("operations", batch);
            var body = await accepted.Content.ReadFromJsonAsync<JsonElement>();
            Check(accepted.IsSuccessStatusCode && body.GetProperty("results").GetArrayLength() == 2
                && body.GetProperty("results").EnumerateArray().All(r => r.GetProperty("update").GetProperty("protocol").GetInt32() == 2),
                "batch returns independent compact receipts, including replay");
        }
        Check(chat.GetMessages(channel.Id, 100).Count(m => batch.Any(o => o.operationId == m.OperationId)) == 2,
            "batch replay preserves exactly-once acceptance");
    }
    private static void Check(bool value, string label)
    {
        if (!value)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
}
