namespace Yap.Services;

public partial class ChatService
{
    private readonly Dictionary<string, (SemaphoreSlim Gate, int Users)> acceptanceLocks = new();

    // Only retries/actions for this message (or creation of this DM pair) share a gate.
    // Reference counts include waiters, so removing an idle entry cannot split its lock.
    private async Task<IDisposable> LockAcceptance(string key)
    {
        SemaphoreSlim gate;
        lock (acceptanceLocks)
        {
            var entry = acceptanceLocks.GetValueOrDefault(key);
            gate = entry.Gate ?? new SemaphoreSlim(1, 1);
            acceptanceLocks[key] = (gate, entry.Users + 1);
        }
        await gate.WaitAsync();
        return new AcceptanceLease(() =>
        {
            lock (acceptanceLocks)
            {
                gate.Release();
                var users = acceptanceLocks[key].Users - 1;
                if (users == 0)
                {
                    acceptanceLocks.Remove(key);
                    gate.Dispose();
                }
                else
                    acceptanceLocks[key] = (gate, users);
            }
        });
    }
    private sealed class AcceptanceLease(Action release) : IDisposable
    {
        public void Dispose() => release();
    }
}
