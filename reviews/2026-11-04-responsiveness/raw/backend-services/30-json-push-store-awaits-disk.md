---
id: backend-services-30
title: With the default JSON push store, write the subscriptions file in the background instead of awaiting a read and a rewrite of the whole file inside the request
area: backend-services
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Each subscribe, unsubscribe and device removal reads, parses, rewrites and pretty-prints the whole push-subscriptions.json under a semaphore before it answers. A few ms per request; the request already costs a round trip. Low gain; listed because it is a request that awaits disk, which the memory-first doctrine excludes, and the default deployment config uses this store.
confidence: high
files: [Yap/Services/Notifications/JsonPushSubscriptionPersistence.cs:50-104, Yap/Services/Notifications/PushSubscriptionStore.cs:52-83, Yap/Services/Notifications/PushSubscriptionStore.cs:112-133, Yap/Endpoints/PushEndpoints.cs:25-67, Yap/Data/appsettings.json:34, Yap/Program.cs:99-103]
---

## What the code does now
- `"PushSubscriptionStorage": "Json"` (`Data/appsettings.json:34`), so `JsonPushSubscriptionPersistence` is registered (`Program.cs:99-103`).
- `SaveSubscriptionAsync` updates memory and then `await _persistence.SaveAsync(entry)` (`PushSubscriptionStore.cs:69-76`); `SaveAsync` awaits the semaphore, reads the file, deserializes, edits, serializes indented and writes it (`JsonPushSubscriptionPersistence.cs:50-68`). `RemoveSubscriptionAsync` does the same (`:70-87`).
- The endpoints await these before answering (`PushEndpoints.cs:34`, `:53`, `:65`).
- The comment at `PushSubscriptionStore.cs:64-65` mentions "the silent re-subscribe that runs on every load"; the current client posts `/api/push/subscribe` only from `subscribe()` on a user action (`js/push.js:96`, called from the prompt and Settings), so this is not on the boot path.

## Why it costs the user time
Only on the notification toggles in Settings and the push prompt, by a few ms. The DB store already does the right thing (`DbPushSubscriptionPersistence` enqueues on the writer).

## The change
In `PushSubscriptionStore`, call the persistence without awaiting it in the request: `_ = PersistAsync(...)` with its own try/catch log, keeping the semaphore inside the JSON persistence so writes stay ordered. Optionally make the JSON persistence write the whole in-memory list (no read-modify-write). Fix the stale comment.

## Risks and what could break
A crash right after the answer can lose the new subscription; the client re-subscribes when the user toggles again (best effort, as the doctrine accepts).

## How to measure it
Server time of `POST /api/push/subscribe` (request log), before and after.
