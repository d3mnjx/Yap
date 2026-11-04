---
id: client-core-29
title: Import the pickers, the viewer, the pins panel, the recorder and the install dialog on first use
area: client-core
journey: cold-open
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Eight modules, 60,284 bytes raw and about 22.5 KB gzip, leave the start: their fetch on a cold load (about 180 ms of a 1 Mbit/s link) and their parse and evaluation on every start (unknown, likely a few ms on a phone). The first use of each feature then waits for one worker cache hit.
confidence: low
files: [Yap/wwwroot/js/ui/message.js:13-18, Yap/wwwroot/js/ui/composer.js:11-17, Yap/wwwroot/js/ui/composer.js:381-387, Yap/wwwroot/js/ui/frame.js:11-15, Yap/wwwroot/js/sender.js:19, Yap/Endpoints/ShellAssets.cs:154]
---

## What the code does now
These modules are on the boot path only through static imports for actions the start never takes:

| Module | Raw bytes | Imported by | Used for |
| --- | --- | --- | --- |
| ui/emoji-picker.js | 8,864 | ui/message.js (`reactionPicker`), ui/composer.js | opening the emoji picker |
| ui/gif-picker.js | 16,402 | ui/composer.js | opening the GIF picker |
| ui/gallery.js | 9,178 | ui/message.js (`openGallery`) | tapping a picture |
| ui/pins.js | 8,531 | ui/frame.js (`openPins`) | the pins button |
| pwa.js | 2,834 | ui/message.js (`openInstallDialog`) | the install link in a bot message |
| ui/recorder.js | 5,197 | ui/composer.js | recording a voice message |
| upload.js | 6,922 | sender.js, ui/composer.js (`check`) | sending files |
| ui/confirm.js | 2,356 | ui/frame.js | the sign-out confirmation |

All are also preloaded (ShellAssets.cs:154). The composer already builds the pickers on their first open (`mountPickers` in ui/composer.js:381-387, called from `openPicker` at ui/composer.js:418-419); only the import is eager. `ui/emoji-picker.js` already loads its 44 KB data module on first open (`import('../data/emoji-list.js')`), so the pattern exists in the code.

## Why it costs the user time
On a cold load their bytes compete with the modules the start needs. On every start the browser parses them and runs their top level. The cost per module is small; together they are an eighth of the app's JavaScript.

## The change
Replace each static import used only in an event handler with a dynamic import at the call site, for example in ui/message.js: `const { openGallery } = await import('./gallery.js');` inside the tap handler. Leave out of the preload list what is no longer in the static boot graph (client-core-16 computes that list from the imports). Keep `upload.check` cheap: it has no tus dependency and could move to a tiny module, or stay.

## Risks and what could break
- A first tap waits for an import: a worker cache hit plus a parse, a few ms; offline it works from the worker's cache.
- Handlers become async; an exception in the import must be caught and shown (SH-41 style).
- More code paths to test. The gain is small; do this only if the boot report shows the `scripts` phase matters on phones.

## How to measure it
Warm open on a mid-range Android phone and an iPhone: the `scripts` phase of the boot report before and after. Cold open on the far link: bytes on the wire.
