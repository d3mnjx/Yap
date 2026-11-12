using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Configuration;
using Yap.Models.Chat;
using Yap.Services.Accounts;
using Yap.Services.Chat;

namespace Yap.Tests;

/// <summary>The message search of one conversation (docs/spec/search.md), through the hub as the client calls it.</summary>
public class SearchTests : IClassFixture<YapFactory>
{
    private readonly YapFactory _app;
    public SearchTests(YapFactory app) => _app = app;

    // A room of the admin with these texts, oldest first. The admin's hub connection comes back for the searches.
    private async Task<(Channel Room, HubConnection Hub)> RoomWith(string name, params string[] texts)
    {
        var chat = _app.Service<ChatService>();
        var owner = await _app.AdminAsync();
        var ownerId = _app.Service<UserService>().GetByUsername(owner.Username)!.Id;
        var (room, error) = chat.CreateRoom(ownerId, name, null, ChannelPermission.Everyone, HistoryLimit.Unlimited, sinceJoined: false);
        Assert.Null(error);
        foreach (var text in texts) Assert.Null(chat.Send(new SendMessage(room!.Id, ownerId, owner.Username, text)).Error);
        return (room!, await owner.ConnectAsync());
    }

    private static Task<SearchPage> Search(HubConnection hub, Guid channelId, string query, SearchHit? after = null) =>
        hub.InvokeAsync<SearchPage>("Search", channelId, query, after?.Timestamp, after?.MessageId);

