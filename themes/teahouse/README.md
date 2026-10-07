# Gmail "Tea House" theme - extraction

This package contains the complete Gmail Tea House theme, extracted from the
live Google CDN on 2026-08-25. The images are byte-identical to the copy
mirrored in https://github.com/UndarkAido/TeaHouse (2022), so the theme has
not changed since at least April 2022. It has been a Gmail theme since at
least 2011 and an iGoogle theme before that (2009 sources).

## What the theme is

A tea house garden scene with a fox character. The scene changes with the
local time of day: the fox sweeps, gardens, drinks tea with a monkey, grills,
writes calligraphy, sleeps, and so on. The sun or moon tracks across the sky.
At 3:14 am (pi) a special easter-egg scene shows a Taoist priest fox leading
jiangshi (hopping corpses) past the house.

The artwork is by the artist group **Meomi** (www.meomi.com, Vicki
"@meomiCloud"). Meomi confirmed the credit in a 2015 tweet. The characters
also appeared in a Google Hangouts "Happy New Year" animation.

## Sources

- Live CDN (used to fill `images/`):
  `https://ssl.gstatic.com/ui/v1/icons/mail/themes/teahouse/<version>/<file>.jpg`
- Original iGoogle URL (historical):
  `http://www.google.com/ig/images/skins/teahouse/<version>/<file>`
- GitHub mirrors and derivative projects:
  - https://github.com/UndarkAido/TeaHouse - full image set + viewer
  - https://github.com/cybojanek/tea_house - download + compose scripts
  - https://github.com/JoshuaD84/teahouse-fox-background - GNOME switcher,
    13 pre-composited 900x250 scenes (source of `composited/`)
  - https://github.com/johnou/google-teahouse-fox - Chrome extension that
    puts the scenes on the Google homepage

## Layout

- `images/<version>/<file>.jpg` - the 55 original theme layers across 13
  versions: midnight, 2am, 314am, 4am, 6am, 8am, 10am, noon, 2pm, 4pm, 6pm,
  8pm, 10pm (not every version has every file - see sharing rules below)
- `composited/*.jpg` - 13 pre-composited 900x250 scenes (00 = midnight,
  0314 = the pi easter egg)
- `preview.html` - showcase page: real 5-layer background, -/+ buttons to
  step prev/next scene with crossfade, per-layer color swatches for the
  current scene, scene notes (open in a browser, starts at local time)
- `viewer/index.html` - time-based viewer (open in a browser; arrow keys step
  the clock, up/down toggles the house)
- `compose.py` - composes a full-size background at any resolution
- `palette.json` - dominant colors per version and layer

Yap pipeline (run from this folder, in this order, after any change to the
layers or the palette):

- `build_assets.py` - converts the JPEG layers to WebP and writes them to
  `Yap/wwwroot/images/themes/teahouse/<scene>/<layer>.webp`
- `gen_theme_css.py` - derives the theme CSS from `palette.json` and writes
  `Yap/wwwroot/themes/teahouse.css`. The CSS is generated, do not hand-edit it.
  The design behind the generator is in `docs/themes-2.0.md`.

## How Gmail assembles a version

Each version is built from up to 5 layers (all JPEG):

| file                 | size (typical) | placement                          |
|----------------------|----------------|------------------------------------|
| `headertile_bg`      | 20-480 x 450-540 | tiled across the top, repeat-x   |
| `canvastile_bg`      | 50-200 square  | tiled in the area between the strips |
| `footertile_bg_rside`| 300 x 399-549  | tiled along the bottom, repeat-x   |
| `header_bg`          | 120-240 x 90-120 | one-off, top-left (moon, lantern) |
| `footer_bg_rside`    | ~1020 x 399    | the teahouse, anchored bottom-right |

Sharing rules (from the theme's own viewer script):

- 10am and 2pm have no canvas/header/footertile of their own. They reuse
  the 8am and noon environment layers respectively. Only `footer_bg_rside`
  (and the 10am footertile) are unique to them.
- 6am, 6pm and 8pm have no `header_bg`.
- Hour-to-version map: 0-1 -> midnight, 2 -> 2am, 3 -> 314am, 4-5 -> 4am,
  6-7 -> 6am, 8-9 -> 8am, 10-11 -> 10am, 12-13 -> noon, 14-15 -> 2pm,
  16-17 -> 4pm, 18-19 -> 6pm, 20-21 -> 8pm, 22-23 -> 10pm.

Gmail renders this resolution-independently by tiling, so the small source
images scale to any screen. `compose.py` reproduces the layout at any size:

```
python3 compose.py out.jpg 1920 1080 noon     # one scene
python3 compose.py out.jpg 1920 1080          # current time
pip install pillow                            # one-time dependency
```

## Colors

The base canvas color is `#334029` (dark green) per the theme viewer.
`palette.json` lists the top dominant colors per layer. The day arc runs
from near-black `#202020` (night) through warm `#c0a080`/`#e0e060`
(sunrise to noon) to orange `#e0a060` (dusk) and back to dark blues
`#202040`/`#402040` (late night).

## Scene list (from the 2011 descriptions)

| version  | scene |
|----------|-------|
| midnight | fox sleeps in the teahouse; ghost foxes play Chinese checkers |
| 2am      | (night) |
| 314am    | easter egg: Taoist priest fox with bell leads jiangshi past the house |
| 4am      | fox walks out with two rabbits (tai chi) |
| 6am      | fox cuts flowers, sets them on the stone table |
| 8am      | fox fills the birdbath from a hose |
| 10am     | fox sweeps inside the teahouse; lunch on the stone table |
| noon     | (daytime) |
| 2pm      | fox trims a bonsai on the stone table |
| 4pm      | fox has tea with a monkey in the upper teahouse |
| 6pm      | fox plays flute for the ducks |
| 8pm      | fox grills dinner on a hibachi; lanterns light up; fireflies |
| 10pm     | fox works on calligraphy |

(The 2011 post describes the then-current scenes; some hours in the file set
may map slightly differently - the `composited/` images show the actual
current scenes.)

## Notes for reuse

- Keep credit for Meomi with the artwork.
- The images are public theme assets, freely hosted by Google.
- To swap the theme into a custom Gmail-like UI: replicate the 5-layer
  tiling above and switch versions on local time.
