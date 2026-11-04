---
id: C3-19
title: Measure the blur over the animated GIF tiles of the GIF picker; show a still picture if it is costly
category: 3
journey: picker-gif
effort: S
confidence: low
behaviour-change: if the still variant is chosen, the folder tiles stop animating under the blur
estimated-gain: "Unknown, needs measurement on a phone: each folder tile re-applies blur(4px) and brightness to every new frame of its animated GIF while the picker is open."
experiment: none
sources: [client-static-21]
files: [Yap/wwwroot/css/pickers.css:625-673, Yap/wwwroot/js/ui/gif-picker.js:156-163, Yap/wwwroot/js/ui/gif-picker.js:256-258]
---

## What the code does now
- `pickers.css:645-654`: `.gif-folder-tile img { ... transform: scale(1.15); filter: blur(4px) brightness(0.55); }`, and on hover `brightness(0.7)` (`:671-673`).
- `gif-picker.js:158-162`: each tile's `<img>` gets `sample.preview`, a library GIF (an animated image), "a random member GIF animating under a blur" (`pickers.css:625-626`).
- The tiles are Favorites, Server, Browse and the person's folders: a few to about ten on screen.

## Why it costs the user time
A CSS blur over an animated image must be applied again for each new frame of the animation. With several tiles animating at 10 to 30 frames per second, the picker keeps the raster or GPU busy while the person scrolls the grid of cards next to it, which also autoplays videos and animated images. On a slow phone this can drop frames in the picker. The size is unknown.

## The change
First measure. If the tiles cost frames:
- Show a still picture under the blur: the first frame (a poster the server already makes for library GIFs, if one exists) or a static thumbnail URL.
- Or keep the animation and drop the blur, keeping `brightness` (a cheaper filter), as a smaller visual change.

## Risks and what could break
Visual: the "Discord-style" animated tile is a design choice of the user.

## How to measure it
Phone, GIF picker open on the Favorites tab: Performance trace while idle and while scrolling; raster and GPU time per frame, dropped frames, with and without the `filter` rule (DevTools can toggle it).