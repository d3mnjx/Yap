---
id: backend-media-20
title: Do not let a slow Klipy hold back the library hits of a GIF search for 15 s
area: backend-media
journey: picker-gif
category-guess: 3
behaviour-change: When Klipy is slow, the search shows library hits (or "No matches") after a few seconds without the Klipy section, instead of a spinner for up to 15 s.
effort: S
estimated-gain: Zero when Klipy answers fast. When it is slow or hangs, up to 11 s less spinner per search (15 s client timeout today against, for example, 4 s).
confidence: medium
files: [Yap/Endpoints/GifEndpoints.cs:38-50, Yap/Program.cs:131-136, Yap/Services/Gifs/KlipyGifProvider.cs:169-176]
---

## What the code does now
- `var library = cursor is null ? lib.SearchLocal(q, me.Id())... : [];` is computed at once, then `try { provider = await lib.SearchProviderAsync(q, cursor, ProviderPage, ct); } catch (Exception) { /* PK-31 */ }`, and only then `return Results.Ok(new SearchDto(library, provider.Items, provider.NextCursor));` (GifEndpoints.cs:42-49).
- The Klipy client's timeout is `client.Timeout = TimeSpan.FromSeconds(15);` (Program.cs:134).
- The picker shows a spinner until the answer (gif-picker.js:100-107).

## Why it costs the user time
The library hits are ready in microseconds, yet they wait for the provider. In the normal case that is the Klipy latency on every search; in the bad case the user stares at a spinner for 15 s, then sees library hits only. PK-31 already accepts a search with no provider section.

## The change
In the search route, bound the provider wait: a linked `CancellationTokenSource` with `CancelAfter(TimeSpan.FromSeconds(4))` passed to `SearchProviderAsync`, and the existing catch turns a timeout into "no provider section". About 4 lines. (Two separate requests, library first and provider second, would show library hits one Klipy-latency sooner in every search, but cost a second request and a more complex picker; not proposed.)

## Risks and what could break
- A Klipy that answers in 5 s would now never show; pick the limit from the logged Klipy durations.
- The trending route could take the same bound.

## How to measure it
Block api.klipy.com in a dev setup (or add a delay) and time the search answer before and after. Read the Klipy durations in the server log for the real distribution.
