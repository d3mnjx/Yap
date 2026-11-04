---
id: C1-33
title: Start the picker's preview videos only when their card scrolls into view
category: 1
journey: picker-gif
effort: S
confidence: medium
behaviour-change: none
estimated-gain: The grid creates 30 autoplaying videos at once, and a phone shows about 6 to 9 cards. Unknown sizes (Klipy's `sm` mp4); at an assumed 50 KB each that is 1.5 MB, about 12 s at 1 Mbit/s, shared by every card. With lazy start, the visible cards get the whole link: about 3 times sooner for the first screen, and less decode work on the phone.
experiment: none
sources: [backend-media-22, client-render-22]
files: [Yap/wwwroot/js/ui/gif-picker.js:205, Yap/wwwroot/js/ui/gif-picker.js:236-264]
---

## What the code does now
- Provider cards use a video preview when the preview tier has one: `const video = formats.find(f => /^video\//i.test(f.contentType ?? '') || ...)` (gif-picker.js:251).
- `el('video', { src: url, autoplay: true, muted: true, loop: true, playsinline: true, preload: 'metadata', class: 'gif-card-video' })` (line 258). With `autoplay`, the browser ignores `preload: 'metadata'` and fetches and plays each video.
- Library cards use `<img loading="lazy">` (line 257); videos have no lazy loading.
- A page has 30 cards (`ProviderPage = 30`, GifEndpoints.cs:15); "Load more" adds 30 more at a time.

## Why it costs the user time
All 30 downloads and 30 decoders start when the grid renders. On a slow link the cards in view share the bandwidth with the 20 or more below the fold, so the first screen fills slowly. On a phone, 30 concurrent video decoders also cost CPU and memory while the user tries to scroll. Every user who opens Browse or searches pays; the far user and old phones most.

## The change
In `preview(url, isImage, alt)`, for videos: create the element without `src` (`data-src` instead) and one shared `IntersectionObserver` (root: the results container, `rootMargin: '200px'`) that sets `src` and calls `play()` when the card comes near the view, and pauses it when it leaves. About 15 lines. PK-19 ("a small, muted preview that loops") still holds for every card the user sees.

## Risks and what could break
- A fast scroll shows empty cards for a moment until their video arrives; the aspect-ratio box (line 239) keeps the layout stable.
- The existing rule "when a preview cannot start, it starts on the next tap" must cover lazily started videos too (check where it lives).
This is client code; noted for the client reader.

## How to measure it
Journey "picker-gif" on a throttled link: count requests and bytes in the first 5 s after opening Browse, and the time until the first row of cards plays.

## Also found by

The same finding, from another reader's angle: `raw/client-render/22-gif-grid-previews-near-view.md`. The raw files hold their reasoning and numbers.
