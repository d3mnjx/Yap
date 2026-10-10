using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Yap.Models;
using Yap.Services;

static class GifPagingChecks
{
    public static async Task Run(HttpClient http, string csrf, ChatService chat, User admin)
    {
        // Separate conversation: provider fixtures must not alter the receipt/restart scenarios.
        var room = (await chat.CreateRoomAsync(admin.Id, admin.Username, "gif-paging"))!;
        async Task<JsonElement> Post(string path, object body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
            request.Headers.Add("X-CSRF-TOKEN", csrf);
            using var response = await http.SendAsync(request);
            if (!response.IsSuccessStatusCode)
                throw new Exception($"GIF fixture {path}: {response.StatusCode}");
            return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        foreach (var mode in new[] { "trending", "search" })
        {
            string? cursor = null;
            var query = mode == "search" ? "paging cats" : "";
            for (var page = 1; page <= 3; page++)
            {
                var parameters = await new FormUrlEncodedContent(new Dictionary<string, string> { ["mode"] = mode, ["q"] = query, ["cursor"] = cursor ?? "" }).ReadAsStringAsync();
                var results = await http.GetFromJsonAsync<JsonElement>("/api/chat/gifs?" + parameters);
                var remote = results.GetProperty("remote");
                var items = remote.GetProperty("items").EnumerateArray().ToArray();
                foreach (var item in new[] { items.First(), items.Last() })
                {
                    var selection = new
                    {
                        sourceId = item.GetProperty("sourceId").GetString(),
                        query,
                        cursor
                    };
                    var selected = await Post("/api/chat/gifs/select", selection);
                    var gifId = selected.GetProperty("id").GetGuid();
                    var again = await Post("/api/chat/gifs/select", selection);
                    Check(again.GetProperty("id").GetGuid() == gifId, $"{mode} page {page} selection resolves the displayed GIF and retries to the same entry");
                    var operationId = Guid.NewGuid();
                    var body = new
                    {
                        operationId,
                        content = "",
                        gifEntryId = gifId
                    };
                    var sent = await Post($"/api/chat/conversations/{room.Id}/messages", body);
                    await Post($"/api/chat/conversations/{room.Id}/messages", body);
                    var messages = chat.GetMessages(room.Id, int.MaxValue).Where(m => m.Id == sent.GetProperty("messageId").GetGuid()).ToArray();
                    Check(messages.Length == 1 && messages[0].GifAttachments.Single().GifEntryId == gifId,
                        $"{mode} page {page} GIF message acceptance remains exactly once on retry");
                }
                cursor = remote.GetProperty("nextCursor").GetString();
            }
        }
    }
    private static void Check(bool value, string label)
    {
        if (!value)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }
    // Real Klipy decoder and HTTP endpoints, synthetic HTTP payloads. Page offsets depend on
    // per_page exactly as the provider does; using 50 to select a 30-item page fails this test.
    public sealed class Handler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.Host == "gif-fixture.invalid")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")) });
            var query = QueryHelpers.ParseQuery(request.RequestUri.Query);
            if (!query.ContainsKey("per_page"))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new { result = true }) });
            var page = int.Parse(query["page"]!);
            var size = int.Parse(query["per_page"]!);
            var mode = request.RequestUri.AbsolutePath.EndsWith("/search") ? "search" : "trending";
            var data = Enumerable.Range((page - 1) * size, size).Select(i => new
            {
                slug = mode + "-" + i,
                title = "Fixture GIF " + i,
                file = new
                {
                    md = new
                    {
                        gif = new
                        {
                            url = $"https://gif-fixture.invalid/{mode}-{i}.gif",
                            width = 1,
                            height = 1,
                            size = 42
                        }
                    }
                }
            });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new { result = true, data = new { data, current_page = page, has_next = page < 3 } })
            });
        }
    }
}
