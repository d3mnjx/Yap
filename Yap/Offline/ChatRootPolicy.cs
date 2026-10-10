using Microsoft.AspNetCore.Routing.Matching;

namespace Yap.Offline;

// Both Razor Welcome and chat own GET /. Select chat only for authenticated visits
// without returnUrl; rejecting this candidate lets normal Razor routing handle the rest.
public sealed class ChatRootPolicy : MatcherPolicy, IEndpointSelectorPolicy
{
    public override int Order => -100;
    public bool AppliesToEndpoints(IReadOnlyList<Endpoint> endpoints)
        => endpoints.Any(e => e.Metadata.GetMetadata<ChatRootPolicy>() != null);
    public Task ApplyAsync(HttpContext http, CandidateSet candidates)
    {
        for (var i = 0; i < candidates.Count; i++)
            if (candidates[i].Endpoint.Metadata.GetMetadata<ChatRootPolicy>() != null
                && !ChatRoutes.IsAuthenticatedRoot(http))
                candidates.SetValidity(i, false);
        return Task.CompletedTask;
    }
}
