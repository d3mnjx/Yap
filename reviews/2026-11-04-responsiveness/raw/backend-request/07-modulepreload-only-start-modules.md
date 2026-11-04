---
id: backend-request-07
title: Do not modulepreload the Settings, Admin and channel-settings pages at every start
area: backend-request
journey: cold-open
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Cold first visit: about 41 KB compressed (133 KB raw) fewer bytes competing with the start modules, about 0.33 s at 1 Mbit/s. Every start, warm too: 133 KB less JavaScript to read from the worker's cache and to parse and compile (phone cost unknown, needs measurement). With the import-walk rule (also drops ui/gif-library.js and ui/tooltip.js), 148,942 B raw / 46.7 KB gzip -9.
confidence: medium
files: [Yap/Endpoints/ShellAssets.cs:19-39, Yap/wwwroot/index.html:113-118, Yap/wwwroot/js/main.js:36-44]
---

## What the code does now
- ShellAssets scans `wwwroot/js/**/*.js` and writes a modulepreload link for every module except `/js/data/`: `ModulePreloads = string.Join("\n    ", modules.Where(p => !p.StartsWith("/js/data/")).Select(...))` (ShellAssets.cs:37). Its own comment gives the reason for the data exception: "a preload fetches and compiles them at every start, for a picker that may never open (PK-11)".
- The pages are lazy in main.js: `admin: () => import('./pages/admin.js')`, `settings: () => import('./pages/settings.js')`, `'channel-settings': () => import('./pages/channel-settings.js')`, and so on (main.js:37-43).
- A static import walk of wwwroot/js (regex over `import ... from` lines, done for this review) gives: main.js reaches 29 modules, main.js plus pages/chat.js 33. Preloaded but not reachable from them: pages/admin.js 77,341 B (23.1 KB gzip -9), pages/settings.js 38,154 B (12.1 KB), pages/settings-debug.js 9,333 B (3.5 KB), pages/channel-settings.js 8,204 B (2.7 KB), pages/login.js 9,616 B (3.3 KB), pages/invite.js 5,304 B (2.0 KB), pages/verify.js 1,813 B (0.8 KB), ui/gif-library.js 13,301 B (4.2 KB), ui/tooltip.js 2,609 B (1.0 KB).

## Why it costs the user time
On a first visit the browser fetches every preload in parallel on the 1 Mbit/s link, so the Admin page's 23 KB shares the bandwidth with the modules main.js needs before anything runs. On every start, warm included, the browser reads the files from the worker and parses and compiles them, on the phone's main thread, for pages most people open rarely (Admin only for the admin).

## The change
ShellAssets.cs:37: also leave out the page modules that are never the first page: admin, settings, settings-debug, channel-settings. Keep chat, login, invite and verify: a first visit lands on them, and their import starts only after the bootstrap answer, so without a preload they would add a round trip. Two readable forms:
- simple: `static readonly string[] LazyPages = ["/js/pages/admin.js", "/js/pages/settings.js", "/js/pages/settings-debug.js", "/js/pages/channel-settings.js"];` with a comment that names the PK-11 reason;
- no hand list: walk the static imports from main.js and the four start pages (a 15-line regex walk in ShellAssets, run once at startup) and preload only what it reaches (36 modules today). This also drops gif-library.js and tooltip.js.
The import map and the worker's shell list stay complete, so the import on first use carries the build stamp and hits the worker's cache.

## Risks and what could break
- First open of Settings or Admin in a tab whose worker has not installed yet: one network round trip for the page module, and a second for its own static imports (settings.js imports settings-debug.js and gif-library.js). With the worker installed, both come from its cache.
- The hand list form can drift when a page is added; the walk form cannot.

## How to measure it
`npm run load`: cold load, the `scripts` phase and bytes on the wire; warm load on a phone, the `scripts` phase (Navigation Timing to the first statement of main.js). Settings first open time in a fresh profile.
