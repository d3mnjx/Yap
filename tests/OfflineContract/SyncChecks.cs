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
        Check(sync.Changes(snapshots.Snapshot(alice), before) == null, "unchanged state produces no live payload");
        var operation = Guid.NewGuid();
        var receipt = await chat.SendTextAsync(alice, channel.Id, operation, "incremental contract");
        var after = snapshots.Snapshot(alice);
        var delta = sync.Changes(after, before)!;
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
        var deletion = sync.Changes(deleted, after)!;
        Check(deletion.Conversations.Any(c => c.Removed.Contains(receipt.MessageId))
            && deletion.Conversations.All(c => c.Messages.All(m => m.Id != receipt.MessageId) && c.Messages.Length <= 1), "delete sends removal and only necessary window backfill");
        var replay = sync.Conversation(alice, channel.Id, receipt.MessageId);
        Check(replay.Conversations[0].Removed.Contains(receipt.MessageId) && replay.Conversations[0].Messages.Length == 0,
            "compact receipt recovery reflects current deletion");

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
