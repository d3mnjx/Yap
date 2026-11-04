---
id: C1-27
title: Publish with ReadyToRun to cut JIT time at startup and on the first requests after a deploy
category: 1
journey: resume
effort: S
confidence: low
behaviour-change: none
estimated-gain: Unknown, needs measurement. The shared framework is already precompiled; the app and its packages (EF Core, ImageSharp, tusdotnet, WebPush) are compiled on first use, during the startup loads and the first requests of the reconnect wave.
experiment: none
sources: [backend-request-25]
files: [Yap/Yap.csproj:3-8, Yap/Dockerfile:28-36, .github/workflows/docker-publish.yml:44]
---

## What the code does now
- Yap.csproj sets no `PublishReadyToRun` (and no tiered-compilation options; TieredPGO is on by default).
- The image is published with `dotnet publish -c Release -o /app/publish /p:UseAppHost=false` (Dockerfile:36), without a runtime identifier. The GitHub workflow builds one platform (no `platforms:` key).

## Why it costs the user time
After a deploy every client reconnects within seconds. The first bootstrap, openRoom and send of the new process run code that is still being JIT-compiled at tier 0, and EF Core's startup queries do the same before Kestrel listens. ReadyToRun code starts at a precompiled tier and is recompiled later by tiering when hot.

## The change
Yap.csproj: `<PublishReadyToRun>true</PublishReadyToRun>` and `<RuntimeIdentifier>linux-x64</RuntimeIdentifier>` in a Release-only property group (or pass `-r linux-x64 -p:PublishReadyToRun=true` in the Dockerfile's publish line, which keeps local builds unchanged). The Dockerfile's base image is linux-x64, which matches.

## Risks and what could break
- Bigger publish output (ReadyToRun code is larger than IL).
- An arm64 host would need its own build; the workflow builds one platform today.
- Local Windows builds must not pick up the RID (keep it in the Docker publish command), because of the mixed-OS build-output rule in CLAUDE.local.md.

## How to measure it
Startup log: process start to "Now listening on"; the first openRoom and bootstrap times after a deploy (HubLatencyFilter slow events, RequestLogs CSV). Compare two deploys of the same commit with and without the flag.