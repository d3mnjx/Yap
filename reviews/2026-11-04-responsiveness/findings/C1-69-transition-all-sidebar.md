---
id: C1-69
title: Name the transitioned properties instead of `transition: all` in the sidebar rows
category: 1
journey: all
effort: S
confidence: medium
behaviour-change: none
estimated-gain: "Small: on a theme or Tea House scene change, and on media-query flips, the sidebar rows start transitions only for the colours they are meant to fade."
experiment: none
sources: [client-static-20]
files: [Yap/wwwroot/css/frame.css:480-489, Yap/wwwroot/css/frame.css:520-532, Yap/wwwroot/css/frame.css:563-572, Yap/wwwroot/css/pages.css:2132-2144]
---

## What the code does now
`transition: all 0.15s` on `.room-item` (`frame.css:488`), `.room-settings` (`:529`), `.user-item` (`:571`) and `.reorder-btn` (`pages.css:2143`). The hover rules of these elements change only `background`, `color` and `opacity`.

## Why it costs the user time
With `all`, every animatable property that changes on these elements starts a transition: on a theme switch or a Tea House scene change (custom properties on the root re-style everything), on a window resize across a media query, on a font-size change. The people list is windowed, so the count of rows is bounded; the cost is small but it is pure waste, and `all` also animates layout properties if a later rule ever changes one.

## The change
- `.room-item`, `.user-item`: `transition: background-color 0.15s, color 0.15s;`
- `.room-settings`: `transition: opacity 0.15s, background-color 0.15s, color 0.15s;`
- `.reorder-btn`: `transition: background-color 0.15s, color 0.15s, border-color 0.15s;`

## Risks and what could break
A property that today fades by accident (none found) would change at once.

## How to measure it
Not worth a measurement alone; a Performance trace of a theme switch shows the started transitions.