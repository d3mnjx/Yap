using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR.Client;

// External-server CPU only: client serialization and the load generator run in this process.
if (args.Length < 5) throw new ArgumentException("origin private-fixture.json server-pid clients samples [output.json]");
var origin = new Uri(args[0]);
if (!origin.IsLoopback || origin.Port == 7543) throw new ArgumentException("Disposable loopback fixture required");
var fixture = JsonDocument.Parse(File.ReadAllText(args[1])).RootElement;
var people = fixture.GetProperty("people").EnumerateArray().ToArray();
var room = fixture.GetProperty("room").GetString()!;
var count = int.Parse(args[3]);
var samples = int.Parse(args[4]);
var server = Process.GetProcessById(int.Parse(args[2]));
var connections = new List<HubConnection>();
var clients = new List<HttpClient>();
var readers = new List<Task>();
using var stop = new CancellationTokenSource();
var arrivals = new ConcurrentDictionary<string, ConcurrentDictionary<int, long>>();
var baseline = Enumerable.Range(0, count).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
string? csrf = null;
try
{
    for (var i = 0; i < count; i++)
    {
        var cookies = new CookieContainer();
        cookies.Add(origin, new Cookie("yap_auth", people[i].GetProperty("token").GetString()!));
        var client = new HttpClient(new HttpClientHandler { CookieContainer = cookies }) { BaseAddress = origin };
        client.DefaultRequestHeaders.Add("X-Yap-Chat-Protocol", "2");
        clients.Add(client);
        var boot = await client.GetFromJsonAsync<JsonElement>("/api/chat/bootstrap?path=/lobby");
        // Browsers allow Secure cookies on loopback HTTP; .NET's CookieContainer does not.
        // Restore only this synthetic auth cookie after bootstrap's renewal.
        cookies.Add(origin, new Cookie("yap_auth", people[i].GetProperty("token").GetString()!, "/"));
        var session = boot.GetProperty("session");
        if (i == 0) csrf = session.GetProperty("csrfToken").GetString();
        var known = boot.GetProperty("update").GetProperty("conversations").EnumerateArray()
            .ToDictionary(c => c.GetProperty("id").GetString()!, c => c.GetProperty("revision").GetString()!);
        var hub = new HubConnectionBuilder().WithUrl(new Uri(origin, "/hubs/chat"), options => options.Cookies = cookies).Build();
        connections.Add(hub);
        await hub.StartAsync();
        var index = i;
        readers.Add(Task.Run(async () =>
        {
            await foreach (var update in hub.StreamAsync<JsonElement>("WatchChanges", known, null, stop.Token))
            {
                baseline[index].TrySetResult();
                foreach (var conversation in update.GetProperty("conversations").EnumerateArray())
                    foreach (var message in conversation.GetProperty("messages").EnumerateArray())
                        arrivals.GetOrAdd(message.GetProperty("id").GetString()!, _ => new())[index] = Stopwatch.GetTimestamp();
            }
        }));
        readers.Add(Task.Run(async () =>
        {
            await foreach (var _ in hub.StreamAsync<JsonElement>("WatchActivity", session.GetProperty("liveTicket").GetString(), 0, true, false, 0d, Guid.Parse(room), stop.Token)) { }
        }));
    }
    await Task.WhenAll(baseline.Select(b => b.Task)).WaitAsync(TimeSpan.FromSeconds(30));
    await Task.Delay(2000);
    var elapsed = Stopwatch.StartNew();
    var cpu = server.TotalProcessorTime;
    var ackToLast = new List<double>();
    var postToLast = new List<double>();
    const int warmup = 10;
    for (var i = -warmup; i < samples; i++)
    {
        if (i == 0) { elapsed.Restart(); server.Refresh(); cpu = server.TotalProcessorTime; }
        var scheduled = (i < 0 ? i + warmup : i) * 500;
        var wait = scheduled - elapsed.ElapsedMilliseconds;
        if (wait > 0) await Task.Delay((int)wait);
        var id = Guid.NewGuid().ToString();
        var started = Stopwatch.GetTimestamp();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/chat/conversations/{room}/messages")
            { Content = JsonContent.Create(new { operationId = id, content = "fanout load " + id }) };
        request.Headers.Add("X-CSRF-TOKEN", csrf);
        using var response = await clients[0].SendAsync(request);
        response.EnsureSuccessStatusCode();
        var ack = Stopwatch.GetTimestamp();
        var deadline = Stopwatch.StartNew();
        while (!arrivals.TryGetValue(id, out var received) || received.Count != count)
        {
            if (deadline.Elapsed > TimeSpan.FromSeconds(15)) throw new Exception($"Missing subscriber patches: {id}");
            await Task.Delay(2);
        }
        var last = arrivals[id].Values.Max();
        if (i >= 0)
        {
            ackToLast.Add((last - ack) * 1000d / Stopwatch.Frequency);
            postToLast.Add((last - started) * 1000d / Stopwatch.Frequency);
        }
    }
    server.Refresh();
    var cpuMs = (server.TotalProcessorTime - cpu).TotalMilliseconds;
    double P95(List<double> values) => values.Order().ElementAt(Math.Min(values.Count - 1, (int)Math.Ceiling(values.Count * .95) - 1));
    var result = new { clients = count, samples, warmup, targetMessagesPerSecond = 2, elapsedMs = elapsed.Elapsed.TotalMilliseconds,
        cpuMs, cpuMsPerMessage = cpuMs / samples, cpuOneCorePercent = cpuMs / elapsed.Elapsed.TotalMilliseconds * 100,
        ackToLastP95Ms = P95(ackToLast), postToLastP95Ms = P95(postToLast), allSubscribersReceived = true };
    var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
    Console.WriteLine(json);
    if (args.Length > 5) File.WriteAllText(args[5], json);
}
finally
{
    stop.Cancel();
    foreach (var hub in connections) await hub.DisposeAsync();
    foreach (var client in clients) client.Dispose();
    try { await Task.WhenAll(readers); } catch (OperationCanceledException) { }
}
