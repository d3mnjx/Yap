---
id: backend-services-11
title: Load messages and reactions with two queries instead of one query per conversation, and log how long each startup step takes
area: backend-services
journey: resume
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Start time after a deploy. With one query per conversation, a server with 1,000 accounts has at least 1,000 direct conversations (the bot opens one with every new account), so at least 1,000 EF queries with an Include and an ORDER BY run before app.Run. At 50,000 messages the rows themselves (three JSON column conversions each, plus a LEFT JOIN per reaction) add more. Estimated 1 to 3 s total for 50,000 messages on a small VPS, of which the per-query overhead is perhaps 0.2 to 1 s. Unknown; the step timings in the change give the real number.
confidence: low
files: [Yap/Services/Persistence/Loads.cs:18-40, Yap/Services/Chat/ChatService.cs:108-155, Yap/Program.cs:210-224, Yap/Services/Persistence/ChatDbContext.cs:41-56, Yap/Services/Persistence/ChatDbContext.cs:151-155, Yap/Data/appsettings.json:43-52, Yap/appsettings.json:63]
---

## What the code does now
- `foreach (var channel in channels) { IQueryable<ChatMessage> query = db.Messages.Include(m => m.Reactions).AsNoTracking().Where(m => m.ChannelId == channel.Id); ... await query.ToListAsync(); }` (`Loads.cs:28-37`): one round of EF query execution per conversation.
- Each message row converts three JSON list columns and one JSON object column (`ChatDbContext.cs:152-155`, `StoreAsJsonList` deserializes `"[]"` too, `:41-47`).
- `Include(m => m.Reactions)` without `AsSplitQuery` returns the message columns again for every reaction row.
- All of it runs before `app.Run()` (`Program.cs:212-224`), as do GIF, push and bot initialisation.
- The startup log says how many rows loaded but not how long it took (`ChatService.cs:149-154`).
- The repo's `Yap/appsettings.json` sets `"Load": { "MaxMessagesPerChannel": 5000, "MaxDays": 90 }` (`:63`), but `Yap/Data/appsettings.json` (which replaces it at runtime when present, `Program.cs:56-66`) has no `Load` key (`Data/appsettings.json:43-52`). A deployment seeded before the key existed loads its whole history. See 28.

## Why it costs the user time
After a deploy no client gets rows until the load ends; Kestrel is not listening yet.

## The change
1. Without bounds: one query `db.Messages.AsNoTracking().OrderBy(m => m.ChannelId).ThenBy(m => m.Timestamp)` and one `db.Reactions.AsNoTracking()`, grouped in memory (a dictionary by message id). With bounds: keep the per-channel query for messages if needed (or a raw SQL window function), but load reactions once for the loaded ids, or use `AsSplitQuery()`.
2. Log a Stopwatch per step in `Program.cs` (migrate, users, links, mutes, chat, GIFs, push, bot, cleanup). Three lines per step, and the deploy then shows where the time goes.

## Risks and what could break
- The in-memory join must keep reactions in their stored order (MR-38 orders groups by first use): order the reaction query by its `Id`.
- Memory peak at start grows slightly while both lists exist.

## How to measure it
Generate 50,000 messages over 1,000 conversations in a test database (AD-08 makes messages; a script makes DMs), then time process start to the first successful `/hub` connect, before and after. The step timings answer "how long would a start with 50,000 messages take" directly.
