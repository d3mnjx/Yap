using Yap.Services.Chat;

namespace Yap.Tests;

/// <summary>
/// The three quick reactions (MR-41), on the service alone: no server and no clock. The numbers 2%, 35 and 149 are
/// the ones the rule states. A test that fails here means that the rule and the constants of QuickReactionsService
/// disagree; change both together.
/// </summary>
public class QuickReactionsTests
{
    // The heart as code points: it needs its variation selector to equal the server's default.
    private const string Heart = "❤️", Laugh = "😂", Thumbs = "👍";
    private static readonly Guid Ann = Guid.NewGuid();

    /// <summary>Reactions while the server runs: a button keeps its place.</summary>
    private static QuickReactionsService Live(params string[] reactions)
    {
        var service = new QuickReactionsService();
        foreach (var emoji in reactions) service.RecordToggle(Ann, emoji, added: true);
        return service;
    }

    /// <summary>The three after a start of the server: the order of the weights, the highest first (MR-83).</summary>
    private static IReadOnlyList<string> AfterStart(params string[] reactions)
    {
        var service = new QuickReactionsService();
        service.Seed(new Dictionary<Guid, List<string>> { [Ann] = [.. reactions] });
        return service.Get(Ann);
    }

    [Fact(DisplayName = "MR-41: a person without reactions has ❤️ 😂 👍")]
    public void No_reactions_give_the_fixed_three()
    {
        Assert.Equal([Heart, Laugh, Thumbs], new QuickReactionsService().Get(Guid.NewGuid()));
    }

    [Fact(DisplayName = "MR-41: an emoji that stays keeps its place, and a new emoji takes the place of the one that leaves")]
    public void An_emoji_that_stays_keeps_its_place()
    {
        var service = Live("🔥");
        Assert.Equal([Heart, Laugh, "🔥"], service.Get(Ann));   // 👍 is the last of the fill, so it leaves first

        service.RecordToggle(Ann, "🎉", added: true);
        Assert.Equal([Heart, "🎉", "🔥"], service.Get(Ann));

        service.RecordToggle(Ann, "👀", added: true);
        Assert.Equal(["👀", "🎉", "🔥"], service.Get(Ann));

        // 🎉 gets the highest weight by far. Before 2026-11-17 it moved to the first place, under the pointer.
        for (var i = 0; i < 3; i++) service.RecordToggle(Ann, "🎉", added: true);
        Assert.Equal(["👀", "🎉", "🔥"], service.Get(Ann));

        // 🔥 has the lowest weight of the three now, so 🚀 takes its place.
        service.RecordToggle(Ann, "🚀", added: true);
        Assert.Equal(["👀", "🎉", "🚀"], service.Get(Ann));

        // One of the fixed three is in the set already: it stays where it is.
        Assert.Equal([Heart, Laugh, Thumbs], Live(Laugh).Get(Ann));
    }

    [Fact(DisplayName = "MR-41, MR-83: after a start the highest weight is first; the emoji used last wins among equal counts, and more reactions beat a newer one")]
    public void A_newer_reaction_counts_more_and_a_count_still_wins()
    {
        Assert.Equal(["🔥", Heart, Laugh], AfterStart("🔥"));
        Assert.Equal([Laugh, Heart, Thumbs], AfterStart(Laugh));                // no emoji is there twice
        Assert.Equal(["🎉", "🔥", Heart], AfterStart("🔥", "🎉"));
        Assert.Equal(["d", "c", "b"], AfterStart("a", "b", "c", "d"));
        Assert.Equal(["🔥", "🎉", Heart], AfterStart("🔥", "🔥", "🎉"));         // 2 older reactions weigh 1.94, 1 new one weighs 1
    }

    [Fact(DisplayName = "MR-41: an emoji used for every reaction has the highest weight after 35 reactions, also after 300 reactions with another emoji")]
    public void A_new_habit_has_the_highest_weight_after_35_reactions()
    {
        string[] Habit(int hares) => [.. Enumerable.Repeat("🐢", 300), .. Enumerable.Repeat("🐇", hares)];

        Assert.Equal("🐢", AfterStart(Habit(34))[0]);   // 34 are not enough: a lower loss than 2% per reaction would also pass a test of 35 alone
        Assert.Equal(["🐇", "🐢", Heart], AfterStart(Habit(35)));
    }

