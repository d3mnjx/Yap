using System.Collections.Concurrent;

namespace Yap.Services.Chat;

/// <summary>
/// Each person's three quick reactions of the action bar (MR-41), kept in memory: a decayed reaction score per
/// emoji so recent habits overtake old ones, a sequence number so the newest reaction wins a tie, and the three
/// emoji on the wire. While the server runs, an emoji that stays in the three keeps its button; the order by
/// score shows only after a start.
/// </summary>
public sealed class QuickReactionsService
{
    private static readonly string[] DefaultQuickReactions = ["❤️", "😂", "👍"];
    private const double Decay = 0.98;
    private const double ScoreEpsilon = 0.05;   // one single use falls below this after 149 later reactions

    private readonly ConcurrentDictionary<Guid, UserQuickReactions> _byUser = new();

    /// <summary>One of the person's three quick reactions changed; the handler reads <see cref="Get"/> so concurrent toggles never send a stale list last.</summary>
    public event Action<Guid>? OnChanged;

    // Runs one time at the start, before the server takes requests, so no reader sees a table that is half full.
    // Memory is the only source: reactions outside the load window (ChatSettings:Persistence:Load) or outside the limits
    // of ChatService.ReactionsForSeed do not count after a restart.
    public void Seed(IReadOnlyDictionary<Guid, List<string>> reactionsByUser)   // each list oldest first
    {
        foreach (var (userId, emojis) in reactionsByUser)
        {
            var state = new UserQuickReactions();
            foreach (var emoji in emojis) state.ApplyAdded(emoji);
            state.Top3 = state.Ranked();   // no bar shows yet, so no button has a place to keep: highest score first
            _byUser[userId] = state;
        }
    }

    // A person without reactions has no entry and gets the three defaults. A new account needs no call.
    public IReadOnlyList<string> Get(Guid userId) =>
        _byUser.TryGetValue(userId, out var state) ? state.Top3 : DefaultQuickReactions;

    public void RecordToggle(Guid userId, string emoji, bool added)
    {
        var state = _byUser.GetOrAdd(userId, _ => new UserQuickReactions());
        bool changed;
        lock (state.Sync)
        {
            if (added) state.ApplyAdded(emoji); else state.ApplyRemoved(emoji);
            changed = state.PublishTop3();   // true when one of the three emoji changed
        }
        if (changed) OnChanged?.Invoke(userId);   // outside the lock: the handler sends to the person's devices
    }

    public void ForgetUser(Guid userId) => _byUser.TryRemove(userId, out _);

    private sealed class UserQuickReactions
    {
        public readonly Lock Sync = new();
        public IReadOnlyList<string> Top3 = DefaultQuickReactions;

        private readonly Dictionary<string, Entry> _entries = new();
        private long _seq;

        public void ApplyAdded(string emoji)
        {
            List<string>? drop = null;
            foreach (var (key, entry) in _entries)
            {
                entry.Score *= Decay;
                if (entry.Score < ScoreEpsilon) (drop ??= []).Add(key);
            }
            if (drop is not null)
                foreach (var key in drop) _entries.Remove(key);

            if (_entries.TryGetValue(emoji, out var current)) { current.Score += 1.0; current.LastSeq = ++_seq; }
            else _entries[emoji] = new Entry { Score = 1.0, LastSeq = ++_seq };
        }

        // An older reaction has decayed below 1.0 by now, so subtracting a full 1.0 takes slightly too much and a
        // replay at the next start can differ a little; kept so a reaction needs no stored timestamp.
        public void ApplyRemoved(string emoji)
        {
            if (!_entries.TryGetValue(emoji, out var entry)) return;
            entry.Score -= 1.0;
            if (entry.Score < ScoreEpsilon) _entries.Remove(emoji);
        }

        /// <summary>The three emoji with the highest score, highest first, padded with the fixed three.</summary>
        public List<string> Ranked()
        {
            var top = _entries
                .OrderByDescending(kv => kv.Value.Score)
                .ThenByDescending(kv => kv.Value.LastSeq)
                .Take(3)
                .Select(kv => kv.Key)
                .ToList();
            foreach (var e in DefaultQuickReactions)
            {
                if (top.Count >= 3) break;
                if (!top.Contains(e)) top.Add(e);
            }
            return top;
        }

        // An emoji that stays in the three keeps its button, and a new emoji takes the button of the one that left
        // (MR-41). Do not publish Ranked() directly: the newest reaction always has the highest gain, so a person
        // with two or three emoji in about equal use got a new order after 9 of 100 reactions, also in the bar under
        // the pointer, and a second click on the same place then toggled a different emoji.
        public bool PublishTop3()
        {
            var ranked = Ranked();
            var incoming = ranked.Where(e => !Top3.Contains(e)).ToList();   // as many as leave: both lists hold three different emoji
            if (incoming.Count == 0) return false;
            var next = 0;
            Top3 = Top3.Select(e => ranked.Contains(e) ? e : incoming[next++]).ToList();
            return true;
        }
    }

    private sealed class Entry
    {
        public double Score;
        public long LastSeq;
    }
}
