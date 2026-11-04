---
id: backend-services-23
title: Load the IP2Location file at startup in the background (or memory-map it) instead of inside the first Settings or admin request
area: backend-services
journey: admin
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: The singleton's constructor reads the whole DB3 BIN file with File.ReadAllBytes. The first request that needs it after each restart (Settings' location detect, the admin Users page, the Visitors tab) waits for that read and a large object allocation. The file size is unknown here (the folder is empty on this machine); IP2Location DB3 LITE files are tens of MB, so likely 0.1 to 1 s once per restart. Admin and Settings only.
confidence: low
files: [Yap/Services/Accounts/GeoLocationService.cs:29-78, Yap/Program.cs:147, Yap/Endpoints/AccountEndpoints.cs:68-71, Yap/Endpoints/AdminEndpoints.cs:32-42]
---

## What the code does now
`_data = File.ReadAllBytes(binFile);` in the constructor (`GeoLocationService.cs:53`). The service is a plain singleton (`Program.cs:147`) built on first injection: `GET /api/account/location` (`AccountEndpoints.cs:68`, called each time Settings opens, `js/pages/settings.js:93`) or the admin pages (`AdminEndpoints.cs:32`, `:52`, `:268`).

## Why it costs the user time
The first caller after a restart waits for a large synchronous read on a request thread. The whole file also stays in the managed heap for the process life (a large object the GC must scan past).

## The change
Resolve the service once in a background task after `app.Start` (`_ = Task.Run(() => app.Services.GetRequiredService<GeoLocationService>())`), or open the file with `MemoryMappedFile` and read through a view accessor, which costs no startup read and no heap.

## Risks and what could break
Background construction races with an early request: the DI container constructs singletons once, so the early request waits for the same construction; no double load.

## How to measure it
The startup log line already prints the read time ("IP2Location DB... ({Time}ms)", `GeoLocationService.cs:69-71`); compare with the first Settings open's `/api/account/location` timing.