    [Fact(DisplayName = "MR-41: a removed reaction takes 1 from its emoji; a removal of an emoji without weight changes nothing")]
    public void A_removed_reaction_takes_one()
    {
        var service = Live("🔥", "🔥");
        service.RecordToggle(Ann, "🔥", added: false);
        Assert.Equal([Heart, Laugh, "🔥"], service.Get(Ann));

        service.RecordToggle(Ann, "🔥", added: false);
        Assert.Equal([Heart, Laugh, Thumbs], service.Get(Ann));

        service.RecordToggle(Ann, "🎉", added: false);
        Assert.Equal([Heart, Laugh, Thumbs], service.Get(Ann));
    }

    [Fact(DisplayName = "MR-41: one single use leaves the count after 149 later reactions")]
    public void A_single_use_leaves_after_149_reactions()
    {
        var service = Live("🦊");
        for (var i = 0; i < 148; i++) service.RecordToggle(Ann, "🔥", added: true);
        Assert.Equal([Heart, "🔥", "🦊"], service.Get(Ann));

        service.RecordToggle(Ann, "🔥", added: true);
        Assert.Equal([Heart, "🔥", Laugh], service.Get(Ann));
    }

    [Fact(DisplayName = "MR-82: the event comes when one of the three emoji changes, and only then, with the person it concerns")]
    public void The_event_comes_only_for_a_change()
    {
        var service = new QuickReactionsService();
        var events = new List<(Guid Person, string Three)>();
        service.OnChanged += person => events.Add((person, string.Join(" ", service.Get(person))));
        var ben = Guid.NewGuid();

        service.RecordToggle(Ann, "🔥", added: true);     // a new emoji in the three
        service.RecordToggle(Ann, "🔥", added: true);     // the same three: no event
        service.RecordToggle(Ann, "🎉", added: true);     // a second emoji comes in
        service.RecordToggle(Ann, "🎉", added: true);     // 🎉 has the higher weight now, the three are the same: no event
        service.RecordToggle(Ann, "🎉", added: false);    // 🎉 keeps a weight of 0.98: no event
        service.RecordToggle(Ann, "🎉", added: false);    // 🎉 leaves
        service.RecordToggle(Ann, "🚀", added: false);    // a removal of an emoji without weight: no event
        service.RecordToggle(ben, Heart, added: true);    // ❤️ is one of the fixed three already: no event
        service.RecordToggle(ben, "🚀", added: true);

        Assert.Equal(
        [
            (Ann, $"{Heart} {Laugh} 🔥"),
            (Ann, $"{Heart} 🎉 🔥"),
            (Ann, $"{Heart} {Laugh} 🔥"),
            (ben, $"{Heart} {Laugh} 🚀"),
        ], events);
    }

    [Fact(DisplayName = "MR-83: the replay at the start sends no event and leaves a person without reactions at the fixed three")]
    public void The_replay_at_the_start_sends_no_event()
    {
        var service = new QuickReactionsService();
        var events = 0;
        service.OnChanged += _ => events++;

        service.Seed(new Dictionary<Guid, List<string>> { [Ann] = ["🔥", "🎉", "🎉", "👀"] });

        Assert.Equal(["🎉", "👀", "🔥"], service.Get(Ann));
        Assert.Equal(0, events);
        Assert.Equal([Heart, Laugh, Thumbs], service.Get(Guid.NewGuid()));

        // The places of the start are the places that the next reactions keep.
        service.RecordToggle(Ann, "🔥", added: true);
        service.RecordToggle(Ann, "🔥", added: true);
        Assert.Equal(["🎉", "👀", "🔥"], service.Get(Ann));
        Assert.Equal(0, events);
    }

    [Fact(DisplayName = "AD-40: a forgotten person has the fixed three again")]
    public void A_forgotten_person_has_the_fixed_three()
    {
        var service = Live("🔥", "🎉");
        service.ForgetUser(Ann);
        Assert.Equal([Heart, Laugh, Thumbs], service.Get(Ann));
    }
}
