---
id: client-static-06
title: Take the Settings, channel, admin and GIF-library rules out of the render-blocking CSS
area: client-static
journey: cold-open
category-guess: 2
behaviour-change: none, if the non-blocking file is in before the first Settings or admin open (it is precached by the worker)
effort: M
estimated-gain: "Cold: 18.5 KB (gzip level 1) of 78.8 KB leaves the set that blocks the first paint and main.js, about 150 ms at 1 Mbit/s. Every boot: 527 of the 1,296 style rules are no longer parsed and indexed before the first paint (unknown ms on a phone)."
confidence: medium
files: [Yap/wwwroot/index.html:93-103, Yap/wwwroot/css/pages.css:7-357, Yap/wwwroot/css/pages.css:359-1838, Yap/wwwroot/css/pages.css:1840-2292, Yap/wwwroot/css/pages.css:2294-2694, Yap/wwwroot/css/pages.css:2696-3798, Yap/wwwroot/css/pages.css:3800-4083, Yap/wwwroot/css/README.md:8-11]
---

## What the code does now
- `index.html:103` loads `css/pages.css` as a normal stylesheet, the ninth of nine. All nine block the first paint, and by the HTML spec they also hold back the classic scripts at the end of the body and the deferred `main.js`.
- `pages.css` is 85,548 B raw, 20,555 B at gzip level 1. It holds 600 of the 1,296 style rules and 623 of the 1,395 selectors of the nine files (counted with a small parser in the scratchpad).
- Its sections (raw bytes): GIF library manager 7,098 (`:7-357`), Admin 29,898 (`:359-1838`) and 4,757 more (`:3924-4083`), ChannelSettings 8,934 (`:1840-2292`), Invite 2,636 (`:2294-2432`), Login 5,184 (`:2434-2694`), Settings 24,352 (`:2696-3798`), VerifyDevice 2,264 (`:3800-3922`).
- The chat page uses none of it at boot. The sign-in pages (Login, Invite, Verify: 10,085 B raw, 2,188 B gzip 1) can be the first screen of a first visit, so they must stay blocking. The rest (75.5 KB raw, 18.5 KB gzip 1) is needed only when Settings, a channel page, the GIF library or Admin opens.

## Why it costs the user time
On a first visit the far user waits for all CSS bytes before `main.js` can start the bootstrap fetch. About a quarter of those bytes style pages that are not on screen. On every boot, warm included, the browser parses and indexes those rules before the first paint. Who pays: everyone at every boot (parse); first visits on the far link (bytes).

## The change
1. Split `pages.css` into `css/pages-signin.css` (Invite, Login, Verify sections) and `css/pages-app.css` (GIF library, Admin, ChannelSettings, Settings, the admin tail). Copy, do not edit, the rules; keep the section order.
2. `index.html`: `pages-signin.css` takes the place of `pages.css` in the list. `pages-app.css` stays last in the cascade but does not block:
   ```html
   <link rel="stylesheet" href="css/pages-app.css?v={{build}}" media="print" onload="this.media='all'" />
   ```
   (A grep finds no Content-Security-Policy header in the app, and the page already runs an inline script, so the inline handler is allowed. A proxy could add one: check the deployments.)
3. `css/README.md` load-order table: name the two files.

## Risks and what could break
- Tie rules: README says later files win ties. `pages-app.css` stays the last file, so the order holds.
- A class from `pages.css` that the chat frame uses at boot would show unstyled for a moment. Check with a grep of the unprefixed class names (`.upload-button`, `.remove-button`, `.save-status`, `.error-message`, `.danger-*`) against `js/ui/*` and `js/pages/chat.js` before the split.
- A Settings or admin open in the first seconds of a cold first session could show unstyled until the file lands. The worker precaches it, so later sessions are not affected.

## How to measure it
`npm run load` cold: `scripts` and `paint`. Warm, on a phone: Performance trace, "Parse Stylesheet" and the first "Recalculate Style" at boot, before and after.
