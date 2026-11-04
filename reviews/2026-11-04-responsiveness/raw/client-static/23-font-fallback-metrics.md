---
id: client-static-23
title: Add a metric-matched fallback face, so the swap to Inter moves no text
area: client-static
journey: cold-open
category-guess: 1
behaviour-change: none, except that the fallback text before the swap takes Inter's widths and line heights
effort: S
estimated-gain: "Unknown, needs measurement: removes the layout shift of every row when Inter arrives after the first text paint (first visits; possibly the installed app's cold launch on iOS while the worker starts)."
confidence: low
files: [Yap/wwwroot/app.css:6-20, Yap/wwwroot/app.css:213-216]
---

## What the code does now
- `app.css:10,18`: both faces use `font-display: swap`; `app.css:216`: `font-family: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;`.
- When text paints before the font is ready, it paints in Helvetica or Arial, then re-lays out in Inter. Inter is wider than Arial at the same size, so line breaks and row heights change. In the timeline that moves rows and the scroll position.
- Whether this happens after the first paint on the target devices is unknown: the preload starts the font at the head, and on warm loads the worker answers it, but the installed app on iOS starts its worker cold.

## Why it costs the user time
A late swap is a visible jump of the whole conversation, and the follow-to-bottom logic has to correct the scroll. Who pays: first visits; possibly phones at a cold app launch.

## The change
Before the two `@font-face` rules in `app.css`:
```css
@font-face {
    font-family: "Inter Fallback";
    src: local("Arial"), local("Helvetica");
    size-adjust: 107%;   /* tune against Inter, see below */
    ascent-override: 90%;
    descent-override: 22%;
    line-gap-override: 0%;
}
```
and `font-family: "Inter", "Inter Fallback", "Helvetica Neue", Helvetica, Arial, sans-serif;`. The four numbers must be computed from Inter's and Arial's metrics (tools such as the Next.js font metric tables or `fontaine` give them); the values above are placeholders.

## Risks and what could break
- Safari support for the override descriptors is partial (as far as I know `size-adjust` from 17, the ascent and descent overrides later or not at all); unsupported descriptors are ignored, no harm.
- Wrong numbers make the fallback look odd for the moment it shows.

## How to measure it
First, whether a swap happens after the first paint: the Settings debug card or a `layout-shift` PerformanceObserver at boot on an iPhone (installed app, cold launch) and on a throttled first visit. Only if shifts show, apply and compare the CLS sum.
