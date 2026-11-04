---
id: backend-services-29
title: Move the image-emoji search keywords out of the bootstrap's emoji rules (the picker needs them, the first paint does not)
area: backend-services
journey: cold-open
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: The shipped pack has 75 emoji with an 11 KB keywords.json; each PackEmojiDto carries the keyword string. The emoji rules are about 15 to 17 KB raw, of which keywords are about 11 KB, an estimated 3 KB compressed (about 25 ms at 1 Mbit/s). They travel only on a first load, after a stamp change, and in the stored bootstrap; but a first load awaits the bootstrap before any paint. Low gain; grows with custom packs.
confidence: medium
files: [Yap/Services/Emoji/EmojiImages.cs:32-63, Yap/Services/Emoji/CustomEmojiService.cs:183-189, Yap/Endpoints/BootstrapEndpoints.cs:65]
---

## What the code does now
- `new EmojiPackDto(p.Key, p.DisplayName, p.Emojis.Select(e => new PackEmojiDto(e.Shortcode, e.Url, e.Keywords)).ToList())` (`EmojiImages.cs:36`), sent as `EmojiImages` in the bootstrap when the stamp differs (`BootstrapEndpoints.cs:65`).
- `Keywords = string.IsNullOrEmpty(kw) ? shortcode : $"{shortcode} {kw}"` (`CustomEmojiService.cs:188`); `wwwroot/emoji-packs/wechat/keywords.json` is 11,136 bytes.
- The class comment says the rules travel in the bootstrap because rows need them before the first paint (`EmojiImages.cs:6-19`). Rows need shortcode and URL; only the picker search needs keywords.

## Why it costs the user time
On a first load on a device (no stored bootstrap), `main.js` awaits the bootstrap before it paints (performance-notes, step 5), so every byte of it is on the critical path once.

## The change
Drop `Keywords` from `PackEmojiDto` in the rules and serve them with the picker: built-in packs can go into the static picker module the way the Unicode list does (`js/data/emoji-list.js`), and server custom packs through a small `GET /api/emoji/keywords?stamp=` fetched when the picker first opens (cache-first in the worker). Keep the stamp covering both.

## Risks and what could break
The picker must work offline (memory: static-asset-caching); a fetched keywords document must be cached by the worker, or the picker searches by shortcode only when offline.

## How to measure it
Bootstrap transferSize on a first load with no stored copy, and the `bootstrap` phase of AD-41 for first loads.
