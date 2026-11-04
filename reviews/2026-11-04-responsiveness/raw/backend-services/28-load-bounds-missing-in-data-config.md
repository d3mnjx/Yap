---
id: backend-services-28
title: Check that each deployment's Data/appsettings.json carries the Load bounds; a copy seeded before the key existed loads the whole history into memory
area: backend-services
journey: resume
category-guess: 3
behaviour-change: With bounds, messages older than the bounds (for example 90 days, or beyond 5,000 per conversation) are no longer readable by anyone until the bounds change; the product decision of the Load setting applies.
effort: S
estimated-gain: Unknown for production. Without bounds, start time (11), memory, and every per-conversation scan (06, 15, 16) grow with the full history. A user with a 50,000-message room pays O(50,000) scans; with the default bound of 5,000 per conversation the same scans are ten times shorter.
confidence: low
files: [Yap/Data/appsettings.json:43-52, Yap/appsettings.json:57-66, Yap/Program.cs:39-66, Yap/Configuration/PersistenceSettings.cs:10-35, Yap/Services/Chat/ChatService.cs:149-154]
---

## What the code does now
- `Yap/appsettings.json` sets `"Load": { "MaxMessagesPerChannel": 5000, "MaxDays": 90 }` under Persistence (`:63`).
- The `Data/appsettings.json` on this machine (dated 2026-08-20, gitignored) has a Persistence block without `Load` (`Data/appsettings.json:43-52`).
- At runtime the Data file replaces the built-in file in the configuration stack (`Program.cs:56-66`), and it is seeded only when it does not exist (`:49-55`). An absent key means no limit (`PersistenceSettings.cs:10`: "Absent keys mean no limit.").
- The startup log says which case applies: "Loaded {Channels} channels, {Messages} messages ({Left} more stay in the database: {Bounds})" only when bounds exist (`ChatService.cs:149-154`).

## Why it costs the user time
Every scan this report lists grows with the in-memory history. Instances seeded before the Load key existed may run unbounded without anyone choosing it.

## The change
No code change by default: read the startup log of each production instance. If an instance has no bounds and the owner wants the documented defaults, add the `Load` block to that instance's Data/appsettings.json. Optionally log a warning at start when persistence is on and no bounds are set, so the choice is visible.

## Risks and what could break
Adding bounds hides old messages (by design of the setting). That is a product decision for each instance owner, hence category 3.

## How to measure it
The startup log line per instance: messages loaded and messages left in the database.
