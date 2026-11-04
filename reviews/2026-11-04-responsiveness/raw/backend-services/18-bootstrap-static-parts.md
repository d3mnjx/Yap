---
id: backend-services-18
title: Build the bootstrap's texts once per process and send texts and themes only when the client's copy is stale
area: backend-services
journey: resume
category-guess: 2
behaviour-change: none
effort: S
estimated-gain: The texts (12 lists from configuration) are about 2 KB of JSON and the theme registry about 1.3 KB, resent with every bootstrap although they change only with a deploy or a config edit. About 1 to 1.5 KB compressed per bootstrap, about 10 ms at 1 Mbit/s. On the server, config.Texts() binds 12 configuration sections by reflection per bootstrap (estimated well under 1 ms). Low gain.
confidence: medium
files: [Yap/Endpoints/BootstrapEndpoints.cs:52-56, Yap/Configuration/ServerConfig.cs:17-36, Yap/Services/Accounts/ThemeRegistry.cs:28-96, Yap/Data/appsettings.json:70-172]
---

## What the code does now
- `Texts: config.Texts()` (`BootstrapEndpoints.cs:56`) calls `configuration.GetSection($"ChatSettings:FunnyTexts:{key}").Get<string[]>()` twelve times (`ServerConfig.cs:17-36`).
- `ThemeRegistry.All` goes in `ClientConfigDto` (`BootstrapEndpoints.cs:55`): eleven theme records with gradient strings (`ThemeRegistry.cs:28-96`), used by the Settings theme grid.
- The FunnyTexts block in the deployment config is about 100 lines (`Data/appsettings.json:70-172`).

## Why it costs the user time
Same as 17, smaller: bytes on the reconnect path that the client already holds.

## The change
Fold texts and themes into the existing emoji stamp (rename it to a "static stamp" covering emoji rules, texts and themes), computed once per process with a reload on the configuration change token. Cache `TextsDto` in `ServerConfig` the same way. The client keeps its stored copy when the field is null (it already does this for `emojiImages`).

## Risks and what could break
An admin who edits the FunnyTexts in Data/appsettings.json (reloadOnChange is on) expects the change; the change token must invalidate the cache and the stamp.

## How to measure it
Bootstrap transferSize before and after.
