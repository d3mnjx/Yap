# Themes 2.0 — Design & Record

**Status: shipped 2026-08-25.** Every piece below is live: the canvas layer, Tea House, room vs DM,
time of day, the pattern layer, Terminal and Neon Glow, the relaxed status rule and the glow axis.
`solarized-light` joined the lineup on 2026-08-27. The doc was written as a plan before any code
existed and is kept as the record of why the system is shaped the way it is. Where a section says
"we would" or "today", read it as of August 2026; the **DONE** markers and the dated notes say what
actually happened. Code comments in `wwwroot/chat-client/shared.css`, `app.css` and
`themes/teahouse/gen_theme_css.py` point here. Audience: future maintainers (you and Claude).

**Still open:** the Meomi credit in Settings (see Decisions) is not done. Only a comment in
`teahouse.css` carries it.

## Current implementation

Browser chat uses the concern stylesheets listed in [CSS ownership](../css_architecture.md); retained Blazor pages share `chat-client/shared.css`. `js/appearance.js` owns scene selection, appearance restoration and browser theme-color for both shells. The static shell inventory is computed at startup; changing branded/theme assets requires a restart and complete compressed assets. The sections below retain the original design reasoning; removed scoped chat files are now represented by the shared stylesheet.

## Overview

Today a theme is *a bag of CSS variables*. Themes 2.0 keeps that — and adds **one painted layer
behind everything**, driven by three independent HTML attributes that compose in CSS:

| Attribute | Values | Set by | Themes that ignore it |
|---|---|---|---|
| `data-theme` | `teahouse`, `cypherpunk`, … | server-rendered in `App.razor` (already exists) | — |
| `data-context` | `room` \| `dm` | Blazor, on `.chat-container` | cost nothing |
| `data-scene` | 13 values: `midnight` … `noon` … `10pm` (+ `314am`) | inline `<head>` script, from the **browser clock** | cost nothing |

Five pieces, in the order we'd ship them:

1. **The canvas layer** — the structural change everything else needs.
2. **Teahouse** — first image theme. **Assets are in hand** (`themes/teahouse/`: 13 scenes × 5
   layers, palette, and a working reference implementation).
3. **Room vs DM** — generalizes the header-line swap we already ship.
4. **Time of day** — the Gmail-dynamic-theme trick.
5. **Cypherpunk** — terminal / crypto-anarchy.
6. **Cyberpunk** — neon noir, with glow. (Yes, both. They are different aesthetics, not a typo.)

