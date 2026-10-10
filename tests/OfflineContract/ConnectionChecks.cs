using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Components.Server;
using Microsoft.AspNetCore.Components.Server.Circuits;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Yap.Models;
using Yap.Offline;
using Yap.Services;

static class ConnectionChecks
{
    static void Check(bool value, string label)
    {
        if (!value)
            throw new Exception(label);
        Console.WriteLine("PASS " + label);
    }

    public static async Task Run(IServiceProvider services, HttpClient http, string csrf, User alice, User bob)
    {
        var chat = services.GetRequiredService<ChatService>();
        var live = services.GetRequiredService<OfflineLiveService>();
        var clock = (FakeTimeProvider)services.GetRequiredService<TimeProvider>();
        var policy = services.GetRequiredService<PresenceOptions>();
        Check(services.GetRequiredService<IOptions<CircuitOptions>>().Value.DisconnectedCircuitRetentionPeriod == policy.CircuitRetention,
            "Blazor state and presence share configured circuit retention");
        foreach (var session in chat.GetSessionsForUser(alice.Username))
            await chat.RemoveUserAsync(session.SessionId);

        // Exercise actual circuit callbacks with scoped user state. Circuit has no public
        // constructor; only its ID is needed by the diagnostic tracker in these callbacks.
        using var scope = services.CreateScope();
        var state = scope.ServiceProvider.GetRequiredService<UserStateService>();
        state.UserId = alice.Id;
        state.Username = alice.Username;
        state.SessionId = "circuit-lifecycle";
        var handler = ActivatorUtilities.CreateInstance<ChatCircuitHandler>(scope.ServiceProvider);
        var circuit = CircuitWithId("lifecycle-fixture");
        await handler.OnCircuitOpenedAsync(circuit, default);
        await chat.AddUserAsync(state.SessionId, alice.Id, alice.Username, circuitId: circuit.Id);
        await handler.OnConnectionDownAsync(circuit, default);
        clock.Advance(policy.DisconnectGrace - TimeSpan.FromMilliseconds(1));
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online && !chat.IsPageVisible(alice.Username), "circuit disconnect clears visibility but preserves grace");
        await handler.OnConnectionUpAsync(circuit, default);
        clock.Advance(policy.CircuitRetention);
        Check(chat.HasSession(state.SessionId) && chat.GetUserStatus(alice.Username) == UserStatus.Online,
            "circuit reconnect inside grace cancels away and removal");
        await handler.OnConnectionDownAsync(circuit, default);
        clock.Advance(policy.DisconnectGrace);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Away, "circuit drop applies auto-away at configured grace");
        clock.Advance(policy.CircuitRetention - policy.DisconnectGrace);
        Check(!chat.HasSession(state.SessionId), "circuit drop removes presence at configured retention");
        await handler.OnConnectionUpAsync(circuit, default);
        Check(chat.HasSession(state.SessionId) && !chat.IsPageVisible(alice.Username), "warm circuit recreates expired presence without asserting visibility");
        await handler.OnCircuitClosedAsync(circuit, default);
        Check(!chat.HasSession(state.SessionId), "circuit explicit close removes presence immediately");

        async Task Join(string id, UserStatus status = UserStatus.Online) =>
            await live.Join(id, alice, live.Ticket(alice), status, true, false, 0);
        await Join("hub-grace");
        await live.Leave("hub-grace");
        clock.Advance(policy.DisconnectGrace - TimeSpan.FromMilliseconds(1));
        await Join("hub-reconnected");
        clock.Advance(policy.HubRetention);
        Check(!chat.HasSession("chat:hub-grace") && chat.HasSession("chat:hub-reconnected") && chat.GetUserStatus(alice.Username) == UserStatus.Online,
            "hub reconnect inside grace preserves status and cancels old expiry");
        await live.Leave("hub-reconnected");
        clock.Advance(policy.DisconnectGrace);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Away, "hub drop applies auto-away at configured grace");
        await live.Leave("hub-reconnected"); // duplicate transport notification cannot extend retention
        clock.Advance(policy.HubRetention - policy.DisconnectGrace);
        Check(!chat.HasSession("chat:hub-reconnected"), "hub drop removes presence five minutes from original disconnect");

        async Task<HttpResponseMessage> Close(string id, bool withCsrf = true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/chat/presence/leave")
            {
                Content = JsonContent.Create(new { connectionId = id })
            };
            if (withCsrf)
                request.Headers.Add("X-CSRF-TOKEN", csrf);
            request.Headers.Add("X-Yap-Chat-User", alice.Id.ToString());
            return await http.SendAsync(request);
        }
        await Join("hub-close");
        Check((await Close("hub-close", false)).StatusCode == HttpStatusCode.Forbidden && chat.HasSession("chat:hub-close"), "leave endpoint requires antiforgery");
        await live.Join("bob-close", bob, live.Ticket(bob), UserStatus.Online, true, false, 0);
        await Close("bob-close");
        Check(chat.HasSession("chat:bob-close"), "leave endpoint cannot close another account's session");
        await Join("hub-sibling");
        Check((await Close("hub-close")).StatusCode == HttpStatusCode.NoContent && !chat.HasSession("chat:hub-close")
            && chat.HasSession("chat:hub-sibling") && chat.GetUserStatus(alice.Username) == UserStatus.Online,
            "authenticated close removes only the requested tab immediately");
        await live.Leave("hub-close");
        await Close("hub-close");
        clock.Advance(policy.HubRetention);
        Check(chat.HasSession("chat:hub-sibling"), "late duplicate close and disconnect cannot remove a sibling or replacement");
        await live.Leave("hub-sibling");
        await Close("hub-sibling");
        Check(!chat.HasActiveSession(alice.Username), "close received after socket loss immediately removes retained presence");
        foreach (var status in new[] { UserStatus.Away, UserStatus.Invisible })
        {
            await Join("hub-manual", status);
            await live.Leave("hub-manual");
            clock.Advance(policy.DisconnectGrace);
            Check(chat.GetUserStatus(alice.Username) == status && !chat.IsAutoAway(alice.Username), "disconnect preserves manual " + status);
            await live.Close("hub-manual", alice);
        }
        await Join("hub-dropped");
        await Join("hub-foreground");
        await live.Leave("hub-dropped");
        clock.Advance(policy.DisconnectGrace);
        Check(chat.GetUserStatus(alice.Username) == UserStatus.Online, "foreground sibling prevents disconnect auto-away");
        await live.Close("hub-dropped", alice);
        await live.Close("hub-foreground", alice);
        await live.Close("bob-close", bob);
        clock.Advance(policy.DisconnectGrace);
        var joined = 0;
        var left = 0;
        var callbacksUnderLock = false;
        var gate = typeof(ChatService).GetField("_connectionGate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(chat)!;
        void Changed(string name, bool up)
        {
            callbacksUnderLock |= Monitor.IsEntered(gate);
            if (name != alice.Username)
                return;
            if (up)
                joined++;
            else
                left++;
        }
        void People() => callbacksUnderLock |= Monitor.IsEntered(gate);
        chat.OnUserChanged += Changed;
        chat.OnUsersListChanged += People;
        try
        {
            await Join("review-join");
            Check(joined == 0, "first join notification waits for grace");
            clock.Advance(policy.DisconnectGrace);
            Check(joined == 1, "stable first join announces once");
            for (var i = 0; i < 3; i++)
            {
                await live.Close("review-join", alice);
                Check(!chat.HasActiveSession(alice.Username), "close removes presence before notification grace");
                clock.Advance(policy.DisconnectGrace - TimeSpan.FromMilliseconds(1));
                await Join("review-join");
            }
            clock.Advance(policy.DisconnectGrace);
            Check(joined == 1 && left == 0, "reload and Settings returns cancel join/leave noise");
            await live.Close("review-join", alice);
            clock.Advance(policy.DisconnectGrace);
            Check(left == 1, "sustained absence emits one leave");
            await Join("review-join");
            clock.Advance(policy.DisconnectGrace);
            Check(joined == 2, "return after sustained absence emits a fresh join");
            await chat.ConnectionDown("chat:review-join");
            clock.Advance(policy.DisconnectGrace);
            Check(left == 2 && chat.HasSession("chat:review-join"), "disconnect announcements use grace independently of retained session lifetime");
            await Join("review-return");
            clock.Advance(policy.DisconnectGrace);
            Check(joined == 3, "return while a disconnected session is retained announces after sustained absence");
            await live.Close("review-return", alice);
            clock.Advance(policy.HubRetention + policy.DisconnectGrace);
            Check(!callbacksUnderLock, "lifecycle and timer notifications run outside the connection gate");
        }
        finally { chat.OnUserChanged -= Changed; chat.OnUsersListChanged -= People; }

    }

    private static Circuit CircuitWithId(string id)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        var assembly = typeof(Circuit).Assembly;
        var hostType = assembly.GetType("Microsoft.AspNetCore.Components.Server.Circuits.CircuitHost")!;
        var idType = assembly.GetType("Microsoft.AspNetCore.Components.Server.Circuits.CircuitId")!;
        var host = RuntimeHelpers.GetUninitializedObject(hostType);
        hostType.GetField("<CircuitId>k__BackingField", flags)!.SetValue(host, Activator.CreateInstance(idType, flags, null, ["fixture-secret", id], null));
        return (Circuit)Activator.CreateInstance(typeof(Circuit), flags, null, [host], null)!;
    }
}
