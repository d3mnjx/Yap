---
id: C3-20
title: Encode the Tea House strip tiles at WebP quality 85 instead of 95
category: 3
journey: warm-open
effort: S
confidence: medium
behaviour-change: slightly lower image quality in the repeating sky and garden strips (needs an eye check)
estimated-gain: "Measured with libwebp (ffmpeg) from the source JPEGs: midnight headertile 44.2 KB to 10.6 KB and footertile 31.9 KB to 12.7 KB; 4am headertile 54.5 KB to 19.0 KB and footertile 34.9 KB to 15.7 KB. About 40 to 55 KB less per night scene (scenes weigh 60 to 181 KB today). Tea House users only, once per scene per device and again after deploys (client-static-10)."
experiment: none
sources: [client-static-22]
files: [themes/teahouse/build_assets.py:45-51, Yap/wwwroot/images/themes/teahouse/, Yap/wwwroot/themes/teahouse.css:11-463]
---

## What the code does now
- `build_assets.py:45-51` encodes `headertile_bg` and `footertile_bg_rside` at lossy quality 95, `header_bg` and `footer_bg_rside` at 88, `canvastile_bg` lossless.
- Its docstring records why 95: the worry was block error at the tiling edges; the measurement there found the edges no worse than the interior (1.43 vs 1.21 mean error at q95). Quality 85 was not tried.
- Scene totals on disk (bytes): midnight 154,640; 2am 150,584; 314am 127,910; 4am 181,294; 6am 123,712; 8am 99,226; 10am 95,574; noon 93,592; 2pm 60,294; 4pm 94,476; 6pm 119,434; 8pm 109,512; 10pm 98,936.
- The scene images are CSS backgrounds of `.theme-scene` (`frame.css:791-821`), fetched when the frame mounts, not precached (`ShellAssets.cs:27-28`).

## Why it costs the user time
A Tea House user's first open of a scene downloads 100 to 180 KB of artwork next to the rows, avatars and emoji. The frame shows the plain canvas colour until it arrives. At 1 Mbit/s 50 KB is about 400 ms. Who pays: Tea House users, at each new scene and after deploys.

## The change
`build_assets.py:47-48`: quality 85 for the two tile layers; run the script; check the scenes in `themes/teahouse/preview.html` at the sizes the app shows (`--scene-sizes`). Keep the footer at 88 or try 85 there too (midnight footer: 71.9 KB shipped, 54.6 KB at 85).

## Risks and what could break
Visible artefacts in flat sky gradients. The source JPEGs are already lossy, so the eye check decides.

## How to measure it
Resource timing of the scene images on a throttled first open per scene; the time from frame mount to the scene paint.