Themes 2.0 also **relaxes one standing rule**: themes may now override status colours, and gain a
glow axis. See [Status colours: rule relaxed](#status-colours-rule-relaxed).

Patterns (piece 4.5) turned out to belong with 3, not with 1 — see [Seamless patterns](#piece-45--seamless-patterns).

---

## Where themes were before 2.0 (August 2026 baseline)

The system was small and good, and 2.0 did not damage it. Numbers below are from before the
work; as of 2026-10 `ThemeRegistry` has 11 themes (`discord-dark`, `midnight`, `nord`, `ocean`,
`sunset`, `aurora`, `terminal`, `neon-glow`, `teahouse`, `daylight`, `solarized-light`),
`themes.css` is 464 lines, and appearance state and scene selection live in `wwwroot/js/appearance.js`.

- `Services/ThemeRegistry.cs` — 7 `ThemeDefinition` records: `Id`, `Name`, `PreviewBg`,
  `PreviewAccent`, `HasGradient`. Metadata only; **no colors live in C#**.
- `wwwroot/themes.css` (198 lines) — one `[data-theme="x"]` block per theme, each overriding ~22
  variables from `:root` in `app.css`. Default `discord-dark` has *no* block and falls through.
- `Components/App.razor:5` — `data-theme` is **server-rendered** onto `<html>`, deliberately, for
  zero flash on load.
- `wwwroot/js/chat.js` — `applyTheme(id)` sets `documentElement.dataset.theme` for live
  switching in Settings.
- **Status colours were deliberately never overridden** (green = online, red = danger) — a rule
  written at the top of themes.css. **Themes 2.0 relaxes this**; the replacement convention and the
  one case that stays dangerous are in [Status colours: rule relaxed](#status-colours-rule-relaxed).

**Prior art already in the repo:** `Components/Layout/ChatLayout.razor` (the header `<img>`) swaps
`purpleline01_3px.png` ⇄ `turqline01_3px.png` under the header based on
`NavState.CurrentDmUser != null`. Room-vs-DM differentiation is not a new idea here — it is a
3-pixel-tall version of it that already works. Piece 3 generalizes it.

---

## The structural change: a canvas layer

### Why `--bg-primary` can't just hold the image

It looks like it could: `--bg-primary` already accepts a full CSS `background` value — `ocean` and
`sunset` put `linear-gradient(...)` in it today. But that variable is doing **two different jobs**:

1. the **page canvas** — `.chat-container`, `.messages-container` (`wwwroot/chat-client/shared.css`)
2. an **opaque fill for small elements** — message hover states (`Yap/wwwroot/chat-client/messages.css`),
   the input box (`Yap/wwwroot/chat-client/composer.css`), the scrollbar thumb border
   (`Yap/Components/Layout/ChatLayout.razor.css`), an Admin panel surface.

Job 2 restarts the background inside every small element. With a gradient nobody notices. With
`url(teahouse.webp)` you get a tea house tiled inside every message hover rectangle. It is not a
tuning problem, it's the wrong slot.

### The split

- `--bg-primary` **stays a solid color** — the opaque fill (job 2), and the fallback painted while
  the image loads. Every existing theme is unchanged.
- New variables, consumed by **exactly one element**:

```css
:root {
    --canvas-image: none;      /* url(...) or a pattern; none = today's behaviour */
    --canvas-scrim: none;      /* gradient/flat wash between image and content */
    --canvas-position: center; /* per-theme art direction */
}
```

### The layer stack

The Teahouse assets (Piece 2) settled the shape of this: **five stacked layers**, not one image,
because that is how the source theme is authored and it is why it scales to any screen with no
per-resolution art.

```
  ┌─ .chat-container ──────────────────────────────┐
  │  background: var(--bg-primary)   ← solid, always painted (fallback)
  │
  │  .theme-scene  position: fixed; inset: 0; z-index: 0
  │    ├─ .layer.canvastile   repeat                    ← flat colour field
  │    ├─ .layer.headertile   repeat-x, top
  │    ├─ .layer.header       no-repeat, left top       (may be absent)
  │    ├─ .layer.footertile   repeat-x, right bottom
  │    └─ .layer.footer       no-repeat, right bottom   ← the teahouse
  │
  │  .theme-scrim  position: fixed; inset: 0; z-index: 1
  │            background: var(--canvas-scrim)
  │
  │  header / sidebar / messages   z-index: 2 …          ← unchanged
  └────────────────────────────────────────────────┘
```

```css
:root {
    --scene-canvastile: none;  --scene-headertile: none;  --scene-header: none;
    --scene-footertile: none;  --scene-footer: none;
    --canvas-scrim: none;
}
```

**`position: fixed`, not `background-attachment: fixed`.** The latter is expensive on every scroll
and unreliable on iOS Safari. Fixed layers composite once and never repaint while messages scroll.

**Crossfade** = two `.theme-scene` divs, the outgoing one transitioning `opacity` to 0 — exactly
what `themes/teahouse/preview.html` already does (`.version { transition: opacity 1s }`). The
technique is proven against these assets, not theorised.

## Piece 2 — Teahouse: what the assets changed

`themes/teahouse/` (deliberately outside `Yap/Yap/` — note the on-disk name is lowercase `themes/`, which is what git records — a standalone resource, not app code) holds the
complete extracted Gmail theme: **13 time-of-day scenes × up to 5 JPEG layers**, a `palette.json` of
dominant colours per layer, `compose.py`, and a working `preview.html` / `viewer/`. Artwork by
**Meomi**; the README asks the credit travel with it, so it should appear somewhere in Settings.

Three findings from measuring the pack. Each **replaces** an assumption in the earlier draft.

### Finding 1 — it is natively tiled, so we need no art pipeline at all

| layer | size | placement |
|---|---|---|
| `headertile_bg` | 20–395 × 450–540 | tiled across the top, `repeat-x` |
| `canvastile_bg` | 50–200 square | tiled in the band between the strips |
| `footertile_bg_rside` | 300 × 399–549 | tiled along the bottom, `repeat-x` |
| `header_bg` | 120–240 × 90–120 | one-off, top-left (moon, lantern) |
| `footer_bg_rside` | **1020 × 399** | the teahouse itself, anchored bottom-right |

That is how Gmail rendered it resolution-independently. **We no longer need a cover image, a mobile
portrait crop, or `compose.py` at runtime** — it is five CSS background layers on one element, and
`preview.html` is a working reference implementation of precisely that.

`compose.py` stays useful for one thing: flat preview thumbnails for the theme picker.

### Finding 2 — the message area sits on flat colour, so legibility is free

The most useful measurement in the pack. `canvastile_bg` is **a solid colour in every scene**:

| scene | canvas | | scene | canvas |
|---|---|---|---|---|
| midnight | `#404040` 100% | | noon | `#e0e0a0` 100% |
| 2am | `#202020` 100% | | 2pm | *(reuses noon)* |
| 314am | `#202020` 100% | | 4pm | `#a0c0c0` 100% |
| 4am | `#202020` 98% | | 6pm | `#e0c060` 53% |
| 6am | `#c0a080` 100% | | 8pm | `#606080` 94% |
| 8am | `#c0c080` 99% | | 10pm | `#202020` 100% |
| 10am | *(reuses 8am)* | | | |

The scenery lives **entirely in the top and bottom strips**. The band between them — exactly where
Yap's messages go — is flat. So "image is the frame, not the reading surface" is not something we
have to impose with a heavy scrim; **the artwork is already built that way.** The scrim can be
near-zero or drop out entirely.

It also means the hourly canvas colour *is* the theme's background colour: `palette.json` drives the
CSS variables honestly instead of being eyeballed.

Bonus geometry: `footer_bg_rside` anchors **bottom-right**, and Yap's sidebar is on the right — the
teahouse naturally sits behind chrome, not behind reading surface.

**Correction, from seeing it render:** that is a liability, not a bonus. The sidebar is opaque, so on
desktop it hides the teahouse *entirely* — the theme's centrepiece, gone precisely where the screen
is widest. On mobile, where the sidebar is collapsed, the building dominates the view and looks
great. **Step 3 must give the sidebar a translucent panel treatment**, or Teahouse is a garden with
no tea house on every desktop.

### Finding 3 — the layers are opaque JPEGs, so nothing can be tinted per-layer

JPEG has no alpha. The scene works because each layer is a **fully opaque rectangle painted in
z-order**, with the art drawn so the seams align (`compose.py` pastes them exactly this way). Two
hard limits follow:

- We cannot recolour, tint, or fade an individual layer. Any wash goes over the **whole composite**
  via `--canvas-scrim`.
- CSS layer order must match `compose.py`'s paste order, or the teahouse ends up behind the sky.

### The one real design decision: Teahouse is not a dark theme

Read the canvas arc again — `#e0e0a0` at noon is **pale yellow**, `#202020` at 2am is near-black.
The source theme is *light by day and dark by night*. Every current Yap theme is fixed dark (except
`light`), so text and chrome have to flip lightness somewhere around dawn and dusk.

Three ways to handle it. **This is the question that blocks generating the CSS:**

- **(A) Faithful.** Light UI 6am–6pm, dark UI 8pm–4am, text colours derived from canvas luminance.
  Truest to the theme and arguably the whole point of it. Risk: the UI inverts under you
  mid-conversation at dawn and dusk.
- **(B) Always-dark chrome.** Keep Yap's dark panels; the hourly colour shows only at the frame and
  as an accent tint. Safe and consistent, but throws away most of the charm — noon looks like every
  other theme.
- **(C) Dark chrome, translucent panels.** Dark message/sidebar panels at ~85% opacity over the
  scene, so the hourly colour tints through without ever inverting text.

**DECIDED: (A), faithful.** The day arc is the theme; muting it would be building something else.

Computed relative luminance of each scene's canvas colour gives a clean, natural split at a `0.35`
threshold — **exactly two flips a day**, at the hours you would choose by hand:

| scene | hours | canvas | luminance | H / S / L | mode |
|---|---|---|---|---|---|
| midnight | 0–1 | `#404040` | 0.051 | 0° 0% 25% | dark |
| 2am | 2 | `#202020` | 0.014 | 0° 0% 13% | dark |
| 314am | 3 | `#202020` | 0.014 | 0° 0% 13% | dark |
| 4am | 4–5 | `#202020` | 0.014 | 0° 0% 13% | dark |
| **6am** | 6–7 | `#c0a080` | **0.379** | 30° 34% 63% | **LIGHT** ← flip |
| 8am | 8–9 | `#c0c080` | 0.505 | 60° 34% 63% | LIGHT |
| 10am | 10–11 | `#c0c080` | 0.505 | 60° 34% 63% | LIGHT |
| noon | 12–13 | `#e0e0a0` | 0.717 | 60° 51% 75% | LIGHT |
| 2pm | 14–15 | `#e0e0a0` | 0.717 | 60° 51% 75% | LIGHT |
| 4pm | 16–17 | `#a0c0c0` | 0.490 | 180° 20% 69% | LIGHT |
| 6pm | 18–19 | `#e0c060` | 0.544 | 45° 67% 63% | LIGHT |
| **8pm** | 20–21 | `#606080` | 0.124 | 240° 14% 44% | **dark** ← flip |
| 10pm | 22–23 | `#202020` | 0.014 | 0° 0% 13% | dark |

Note the hue arc the theme walks: warm tan 30° at dawn → yellow 60° at midday → cool cyan 180° in
the afternoon → gold 45° at sunset → blue 240° at dusk → neutral at night. That arc is what the
generator should carry into the accent and panel colours.

**6am is the marginal case** (0.379 against a 0.35 threshold). If light-at-6am reads wrong on a real
screen, move the flip to 8am — it is one constant.

### Generating the CSS

13 scenes × ~22 variables is not hand-written. A generator in `themes/teahouse/` reads
`palette.json`, applies the luminance rule from whichever option above we pick, and emits a
**generated CSS file** (linked after `themes.css`, marked `GENERATED — do not edit`). `themes.css`
stays hand-written for the other themes.

### Shipping weight and edge cases

**Measured after step 1** (the estimate below it was "WebP should take that to roughly a third" —
it did better):

- The full set converts from **5937 KB of JPEG to 1473 KB of WebP, a 75% saving**, 55 files.
- Per scene, one scene at a time: **58–177 KB**, typical ~100 KB. That is a smaller first paint than
  most single hero images, and it removes weight as an argument against the theme.
- Crossfade needs the *next* scene loaded, so preload it shortly before the switch.
- **Absent layers must be handled:** 6am/6pm/8pm have no `header_bg`; 10am and 2pm have no
  environment layers at all and reuse 8am's and noon's.
- **Vertical fit: confirmed a real defect, and the fix is validated.** Injecting the real assets at
  runtime showed a hard horizontal seam at 1440×900 *and* at 390×800 — at noon the strips are
  450 + 549 = 999px against a 900px viewport, so the footer strip paints over the header strip and
  two different phases of the same sky meet in a visible line. Not a phone-only problem as assumed;
  it hits ordinary desktops.

  **Fix, tested and working:** one *uniform* scale factor applied to all layers,
  `S = min(1, viewportH / (headertileH + footertileH))`, via
  `background-size: auto calc(<native-height> * S)`. At 1440×900 that is S=0.901, at 390×800
  S=0.801, and the seam disappears in both. The factor must be **the same for every layer** or the
  teahouse stops meeting the garden's ground line, which means the generator has to emit each
  scene's native layer heights alongside its URLs.
- **The 3:14 am easter egg** (Taoist fox leading jiangshi) is mapped to the whole 3am hour by the
  theme's own hour map. Keep it. It is the kind of detail that makes people like software.

## Piece 3 — Room vs DM — **DONE**

Make this **orthogonal to the theme**, not a Teahouse feature. Every theme should be able to opt
into a shift; Teahouse just opts in harder (a different image).

```razor
<div class="chat-container" data-context="@(NavState.CurrentDmUser != null ? "dm" : "room")">
```

```css
/* generic: any theme can add a one-line shift */
.chat-container[data-context="dm"] { --canvas-pattern-opacity: 0.05; }

/* teahouse: same scene, denser pattern + warmer wash */
[data-theme="teahouse"] .chat-container[data-context="dm"] { --canvas-pattern: var(--pattern-asanoha); }
```

**Blazor owns this attribute outright** — no JS touches it, so the CLAUDE.md rule about
interpolated attributes clobbering JS-set classes does not apply here. Navigation already costs an
honest round trip, and `NavState.CurrentDmUser` is the same source of truth the header line reads,
so the two differentiators can never disagree.

**Constraint:** the context shift may move canvas, pattern, and accent *tint* — and nothing else.
Note this is stricter than the per-theme rule below: a **theme** may now redefine what green means,
but a **context** may not, because context changes several times a minute while you use the app. A
user must never learn "green means online, except in DMs."

**Correction from the assets:** the earlier "rooms = garden, DMs = tea room interior" idea is
**dead** — there is no interior artwork in the pack, and scenes are indexed by hour, not by context.
The scene belongs to the clock; the context gets the pattern and a scrim tint.

**Risk to watch:** too much variation is disorienting rather than orienting. The header line
already carries some of this signal. The test is whether you can tell where you are from the
corner of your eye — not whether the two look obviously different side by side.

---

## Piece 4 — Time of day

Third independent attribute, same composition trick:

```css
[data-theme="teahouse"][data-daypart="dusk"] { --canvas-image: url(.../garden-dusk.webp); }
```

Themes that don't set it are unaffected, so this costs the other six themes exactly nothing.

### Where the time comes from: the browser, not geo

Tempting to use `GeoLocationService` — but it reads **IP2Location LITE DB3**, which carries
country / region / city and **no latitude, longitude, or timezone** (`GeoInfo` has
`CountryCode`, `Country`, `Region`, `City`). Real sunrise/sunset would need DB5+ or an external
API. The browser already knows its exact local time for free. **Use the client clock.** True solar
times are a possible later refinement, not v1.

### The flash problem

`data-theme` is server-rendered specifically to avoid a flash — but the server cannot know the
client's clock on first paint. Options:

- **(recommended)** a small **blocking inline script in `<head>`**, placed right after the
  stylesheet links, that computes the daypart and sets the attribute before first paint.
- persist the user's UTC offset on first visit and render server-side — more machinery, and it
  needs a migration. Rejected for v1.

Re-evaluate on a timer and on `visibilitychange` (a laptop reopened at 9pm must not still say
`day`). Put `transition: opacity .8s` on the canvas layer so the handful of daily swaps fade
rather than snap.

### Later, same mechanism

`data-season` is free once this exists. `data-weather` needs an external API, a key, and an SSRF
policy review, in exchange for "sometimes it rains in my chat" — filed under maybe-never.

---

## Piece 4.5 — Seamless patterns — **DONE**

Researched separately (see [Sources](#sources)). **Conclusion: don't use tiled image files.**

### Why CSS/SVG-mask beats a PNG tile here

| | PNG/WebP tile | CSS gradients / SVG mask |
|---|---|---|
| Size | 50–200 KB | < 1 KB, often inline |
| Retina | needs @2x/@3x | resolution-independent |
| **Picks up the theme's colour** | **no — baked in** | **yes** |
| HTTP requests | one per pattern | zero |

That third row is the whole argument. We have 7+ themes and want a pattern that works in all of
them. A baked tile means N tiles, or one grey tile that looks wrong in half the themes.

### The trick that makes patterns themeable

An SVG data-URI in `background-image` is an opaque document — it **cannot** read our CSS variables.
But used as a **mask**, the colour comes from the element:

```css
.chat-container::before {
    background-color: var(--pattern-color);   /* ← themeable, follows the theme */
    mask-image: var(--canvas-pattern);        /* ← the shape, from a data-URI SVG */
    mask-size: 32px 32px;
}
```

Pure `repeating-linear-gradient` patterns are even simpler — they read CSS variables directly, with
no mask at all — and cover most of what we'd want (hairlines, crosshatch, graph paper, dots).
Reach for the SVG mask only for shapes gradients can't draw (asanoha, hexagons, circuit traces).

Set `--pattern-color` per theme: white at ~3% on dark themes, black at ~3% on the `light` theme.
One variable, correct everywhere.

### Candidates, and which theme each suits

| Pattern | Technique | Fits |
|---|---|---|
| 45° hairlines | `repeating-linear-gradient` | generic DM marker — calmest option |
| Dot / graph grid | `radial-gradient` + `background-size` | generic, technical feel |
| Crosshatch | two `repeating-linear-gradient`s | generic |
| **Asanoha / seigaiha** (Japanese hemp-leaf / wave) | SVG mask | **Teahouse** — period-correct |
| **Circuit traces** | SVG mask | **Cypherpunk** |
| Topographic contours | SVG mask | a future outdoors theme |

This is the nice convergence: **the pattern can be per-theme *and* per-context at once**, which
folds pieces 3, 4 and 4.5 into a single mechanism. Teahouse DMs get faint asanoha; cypherpunk DMs
get faint circuit traces; every other theme gets hairlines at 3%.

### Pitfalls

- **Moiré / shimmer.** 1px hard lines at fractional devicePixelRatios vibrate while scrolling. Keep
  tiles ≥ 24px and alpha low; prefer soft-edged stops over hard ones.
- **Scroll cost.** ~~The pattern belongs on the *fixed* canvas layer~~ — **reversed 2026-08-25
  by an A/B toggle**: the pattern now lives *inside* the scroll content (`.messages-flow::before`)
  and rides with the text, which the user preferred ("the pattern belongs to the conversation").
  The original worry overstated the cost: as part of ordinary scroll content the layer is
  rasterised into composited tiles like the text itself — scrolling does not repaint it per frame.
  What was actually true: never *reposition* a fixed layer from a scroll listener in JS.
- **Unobtrusive means unobtrusive.** If you can read the pattern, it's too strong. Target: you
  notice the room *changed*, not that there are lines on it.
- Pattern and image can coexist (pattern over image, under scrim) but probably shouldn't — pick one
  per theme+context.

---

## Status colours: rule relaxed

The old rule — *themes never override status colours* — is **relaxed as of Themes 2.0**. A theme
may redefine them; it takes on the responsibility of keeping them meaningful. This unblocks the
phosphor-green cypherpunk palette, which otherwise collided head-on with `--status-online`.

### What a theme is signing up for

Worth knowing before overriding, because these variables reach further than the sidebar dot:

| Variable | Default | Where it lands |
|---|---|---|
| `--status-online` | `#3ba55c` | sidebar dots, header status dropdown, profile card, **`ReconnectModal`**, Admin (13 uses) |
| `--status-away` | `#faa61a` | same family, auto-away state |
| `--color-success` | `#3ba55c` | Settings/Login/ChannelSettings confirmations |
| `--color-warning` | `#faa61a` | Admin + gating warnings |
| `--color-danger` | `#ed4245` | destructive buttons — Admin, ChannelSettings, message delete |

Two things fall out of that table:

1. **`--status-online` and `--color-success` are separate variables that merely share a hex.** So is
   `--status-away` / `--color-warning`. That separation is the escape hatch: a theme can neon-ify
   success feedback while keeping the presence dot readable, or the reverse. Use it.
2. There is **no `--status-busy` or `--status-offline`** — offline users fall through to muted greys.
   Nothing to override there today.

### The convention that replaces the rule

Not enforced, just what a good theme does:

- **Keep the hue family.** Online reads green-ish, warning amber-ish, danger red-ish. Shift
  saturation, luminance and glow freely — that's where the theme's personality goes.
- **Presence must stay distinguishable from accent.** The failure mode isn't "wrong green", it's
  online-green and accent-green being the same colour, so the dot stops carrying information.
- **Bright status colours must also flip `--status-chip-text`.** The header status chip paints its
  *background* with the status colour and its text with `--status-chip-text` (default
  `--text-white`) — so a phosphor or neon online-green leaves white text unreadable on the chip.
  Cypherpunk and cyberpunk set it to their `--bg-darkest`, which doubles as ink.
- **`--color-danger` is the one to leave alone-ish.** It guards destructive admin actions. A danger
  button that stops reading as dangerous is a different class of bug from an ugly dot.
- **`ReconnectModal` uses `--status-online`.** Whatever a theme does, "connection restored" must
  still read as good news.

---

## The glow axis

Neon without glow is just bright colour. New variables, defaulting to `none`, so every existing
theme is untouched:

```css
:root {
    --glow-accent: none;
    --glow-status: none;
}
/* cyberpunk */
[data-theme="cyberpunk"] {
    --glow-accent: 0 0 8px hsl(330 100% 59% / 0.55);
    --glow-status: 0 0 6px currentColor;
}
```

Applied as `box-shadow: var(--glow-accent)` on a **small, fixed set** of elements: status dots, the
active-channel indicator, primary accent buttons, the header line, focus rings.

**Not** on message rows, avatars, or anything that repeats per message. A `box-shadow` on every item
in a scrolling list is a repaint on every frame, and it fights the "fingers never wait" doctrine for
zero information gain. `filter: drop-shadow()` is more expensive again — prefer `box-shadow` /
`text-shadow`.

Text glow is the one to be careful with: it reads as premium on a 6-character username and as blurry
on a paragraph. Restrict to headings and short labels, never message body text.

---

## Piece 5 — Cypherpunk — **DONE**

The 90s mailing list, PGP, remailers, *"cypherpunks write code."* Not neon — a terminal. Phosphor on
black, restraint, everything monospace-adjacent. Now that status colours are relaxed, this palette
can lean into green properly.

```
--bg-primary   #07090a   near-black, faint green cast
--bg-sidebar   #0d1211
--bg-input     #151d1a
--text-primary #c8d3cc   soft grey-green — deliberately NOT phosphor; body text
--accent       #33ff66   phosphor green
--status-online #7dffb0  lifted mint — stays distinct from accent green (see convention above)
--color-danger  #ff5f56  terminal red
--glow-accent  0 0 6px hsl(140 100% 60% / 0.35)   restrained; a CRT, not a nightclub
```

The one real risk: high-saturation green text over long messages is tiring, which is why
`--text-primary` is desaturated and the phosphor lives in the accent only.

- **Pattern:** faint scanlines, or a hex-dump / keyblock texture.
- **Image:** PCB macro, a printed PGP key block, terminal glass. Very dark, very low contrast.
- **Rooms vs DMs:** rooms = public channel; DMs = encrypted. An extra-dark canvas plus a denser
  cipher-text pattern would say that without a word of UI.

## Piece 6 — Cyberpunk — **DONE**

Blade Runner, wet streets, signage. Sits naturally beside the existing `sunset` / `aurora` gradient
themes, and is where the glow axis earns its keep.

```
--bg-primary   #0b0714   deep indigo-black
--bg-sidebar   #130c22
--bg-input     #1b1130
--text-primary #e6dcf5
--accent       #ff2e88   neon magenta
--accent-alt   #22d3ee   cyan
--status-online #39ff8b  neon green — no collision, accent is magenta
--glow-accent  0 0 8px hsl(330 100% 59% / 0.55)
--glow-status  0 0 6px currentColor
```

No status collision here at all, since the accent is magenta — this palette gets the relaxed rule
almost for free and can simply neon-ify each status colour in place.

- **Pattern:** circuit traces, or a faint perspective grid.
- **Image:** rain-on-window neon, wet street, dense signage bokeh — heavily darkened so the frame
  stays a texture rather than a photograph.

**The two must not look like each other.** Cypherpunk is *quiet, green, monospaced, minimal glow*;
cyberpunk is *saturated, magenta/cyan, glowing*. If they end up as siblings in the picker, one of
them is wrong.

---

## Decisions already made

- **No DB migration.** `User.Theme` already carries everything. The moment we add "freeze time of
  day" or user-uploaded backgrounds we're into migration + storage + moderation, so v1 stays
  migration-free. Ship it, then see if anyone actually asks to turn the dynamics off.
- **Colors stay in CSS, metadata stays in C#.** Themes 2.0 must not start putting hex values in
  `ThemeRegistry`.
- **Status colours may now be overridden by a theme** (new — relaxes the old themes.css rule), but
  **never by a context**. Convention and the `--color-danger` caveat are documented above.
- **Glow is a theme-level opt-in** via `--glow-*`, defaulting to `none`, and never applied
  per-message.
- **Cypherpunk and cyberpunk are two separate themes**, not one compromise.
- **Renamed 2026-08-25 after shipping: cypherpunk → `terminal` ("Terminal"), cyberpunk →
  `neon-glow` ("Neon Glow").** The doc keeps the original names in its history. Theme ids live in
  `User.Theme`, so anyone who picked the old ids falls back to the default look and re-picks —
  graceful, no migration.
- **Teahouse art licensing is cleared** (freely available, author unconcerned) — but **credit
  Meomi** in Settings, as the source README asks. **Not done as of 2026-10**; the credit exists
  only as a comment at the top of `teahouse.css`.
- **Cypherpunk and cyberpunk ship without background images**, on pattern + glow alone. Images
  optional later.
- **Not doing:** weather, user-uploaded backgrounds, per-DM colour derived from the other user
  (fun, but scope), an in-app theme editor.

## Open questions (all settled)

Kept for the record. None of these is open any more.

1. ~~Teahouse light/dark: option A, B or C?~~ **Settled: A**, Tea House is a light theme that darkens
   at night by scene (see Piece 2).
2. ~~Does the header-line swap survive Piece 3?~~ **Yes.** `ChatLayout.razor` still swaps the 3px
   line by DM state, on top of the canvas shift.
3. ~~Do non-image themes get a DM pattern by default?~~ **Default on, explicit opt-out.** The generic
   rule gives every DM `waves`; the plain club (discord-dark, midnight, nord, aurora, solarized-light)
   sets `none` by hand. The comment above that rule in `themes.css` says why both lines are needed.
4. ~~Do Terminal / Neon Glow need background images?~~ **No.** They shipped pattern-only, and that
   proved the pattern layer independently of the art pipeline.
5. ~~Status-colour convention: comment or doc?~~ **Both.** The header of `themes.css` states the rule
   (a theme may re-tint, `--color-danger` stays red, a context never touches them) and points here.
6. ~~Is the day wash too pale?~~ **Settled 2026-08-25: no — keep it.** Checked on the deployed
   system; the user likes the pastel daytime reading. The bottom-stop alphas (0.58 light,
   0.68 dark) in `panel()` are correct as they stand, so don't "fix" them later.

## Build plan

Five steps to Teahouse on screen. Steps 1–2 are safe and reversible and touch no existing theme;
step 3 is where the design work lives.

### Step 1 — Asset prep — **DONE**

`themes/teahouse/build_assets.py` converts the 55 JPEG layers to WebP into
`Yap/wwwroot/images/themes/teahouse/<scene>/<layer>.webp`; originals stay in `themes/` as the
archive. **5937 KB → 1473 KB (75%).**

The encoder rule changed once, against data. The first version used **lossless for all three tiled
layers**, reasoning that lossy block error lands on the edges where a tile abuts its own copy and
would draw a grid of seams across the screen. Measuring killed it:

- Lossless came out **larger than the source JPEGs** for the detailed tiles (footertile 79K → 106K),
  because the sources are already JPEG and lossless has to encode their existing noise. One scene
  (noon) got 47% *bigger* overall.
- The seam worry did not survive measurement either: mean absolute error along the tiling columns is
  the same as in the tile interior (1.43 vs 1.21 at q95; 1.03 vs 1.05 for headertile) — the block
  grid is already baked into the source, so re-encoding does not concentrate new error at the edges.

Final rule, recorded in the script's docstring:

| layer | encoding | why |
|---|---|---|
| `canvastile` | **lossless** | flat colour, ~0 KB either way, and its colour must match the CSS fallback exactly or an edge shows |
| `headertile`, `footertile` | **q95** | 2–4× smaller than the source JPEG, no measurable seam penalty |
| `header_bg`, `footer_bg_rside` | **q88** | painted once, no self-abutting edges; `footer_bg_rside` is the heaviest layer in the set |

Also confirmed: `10am`'s footertile and `2pm`'s footer really are unique (differing checksums), so
the generator must resolve a missing layer via `ENV_OF` **only as a fallback**, exactly as
`compose.py` does — not unconditionally the way `preview.html` does.

### Step 2 — The canvas layer — **DONE** (81 lines, 3 files)

- `app.css` `:root` — the five `--scene-*` variables and `--canvas-scrim`, all `none`.
- `ChatLayout.razor` — `.theme-scene` and `.theme-scrim`, two empty divs.
- `wwwroot/chat-client/shared.css` — one element carrying **five comma-matched backgrounds** rather than five
  divs, listed top-first (the reverse of the source paint order), following `preview.html`'s DOM
  stacking: footer, footertile, header, headertile, canvastile.

**The predicted risk did not materialise, and the fix is better than the one planned.** Instead of
lifting header/sidebar/messages with `position: relative; z-index: 1` — which would have meant
editing other components — `.chat-container` gets `isolation: isolate` and the scene layers sit at
`z-index: -1`. Inside that stacking context they paint *above* the container's own `--bg-primary`
background (which stays as the load-time fallback) and *below* every in-flow child. **No other
component was touched.**

`overflow: hidden` does not create a stacking context on its own, hence the explicit `isolation`.

**Verified.** Builds clean (0 errors; the 11 warnings are all pre-existing). A Playwright harness
(`scratchpad/verify.mjs`) logs in via `/auth/signin`, loads `/lobby`, switches `data-theme` through
all seven themes and asserts the layers are present and **inert** — every one of the scene's five
background slots computing to `none`, the scrim transparent, `isolation: isolate` in effect. All 7
pass, which is a stronger acceptance test than eyeballing screenshots: if nothing paints, nothing
changed.

Also checked by hand rather than assumed: `isolation: isolate` traps no existing UI. `ReconnectModal`
lives in `App.razor` and `#blazor-error-ui` in `MainLayout`, both **outside** `.chat-container`; every
z-index inside it (header dropdowns 999/1000, sidebar 99/199/200, backdrop 98) only ever stacks
against its own siblings.

### Step 3 — The theme generator — **DONE**

`themes/teahouse/gen_theme_css.py` reads `palette.json` and emits
`Yap/wwwroot/themes/teahouse.css`: 13 blocks of `[data-theme="teahouse"][data-scene="…"]`, each
carrying the five `--scene-*` URLs plus the full variable set.

**Do not generate 13 × 22 hand-picked hexes.** Define **two templates** — light and dark — that
express every variable as an HSL offset from the scene's own canvas H/S/L:

```
panel   = H, S×0.6, L−12%      input = H, S×0.5, L−18%      (light template)
text    = H, S×0.3, L−55%      muted = H, S×0.2, L−35%
```

That is ~20 tunable numbers instead of 286 hexes, and it makes the hue arc carry through the whole
UI automatically. Pick the template per scene by the luminance table above.

**Accent:** keep a stable tea-gold/jade identity rather than sampling each scene's highlight —
a per-scene accent would collide with text at some hours and make the app feel like 13 apps. Adjust
only its luminance per template. Shipped as `GOLD_LIGHT = (32, 62, 38)` and `GOLD_DARK = (36, 70, 58)`
— dark gold on the pale day canvas, lantern gold against the night.

**Two template bugs, both found by looking at rendered screenshots rather than at the CSS:**

1. **The wash ran the wrong way.** The reading-surface panel was built from the *canvas colour* in
   both modes. A wash has to move **away from the text colour**, not toward the canvas: light scenes
   lighten (dark text on top), dark scenes darken. At 8pm the canvas is `#606080` — *lighter* than
   the artwork it was covering — so the panel fogged the whole scene grey. It is now a
   direction-aware gradient: transparent over the empty sky at the top, ramping to a protective wash
   at the bottom where messages are bottom-anchored over the dense garden.
2. **Chrome was derived from the canvas lightness**, which ranges 13% (2am) to 44% (8pm) across the
   dark scenes. That put 8pm's input bar at 54% — a pale lavender slab with an unreadable
   placeholder. Chrome lightness is now pinned into a band by `chrome_base()` (`min(l, 20)` dark,
   `max(l, 70)` light) while hue and saturation still come from the canvas, so each scene keeps its
   tint without the chrome drifting. Direction also now matches the app's own conventions: dark
   themes put sidebar/header *darker* than the canvas (discord-dark's `#2f3136`/`#202225` against
   `#36393f`), light themes lighter (Daylight's `#ffffff`/`#f0f0f3` against `#f5f5f7`).

Wiring, beyond the generated sheet: `--scene-sizes` and `--bg-canvas-panel` added to `app.css`
`:root`; `.messages-container` switched from `--bg-primary` to `--bg-canvas-panel` so a scene theme
can make the reading area translucent while `--bg-primary` stays opaque as the fallback and as the
fill for small elements; `App.razor` links the generated sheet; `ThemeRegistry` gains a `teahouse`
entry whose picker thumbnail (`preview.webp`, the 6pm scene) is generated by `build_assets.py`.

### Step 4 — The clock — **DONE**

- Inline blocking `<head>` script (after the stylesheet links) sets `data-scene` on `<html>` from
  the local hour, using `compose.py`'s `TIMEMAP` verbatim — including hour 3 → `314am`.
- Re-evaluate on a timer and on `visibilitychange`.
- **Crossfade was dropped**, as the plan allowed. Scenes change roughly every two hours, almost never
  while anyone is watching, and two stacked scene layers plus fade orchestration is real complexity
  for an event nobody sees. If the swap turns out to look abrupt, **preloading the next scene's five
  images is the better fix than a crossfade** — the jank would come from images decoding one by one,
  not from the lack of a fade.
- Register the theme in `ThemeRegistry` (preview thumbnail from `compose.py`) and put the **Meomi
  credit** in Settings.

### Step 5 — Verify on real screens — **DONE** (by the user, on the deployed system)

Verdict: the theme reads well, and the daytime wash is right as-is (open question 6, closed).
Two defects came back from real use, both now fixed:

**The composer met the message list in a hard line.** Not a missing gradient — a surface
mismatch. `.message-input-container` painted `--bg-primary`, fully opaque, while the panel
directly above ends at 0.58 alpha with artwork showing through. First fixed by making them the
*same* surface — the generator emitted `--bg-input-band` as the panel gradient's own final stop.
**Superseded the same day:** the user preferred the composer area fully transparent, with only the
input pill itself coloured. Tea House no longer sets the band at all; the wash behind the composer
comes from the panel gradient, which reaches the container bottom because the composer sits inside
`.messages-container`. `--bg-input-band` remains (default `transparent`) as the documented guard —
any future theme that sets it opaque re-creates the seam.

**The mobile sidebar was too transparent.** Under 768px `ChatSidebar` stops being a column beside
the chat and slides in *over* it, so the desktop alpha left usernames competing with the messages
showing through. A media query at the same breakpoint lifts it to 0.92/0.93; desktop stays 0.74,
where the translucency is the best part of the theme.

Still not measured on a real phone by Claude: only emulated viewports here.

---

### Step 5 notes *(original)*

*(Partly answered early — see the vertical-fit fix and the sidebar finding in Piece 2. The Playwright
harness in the scratchpad is reusable for checking generator output scene by scene.)*

The vertical-fit unknown from Piece 2: header strip (≤540px) + footer strip (399px) = 939px, so a
short viewport overlaps them. Measure on a real phone, then add a scale factor if needed. Also
confirm the 6am flip reads right in daylight.

---

### After Teahouse — **all shipped 2026-08-25**

Pattern layer, room-vs-DM, cypherpunk, cyberpunk, the status relax and the glow axis all
landed together. Three things worth carrying forward:

**Every shipped pattern is a repeating gradient, not an SVG data URI.** The mask mechanism
is exactly as designed — shape from `mask-image`, colour from `background-color`, so one
definition serves every theme — but gradients turned out to cover all four patterns we
wanted (hairlines, scanlines, grid, kumiko lattice). They tile seamlessly by construction
and need no data-URI debugging. SVG masks remain available for shapes gradients cannot
draw; the kumiko lattice stands in for true asanoha, which would need one.

**Superseded 2026-08-25, same day:** the user found the whole gradient set — hairlines,
scanlines, grid, kumiko — **too rigid**, and asked for organic, soft, discrete motifs that
don't touch ("seamless doesn't mean one long line or grid"). That is precisely the case
gradients cannot draw, so the patterns are now **SVG data-URI masks** after all: `waves`
(loose tildes), `drops` (raindrops — cyberpunk's rain-on-the-window), `specks` /
`specks-dense` (phosphor dots for cypherpunk, dense = encrypted DMs), `seigaiha`
(wave-crest arcs for Tea House DMs). Two things worth keeping from the exercise: a tile is
seamless as long as no motif crosses its edge — sparse scatter at varied rotation/scale
kills the visible periodicity; and the authoring/preview tool lives at
`themes/patterns/build.py`, so motif edits are regenerated, not hand-tweaked in a URI.

**Extended 2026-08-25 with user-brought motifs** (source SVGs parked in `themes/patterns/` under
their content names): `pebbles` and `ripples` were adopted — ripples became Tea House's DM marker
(retiring the seigaiha stand-in, still authored in build.py), pebbles became the DM marker for the
flat/mineral themes (discord-dark, midnight, nord, light) while the gradient themes (ocean, sunset,
aurora) keep the tapered waves — a split by temperament, not per-theme whim. The scattered-drops
file's rotation jitter was merged into our drops motif. `sprouts` and `amoebas` are parked for
future themes; `flowing-waves` was declined (full-width lines — the thing the organic pass
replaced). Their big lesson was **tile period**: 260px tiles with large sparse motifs hide the
repeat far better than tight 64–104px tiles.

**The layers live BELOW in-flow children, so any opaque panel buries them.** `--bg-canvas-panel`
and `--bg-input-band` defaulted to `--bg-primary`, and the pattern rendered nothing at all —
a 60x40 patch of empty chat had exactly one distinct colour. Both now default to
`transparent`, which looks *identical* (`.chat-container` already paints `--bg-primary`
beneath everything) but lets the scene and pattern layers show. Anything added below the
content in future needs the same treatment; check by sampling pixels, not by eye.

**Alpha depends on the pattern's job.** A DM marker wants ~0.045 — noticeable only as "this
room feels different". A theme's *signature* pattern needs 0.075–0.11 or it is not subtle,
it is absent: cypherpunk's scanlines at 0.045 and cyberpunk's grid at 0.05 both measured as
zero painted pixels' worth of visible difference.

**Halved across the board, 2026-08-27.** In multi-day use the whole set read as decoration
competing with the text instead of a whisper that the room is different. The *ratios* were
right — DM marker below signature pattern, pebbles below stroke motifs — so every pattern
alpha in the app was scaled by 0.5 rather than retuned individually: the shared
`--pattern-tint` default in `app.css` (0.045 → 0.0225), light's pebbles (0.032 → 0.016),
Terminal (0.075/0.08 → 0.0375/0.04), Neon Glow (0.11/0.10 → 0.055/0.05), the parked
discord-dark/midnight/nord pebbles (0.018 → 0.009), and both Tea House templates in
`gen_theme_css.py` (0.07/0.05 → 0.035/0.025, regenerated). The themes with no pattern at all
(discord-dark, midnight, nord, aurora) stay plain — that is a lineup choice, not a level.
Scale the whole set together if this is ever revisited; moving one value alone breaks the
ordering the numbers encode.

And the warning in Piece 6 was justified: on first render the two new themes **did** read as
siblings — both near-black, both showing a green status chip, with cyberpunk's magenta never
appearing at rest because the send button collapses while the input is empty. Fixed by
pushing cyberpunk's palette properly indigo (`#0d0820`) and making its cyan grid legible.

## Sources

Pattern research:
- [Hero Patterns](https://heropatterns.com/) — repeatable SVG backgrounds, CC-BY 4.0
- [SVG Backgrounds — pattern guide](https://www.svgbackgrounds.com/svg-pattern-guide/)
- [Gera Tools SVG Pattern Generator](https://geratools.com/svg-pattern-generator)
- [codeshack CSS Pattern Generator](https://codeshack.io/css-pattern-generator/)
- [yuanchuan — How To Make Seamless Patterns](https://yuanchuan.dev/how-to-make-seamless-patterns)
- [230+ CSS Background Patterns (FreeFrontend)](https://freefrontend.com/css-background-patterns/)