    [Fact(DisplayName = "SR-03, SR-08: every word must be in the text, in any order and at any place; the results are newest first")]
    public async Task Every_word_in_any_order()
    {
        var (room, hub) = await RoomWith("search_words", "alpha beta gamma", "beta only", "gamma delta alphabet");
        var found = await Search(hub, room.Id, "gamma alpha");
        Assert.Null(found.Error);
        Assert.Equal(["gamma delta alphabet", "alpha beta gamma"], found.Hits.Select(h => h.Text));   // "alpha" inside "alphabet" counts
        Assert.Equal(2, found.Total);
        Assert.False(found.HasMore);
        Assert.Empty((await Search(hub, room.Id, "beta delta")).Hits);   // no single message has both
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-04: case and accent marks do not count, in the query and in the text")]
    public async Task Case_and_marks_fold()
    {
        var (room, hub) = await RoomWith("search_fold", "Příliš žluťoučký kůň", "prilis bez hacku");
        Assert.Equal(2, (await Search(hub, room.Id, "prilis")).Total);
        Assert.Equal(2, (await Search(hub, room.Id, "PŘÍLIŠ")).Total);
        Assert.Equal("Příliš žluťoučký kůň", Assert.Single((await Search(hub, room.Id, "zlutoucky KUN")).Hits).Text);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-06, SR-12: a reader finds nothing behind the history cutoff, and the reach starts at the oldest message the reader sees")]
    public async Task The_cutoff_holds()
    {
        var chat = _app.Service<ChatService>();
        var owner = await _app.AdminAsync();
        var ownerId = _app.Service<UserService>().GetByUsername(owner.Username)!.Id;
        var (room, error) = chat.CreateRoom(ownerId, "search_cutoff", null, ChannelPermission.Everyone, HistoryLimit.OneDay, sinceJoined: false);
        Assert.Null(error);
        chat.GenerateTestMessages(room!.Id, ownerId, owner.Username, 120, TimeSpan.FromDays(3));   // every text holds "Test #"

        var admin = await owner.ConnectAsync();
        var everything = await Search(admin, room.Id, "test");
        Assert.Equal(120, everything.Total);

        var reader = await (await _app.SignInAsync("reader_search")).ConnectAsync();
        var visible = await Search(reader, room.Id, "test");
        var dayAgo = DateTime.UtcNow.AddDays(-1).AddMinutes(-1);
        Assert.InRange(visible.Total!.Value, 1, 119);
        Assert.All(visible.Hits, h => Assert.True(h.Timestamp >= dayAgo));
        Assert.True(visible.Since >= dayAgo);
        Assert.True(everything.Since < dayAgo);   // the admin's reach is the whole room
        await admin.DisposeAsync();
        await reader.DisposeAsync();
    }

    [Fact(DisplayName = "SR-06, SR-01: a conversation the person cannot open answers with a refusal; a direct message is searched like a room")]
    public async Task A_direct_message_and_a_stranger()
    {
        var ann = await _app.SignInAsync("ann_search");
        var ben = await _app.SignInAsync("ben_search");
        var annHub = await ann.ConnectAsync();
        var dm = (await annHub.InvokeAsync<Conversation>("OpenDm", "ben_search")).ChannelId;
        await ann.Http.PostAsJsonAsync("/api/dm/ben_search/messages", new { clientId = Guid.NewGuid(), text = "the secret plan" });

        var benHub = await ben.ConnectAsync();
        Assert.Equal("the secret plan", Assert.Single((await Search(benHub, dm, "secret")).Hits).Text);

        var stranger = await (await _app.SignInAsync("cid_search")).ConnectAsync();
        var refused = await Search(stranger, dm, "secret");
        Assert.Equal("Conversation not found.", refused.Error);
        Assert.Empty(refused.Hits);
        await annHub.DisposeAsync();
        await benHub.DisposeAsync();
        await stranger.DisposeAsync();
    }

    [Fact(DisplayName = "SR-01: a system line is not a result")]
    public async Task System_lines_are_not_searched()
    {
        var (room, hub) = await RoomWith("search_system", "please pin this");
        var message = Assert.Single((await Search(hub, room.Id, "pin")).Hits);
        Assert.Null(await hub.InvokeAsync<HubError?>("Pin", room.Id, message.MessageId));   // stores the line "{name} pinned a message" (MR-80)
        var after = await Search(hub, room.Id, "pin");
        Assert.Equal(message.MessageId, Assert.Single(after.Hits).MessageId);
        Assert.Equal(1, after.Total);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-11: 25 results per call, the cursor gives the next page, the total comes with the first page only")]
    public async Task Pages_follow_the_cursor()
    {
        var (room, hub) = await RoomWith("search_pages", Enumerable.Range(1, 30).Select(i => $"needle {i}").Append("hay").ToArray());
        var first = await Search(hub, room.Id, "needle");
        Assert.Equal(25, first.Hits.Count);
        Assert.Equal(30, first.Total);
        Assert.True(first.HasMore);
        Assert.Equal("needle 30", first.Hits[0].Text);   // newest first

        var second = await Search(hub, room.Id, "needle", after: first.Hits[^1]);
        Assert.Equal(["needle 5", "needle 4", "needle 3", "needle 2", "needle 1"], second.Hits.Select(h => h.Text));
        Assert.Null(second.Total);
        Assert.False(second.HasMore);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-05: a query needs 2 characters, and a query over the limit is cut, also inside an emoji")]
    public async Task Query_limits()
    {
        var (room, hub) = await RoomWith("search_limits", "a b c", new string('a', 120));
        var one = await Search(hub, room.Id, " a ");
        Assert.Null(one.Error);
        Assert.Empty(one.Hits);
        Assert.Equal(0, one.Total);

        Assert.Equal(1, (await Search(hub, room.Id, new string('a', 300))).Total);   // cut to 100, which the long text holds
        var split = await Search(hub, room.Id, new string('a', 99) + "😀");          // the cut at 100 falls inside the emoji
        Assert.Null(split.Error);
        Assert.Equal(1, split.Total);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-04: a text that cannot be normalized does not break the search, and its words are found as in any other text")]
    public async Task A_text_that_does_not_normalize()
    {
        // The escapes are on purpose: U+FFFE in the source itself is a character that no editor shows.
        var (room, hub) = await RoomWith("search_broken", "fine příliš", "broken \uFFFE příliš", "lone \uD83D surrogate, žluťoučký");
        var found = await Search(hub, room.Id, "prilis");
        Assert.Null(found.Error);
        Assert.Equal(2, found.Total);   // the text with U+FFFE folds too: its words are found without their marks
        Assert.Equal(2, (await Search(hub, room.Id, "PŘÍLIŠ")).Total);   // and with them
        Assert.Single((await Search(hub, room.Id, "surrogate zlutoucky")).Hits);
        await hub.DisposeAsync();
    }

    [Fact(DisplayName = "SR-32: the client gets the two search lists, as configured, each with its fallback when it is not")]
    public async Task The_configured_texts_arrive()
    {
        var me = await _app.AdminAsync();
        var texts = (await me.Http.GetFromJsonAsync<JsonElement>("/api/bootstrap")).GetProperty("texts");
        Assert.NotEmpty(texts.GetProperty("searchPlaceholders").EnumerateArray());
        Assert.NotEmpty(texts.GetProperty("searchEmpty").EnumerateArray());

        var bare = new Yap.Configuration.ServerConfig(new ConfigurationBuilder().Build()).Texts();
        Assert.Equal(["Search"], bare.SearchPlaceholders);
        Assert.Equal(["No results"], bare.SearchEmpty);

        var configured = new Yap.Configuration.ServerConfig(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ChatSettings:FunnyTexts:Search:Placeholder:0"] = "search {0}...",
            ["ChatSettings:FunnyTexts:Search:NoResults:0"] = "nobody said {0}",
        }).Build()).Texts();
        Assert.Equal(["search {0}..."], configured.SearchPlaceholders);
        Assert.Equal(["nobody said {0}"], configured.SearchEmpty);
    }
}
