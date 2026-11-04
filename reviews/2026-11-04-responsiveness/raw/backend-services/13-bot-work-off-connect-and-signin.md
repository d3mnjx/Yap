---
id: backend-services-13
title: Run the bot's join and sign-in notices in the background, so OnConnectedAsync and the sign-in POST do not wait for a bot send and its push
area: backend-services
journey: resume
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: A person who returns after two hours or more (the default ReturnAfterHours) triggers a bot DM to the admin inside their own OnConnectedAsync, and SignalR does not run that connection's openRoom until OnConnectedAsync returns. The bot send includes the whole Send path and, when the admin is away, the push crypto of finding 12 (an estimated 3 to 30 ms, not measured). The sign-in POST does the same for the "new device sign-in" DM to the person themself. Small next to a 900 ms round trip, but it sits directly on the rows of the most common resume (the morning open) and on the sign-in answer.
confidence: medium
files: [Yap/Services/Chat/SystemBotService.cs:377-407, Yap/Services/Chat/SystemBotService.cs:409-421, Yap/Services/Chat/SystemBotService.cs:453-471, Yap/Services/Chat/SystemBotService.cs:484-510, Yap/Services/Accounts/SignInService.cs:192-198, Yap/Endpoints/ChatHub.cs:34-67, Yap/Services/Presence/PresenceService.cs:57-71]
---

## What the code does now
- `ChatHub.OnConnectedAsync` calls `presence.Connect(session)` (`ChatHub.cs:54`), which raises `OnPresenceChanged` after the lock (`PresenceService.cs:69`, `Changes.Raise`).
- The bot's handler starts `_ = GreetAsync(username, lastSeen);` (`SystemBotService.cs:386`). `GreetAsync` has no await before its sends: `NotifyAdminOfJoinAsync` is `async` with no await inside (`:453-459`), `NotifyAdminOfReturn` is synchronous (`:462-471`), and both call `_chatService.Send(...)`. `SendWelcomeDmAsync` scans all channels with `DmChannelsOf(_botUserId)` (`:419`) on each person's first join after a restart, before its one-minute `Task.Delay`.
- Sign-in: `SignedIn` runs `_ = bot.NotifyNewDeviceLoginAsync(...)` (`SignInService.cs:196`), which is `async` with no await, so `GetOrCreateDm` (a scan of all channels) and `Send` (with push) run inside the sign-in request (`SystemBotService.cs:484-505`).

## Why it costs the user time
SignalR runs `OnConnectedAsync` to completion before it dispatches the client's first invocation, so the client's `openRoom` waits behind the bot. The sign-in answer waits behind the bot DM and its push.

## The change
- `HandlePresenceChanged`: `_ = Task.Run(() => GreetAsync(username, lastSeen));` (keep reading `lastSeen` before, as now; the comment at `:381-383` explains why).
- `SignInService.SignedIn`: `_ = Task.Run(() => bot.NotifyNewDeviceLoginAsync(...))`.
- Optionally make `NotifyAdminOfPendingUserAsync` (`SignInService.cs:75`) the same.
Three lines. Comment: bot messages are notices; nobody's request waits for them.

## Risks and what could break
- Tests that assert the bot DM exists right after connect or sign-in may need to wait for it (xUnit). The welcome already arrives a minute later, so tests likely poll.

## How to measure it
Time OnConnectedAsync on the server (a Stopwatch logged at debug) for a returning user with the admin away; compare the AD-41 `rows` minus `socket` for morning opens.
