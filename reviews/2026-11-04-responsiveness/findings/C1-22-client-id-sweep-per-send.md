---
id: C1-22
title: Sweep the one-day clientId memory at most once a minute instead of on every send once it holds more than 1,000 keys
category: 1
journey: send
effort: S
confidence: high
behaviour-change: none
estimated-gain: A server with more than 1,000 sends a day walks the whole dedupe dictionary (one entry per send of the last day) on every send, and ConcurrentDictionary.Count takes all its internal locks on every send. At 20,000 sends a day that is a 20,000-entry walk per POST; an estimated 0.1 to 0.5 ms (not measured). Small, free to remove.
experiment: none
sources: [backend-services-26]
files: [Yap/Services/Chat/ChatService.cs:48-49, Yap/Services/Chat/ChatService.cs:500-512, Yap/Services/Chat/ChatService.cs:549-554]
---

## What the code does now
```csharp
if (_byClientId.Count > 1000) ForgetOldClientIds();
```
(`ChatService.cs:511`), and `ForgetOldClientIds` walks every entry: `foreach (var key in _byClientId.Where(e => e.Value.At < limit).Select(e => e.Key).ToList())` (`:549-554`). Entries live one day (`ClientIdMemory`, `:49`), so on a busy server the count stays above 1,000 and the walk runs on every send.

## Why it costs the user time
It is pure overhead in the send POST, growing with the day's traffic.

## The change
Keep a `DateTime _lastClientIdSweep`; sweep only when it is more than one minute old (use `Interlocked` or accept a rare double sweep). Two lines. Comment: the count is a size guard, the time gate keeps it off the per-send path.

## Risks and what could break
The dictionary can exceed 1,000 entries for up to a minute longer; memory only.

## How to measure it
Microbenchmark, or the "Post" wait (AD-26) on a server with many sends a day.