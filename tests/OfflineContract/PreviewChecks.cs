using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class PreviewChecks
{
    public static async Task Run(IServiceProvider services, User user)
    {
        var handler = new PreviewHandler();
        var factory = new PreviewFactory(handler);
        var env = services.GetRequiredService<IWebHostEnvironment>();
        LinkPreviewService Create() => new(factory, NullLogger<LinkPreviewService>.Instance, env);
        var previews = Create();
        var snapshots = ActivatorUtilities.CreateInstance<OfflineSnapshotService>(services, previews);
        // Public literal address passes the production SSRF guard; the handler never uses network.
        const string url = "https://93.184.216.34/preview-contract";
        var first = new ChatMessage(Guid.NewGuid(), user.Id, user.Username, url, DateTime.UtcNow);
        var second = new ChatMessage(Guid.NewGuid(), user.Id, user.Username, url, DateTime.UtcNow);
        var received = new HashSet<Guid>();
        var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        previews.OnPreviewFetched = (id, _, _) =>
        {
            lock (received)
            {
                received.Add(id);
                if (received.Count == 2)
                    complete.TrySetResult();
            }
        };
        snapshots.Message(first, user.Id);
        snapshots.Message(second, user.Id);
        handler.Release.SetResult();
        await complete.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Check(handler.Requests == 1 && snapshots.Message(first, user.Id).Previews!.Single().Title == "Durable card",
            "cold snapshot queues one fetch and notifies every message sharing the URL");
        previews = Create();
        var stored = previews.GetCachedPreview(url)!;
        Check(stored.Title == "Durable card", "preview survives a fresh service instance from persisted disk cache");
        stored.FetchedAt = DateTime.UtcNow.AddHours(-2);
        handler.Fail = true;
        complete = new(TaskCreationOptions.RunContinuationsAsynchronously);
        previews.OnPreviewFetched = (_, _, _) => complete.TrySetResult();
        snapshots = ActivatorUtilities.CreateInstance<OfflineSnapshotService>(services, previews);
        Check(snapshots.Message(first, user.Id).Previews!.Single().Title == "Durable card",
            "expired preview remains in the snapshot while refreshing");
        await complete.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Check(handler.Requests == 2 && snapshots.Message(first, user.Id).Previews!.Single().Title == "Durable card"
            && Create().GetCachedPreview(url)!.Title == "Durable card",
            "failed refresh retains the card in memory, projection and restart cache without a retry loop");
    }

    private static void Check(bool value, string label)
    {
        if (!value)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
    private sealed class PreviewFactory(PreviewHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, false);
    }
    private sealed class PreviewHandler : HttpMessageHandler
    {
        public int Requests;
        public bool Fail;
        public TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Requests);
            await Release.Task;
            return new(Fail ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
            {
                Content = new StringContent("<head><title>Durable card</title></head>", System.Text.Encoding.UTF8, "text/html")
            };
        }
    }
}
