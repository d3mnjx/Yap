---
id: backend-request-23
title: Look up branding overrides in a remembered list instead of a file-system check on every request
area: backend-request
journey: all
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One file-system stat less per request for every module, stylesheet, emoji image, upload, API call and hub request. Microseconds each; small for one user. Listed because it runs on every request of the cold load (58 requests from the page alone).
confidence: low
files: [Yap/Program.cs:271-297]
---

## What the code does now
The branding middleware runs before every static file handler. For any path except the manifest it calls `var fileInfo = brandingProvider.GetFileInfo(context.Request.Path.Value ?? "");` and checks `fileInfo.Exists` (Program.cs:284-288). `PhysicalFileProvider.GetFileInfo` builds the full path under Data/branding and asks the file system. The folder normally holds a few files (favicon, icons) or nothing.

## Why it costs the user time
A system call per request on the hot path. On a loaded server with slow storage (a network volume, a busy SD card) each stat can take longer. The effect on one user's latency is small.

## The change
At startup, list the folder into a `HashSet<string>` of request paths, and refresh it when `brandingProvider.Watch("**/*")` signals a change (`ChangeToken.OnChange`). The middleware calls `GetFileInfo` only when the set contains the path. The comment "no rebuild needed" stays true: the watcher picks up new files.

## Risks and what could break
File watchers on some container volumes do not fire (Docker on Windows, some network file systems). Then a new branding file needs a restart; say so in the comment, or fall back to polling (`DOTNET_USE_POLLING_FILE_WATCHER`).

## How to measure it
Not worth a dedicated measurement; check with `strace -c` on a test box that the per-request `stat` calls under Data/branding disappear.
