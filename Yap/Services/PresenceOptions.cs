namespace Yap.Services;

/// <summary>Disconnect policy shared by both transports; circuit retention also preserves Blazor state.</summary>
public sealed class PresenceOptions
{
    public TimeSpan DisconnectGrace { get; set; } = TimeSpan.FromSeconds(30);
    public TimeSpan HubRetention { get; set; } = TimeSpan.FromHours(4);
    public TimeSpan CircuitRetention { get; set; } = TimeSpan.FromHours(4);

    public void Validate()
    {
        if (DisconnectGrace <= TimeSpan.Zero || HubRetention < DisconnectGrace || CircuitRetention < DisconnectGrace
            || HubRetention.TotalMilliseconds > uint.MaxValue - 1 || CircuitRetention.TotalMilliseconds > uint.MaxValue - 1)
            throw new InvalidOperationException("Presence retention must cover a positive disconnect grace and fit a timer interval.");
    }
}
