---
id: C1-64
title: Give the regular font preload a low fetch priority
category: 1
journey: cold-open
effort: S
confidence: low
behaviour-change: none expected; on a first visit the font can finish later, but the October cold measurement painted at 13 to 18 s, long after a 352 KB font
estimated-gain: "Up to about 2.8 s of link time (352,240 B at 1 Mbit/s) moved behind the CSS, the modules and the bootstrap on a first visit, if the path honours priority. Chrome over HTTP/1.1 holds low-priority requests back; Cloudflare applies HTTP/2 priority; Kestrel and Caddy behaviour is unknown. Warm loads: no change (the worker answers the font)."
experiment: none
sources: [client-static-01]
files: [Yap/wwwroot/index.html:104-105, Yap/wwwroot/app.css:6-12, Yap/Program.cs:370-371, Yap/Endpoints/ShellAssets.cs:29]
---

## What the code does now
- `index.html:105`: `<link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin />`. No `fetchpriority`.
- The file is 352,240 B. The cold load of 2026-10-22 moved 803 KB in all (performance-notes.md, Measurements), so the font is about 44 % of a first visit's bytes.
- `app.css:10`: `font-display: swap`. Text never waits for the font; it paints in Helvetica/Arial and swaps.
- Chrome gives a font preload a high priority, in the same band as the 42 `modulepreload` links, one step below the stylesheets.
- `main.js` is a deferred module. By the HTML spec it runs only when the parser is done and no script-blocking stylesheet is pending. The two classic scripts at `index.html:1330-1331` block the parser until all nine stylesheets are in. So the first bootstrap fetch of a first visit waits for every stylesheet and both classic scripts.

## Why it costs the user time
On the far link the font shares 1 Mbit/s with the CSS (78.8 KB gzip level 1 over nine files), the modules and the classic scripts. Every kilobyte the font takes before them delays the `scripts` phase by about 8 ms. Nothing on screen needs the font before `main.js` has run: the body holds only templates and a spinner. Who pays: every first visit, far users most.

## The change
`index.html:105`: add `fetchpriority="low"`:
```html
<link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin fetchpriority="low" />
```
Keep the preload: on a warm load the worker answers it in milliseconds, before the first text paints, so no swap shows. Optionally move the line below `{{modulepreload}}` so it is also the last request the preload scanner issues.

## Risks and what could break
- If the font arrives after the first text paint of a cold load, the text swaps once (a layout shift). The cold paint was at 13 to 18 s in the measurement; the font alone needs about 3 s.
- A server that ignores priorities: no effect, no harm.
- `fetchpriority` is ignored by browsers without support (Safari before 17.2, as far as I know).

## How to measure it
`npm run load`, load 1 (cold): compare `scripts` and `bootstrap` with and without the attribute. Run it once over HTTP/1.1 (the script's default) and once behind Caddy with HTTP/2. In production, the boot report rows with `cached` near 0 (first visits) show the `scripts` phase.