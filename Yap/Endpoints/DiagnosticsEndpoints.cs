using Yap.Services;

namespace Yap.Endpoints;

public static class DiagnosticsEndpoints
{
    public static void MapDiagnosticsEndpoints(this IEndpointRouteBuilder app)
    {
        // Counts, usernames, IPs and latency telemetry — admin eyes only.
        var group = app.MapGroup("/api/diagnostics").RequireAdmin();

        group.MapGet("", (ChatService chatService, CircuitTracker circuitTracker) =>
        {
            var diagnostics = chatService.GetDiagnostics();
            var (active, disconnected, totalCreated) = circuitTracker.GetStats();

            diagnostics.ActiveCircuits = active;
            diagnostics.DisconnectedCircuits = disconnected;
            diagnostics.TotalCircuitsCreated = totalCreated;

            return Results.Ok(diagnostics);
        });

        group.MapGet("/circuits", (CircuitTracker circuitTracker) =>
        {
            var circuits = circuitTracker.GetAllCircuits();
            return Results.Ok(new
            {
                circuits = circuits.Select(c => new
                {
                    c.CircuitId,
                    c.CreatedAt,
                    c.IsConnected,
                    c.DisconnectedAt,
                    AgeMinutes = (DateTime.UtcNow - c.CreatedAt).TotalMinutes,
                    c.Username,
                    c.ClientIp,
                    c.IsWebSocket,
                    c.LastRttMs,
                    c.AvgRttMs,
                    c.MaxRttMs,
                    c.RttSamples,
                    c.RttUpdatedAt,
                    c.SlowEventCount,
                    c.MaxEventMs,
                    c.LastSlowEventAt
                }),
                summary = new
                {
                    active = circuits.Count(c => c.IsConnected),
                    disconnected = circuits.Count(c => !c.IsConnected)
                }
            });
        });

        // Was /api/test-exception — moved under the gated group so it can't be triggered anonymously.
        group.MapGet("/test-exception", () =>
        {
            throw new InvalidOperationException("This is a test exception to verify error handling!");
        });
    }
}
