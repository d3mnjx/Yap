#!/usr/bin/env python3
"""Generate the Tea House theme CSS from the extracted artwork's own palette.

Reads  palette.json  (dominant colours + pixel sizes per scene per layer)
Writes ../../Yap/wwwroot/themes/teahouse.css

Why generated: 13 scenes x ~24 variables is 300+ hand-picked hex values that would
all have to stay in step with each other. Instead every colour is derived from one
number per scene - the canvas tile's colour - through two templates, LIGHT and
DARK. That is ~20 tunable offsets in this file rather than 300 hexes in a stylesheet,
and it makes the theme's day arc (warm tan at dawn -> yellow at noon -> cool cyan
in the afternoon -> gold at sunset -> blue at dusk -> neutral at night) carry
through the whole UI on its own.

Which template a scene gets is decided by the WCAG relative luminance of its canvas
colour, because this theme is genuinely light by day and dark by night. The split
lands at 6am and 8pm. (The design record, "Teahouse is not a dark theme", left the
tree with the Blazor code; Yap/wwwroot/css/README.md says how to read it.)

Layer scaling: the header and footer strips are 450-540px and 399-549px tall, so on
any ordinary viewport they overlap and two phases of the same sky meet in a visible
seam. Every layer is therefore scaled by ONE factor, min(1, viewportH / (headerH +
footerH)), expressed in pure CSS as `min(<native>px, <share>svh)` - no JS, and it
re-fits on window resize for free. The factor must be identical across layers or the
teahouse stops meeting the garden's ground line.

Usage: python3 gen_theme_css.py
"""
import colorsys
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "Yap", "wwwroot", "themes", "teahouse.css"))
URL_BASE = "/images/themes/teahouse"

SCENES = ["midnight", "2am", "314am", "4am", "6am", "8am", "10am",
          "noon", "2pm", "4pm", "6pm", "8pm", "10pm"]

# CSS var -> layer file, in the paint order .theme-scene declares (top first).
LAYER_ORDER = [
    ("--scene-footer", "footer_bg_rside"),
    ("--scene-footertile", "footertile_bg_rside"),
    ("--scene-header", "header_bg"),
    ("--scene-headertile", "headertile_bg"),
    ("--scene-canvastile", "canvastile_bg"),
]

# 10am/2pm ship only their own foreground; their environment comes from these.
# Applied as a FALLBACK only - 10am's footertile and 2pm's footer are genuinely
# unique files (verified by checksum), so a scene's own file always wins.
ENV_OF = {"10am": "8am", "2pm": "noon"}

LUMA_LIGHT = 0.35   # above this the scene gets the LIGHT template

# Tea gold. Deliberately fixed rather than sampled per scene: an accent that moved
# with the artwork would collide with the canvas at some hours (6pm is itself gold)
# and make the app feel like thirteen different apps.
GOLD_LIGHT = (32, 62, 38)   # dark gold: accents sit on a pale canvas by day
GOLD_DARK = (36, 70, 58)    # bright gold: lantern light against a night canvas


def hex_to_hsl(h):
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    return hh * 360, ss * 100, ll * 100


def luminance(h):
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def hsl(h, s, l, a=None):
    h, s, l = round(h), max(0, min(100, round(s))), max(0, min(100, round(l)))
    return f"hsl({h} {s}% {l}%{f' / {a}' if a is not None else ''})"


def resolve(pal, scene, layer):
    """The scene's own layer if it has one, else its environment scene's."""
    if layer in pal.get(scene, {}):
        return scene
    env = ENV_OF.get(scene)
    return env if env and layer in pal.get(env, {}) else None


def chrome_base(l, light):
    """Lightness that chrome (sidebar, header, input) is built from.

    NOT the canvas lightness. Across the dark scenes the canvas runs 13% (2am) to
    44% (8pm), and deriving chrome straight from it put 8pm's input bar at 54% -
    a pale lavender slab with an unreadable placeholder. The canvas still supplies
    hue and saturation, so each scene keeps its tint; only the lightness is pinned
    into a band that reads as dark chrome (or light chrome) at every hour.
    """
    return max(l, 70) if light else min(l, 20)


def panel(h, s, l, light):
    """The reading surface behind the message list.

    A wash must move AWAY from the text colour, not toward the canvas colour: light
    scenes lighten (dark text on top), dark scenes darken (light text on top). The
    first version used the canvas colour for both and fogged every scene grey - at
    8pm the canvas is #606080, lighter than the artwork it was covering.

    It is a gradient rather than a flat fill because the artwork is a frame: sky at
    the top, dense garden at the bottom. Messages sit bottom-anchored, exactly over
    the busiest part, so protection ramps up where the art gets loud and stays out of
    the way over the empty sky.
    """
    if light:
        b = (h, s * 0.45, min(chrome_base(l, True) + 10, 94))
        stops = [(0.06, 0), (0.22, 45), (0.58, 100)]
    else:
        b = (h, s * 0.70, max(chrome_base(l, False) - 8, 5))
        stops = [(0.10, 0), (0.30, 45), (0.68, 100)]
    # --bg-input-band is deliberately NOT emitted (it briefly mirrored this
    # gradient's last stop). The composer lives inside .messages-container, so this
    # gradient already washes the area behind it -- and the user wants only the
    # input pill itself coloured, not a band around it (2026-08-25).
    parts = [f"{hsl(*b, f'{a:.2f}')} {pos}%" for a, pos in stops]
    return "linear-gradient(to bottom, " + ", ".join(parts) + ")"


def build_vars(h, s, l, light):
    """The two templates. Every value is an offset from the scene's canvas H/S/L.

    Panels are translucent on purpose: opaque chrome hides the artwork, and on
    desktop the sidebar sits exactly on top of the teahouse itself - the one thing
    the theme is named after. Alpha is what lets the building show through.

    Chrome lightness follows the direction each mode already uses in this app: in
    dark themes the sidebar and header are DARKER than the canvas (discord-dark's
    #2f3136/#202225 against #36393f), in light themes they are lighter (Daylight's
    #ffffff/#f0f0f3 against #f5f5f7).
    """
    cb = chrome_base(l, light)
    if light:
        return {
            "--bg-primary": hsl(h, s, l),                      # the canvas colour itself
            "--bg-canvas-panel": panel(h, s, l, True),
            "--bg-sidebar": hsl(h, s * 0.35, min(cb + 6, 92), "0.72"),
            "--bg-header": hsl(h, s * 0.30, min(cb + 10, 95), "0.85"),
            "--bg-darkest": hsl(h, s * 0.40, cb - 24),
            "--bg-hover": hsl(h, s * 0.40, cb - 6, "0.45"),
            "--bg-secondary": hsl(h, s * 0.40, min(cb + 3, 92), "0.70"),
            "--bg-tertiary": hsl(h, s * 0.35, cb - 4, "0.65"),
            "--bg-input": hsl(h, s * 0.22, min(cb + 16, 97), "0.92"),
            "--bg-muted": hsl(h, s * 0.28, cb - 18),
            "--text-white": hsl(h, s * 0.55, 8),
            "--text-primary": hsl(h, s * 0.45, 14),
            "--text-secondary": hsl(h, s * 0.35, 26),
            "--text-muted": hsl(h, s * 0.30, 34),
            "--text-tertiary": hsl(h, s * 0.25, 42),
            "--text-placeholder": hsl(h, s * 0.20, 52),
            "--border-dark": hsl(h, s * 0.35, l - 22),
            "--border-subtle": hsl(h, s * 0.30, l - 14),
            # DM pattern tint: dark ink on a daylight canvas. The app-wide default is
            # white, which is invisible here. Alpha is half its original value -
            # halved 2026-08-27 along with every other pattern alpha, see the
            # --pattern-tint comment in app.css.
            "--pattern-tint": hsl(h, s * 0.40, 20, "0.035"),
        }
    return {
        "--bg-primary": hsl(h, s, l),
        "--bg-canvas-panel": panel(h, s, l, False),
        "--bg-sidebar": hsl(h, s * 0.80, max(cb - 4, 6), "0.74"),
        "--bg-header": hsl(h, s * 0.80, max(cb - 7, 4), "0.88"),
        "--bg-darkest": hsl(h, s, max(cb - 12, 3)),
        "--bg-hover": hsl(h, s * 0.70, cb + 12, "0.55"),
        "--bg-secondary": hsl(h, s * 0.80, max(cb - 2, 5), "0.72"),
        "--bg-tertiary": hsl(h, s * 0.80, max(cb - 6, 4), "0.70"),
        "--bg-input": hsl(h, s * 0.60, cb + 8, "0.85"),
        "--bg-muted": hsl(h, s * 0.50, cb + 20),
        "--text-white": hsl(h, s * 0.20, 98),
        "--text-primary": hsl(h, s * 0.18, 92),
        "--text-secondary": hsl(h, s * 0.15, 80),
        "--text-muted": hsl(h, s * 0.14, 70),
        "--text-tertiary": hsl(h, s * 0.12, 60),
        "--text-placeholder": hsl(h, s * 0.10, 52),
        "--border-dark": hsl(h, s, max(l - 18, 2)),
        "--border-subtle": hsl(h, s, max(l - 22, 1)),
        "--pattern-tint": hsl(h, s * 0.30, 95, "0.025"),  # half, as above
    }


def accent_vars(light):
    hh, ss, ll = GOLD_LIGHT if light else GOLD_DARK
    return {
        "--accent-primary": hsl(hh, ss, ll),
        "--accent-hover": hsl(hh, ss, ll - 8),
        "--accent-light": hsl(hh, ss * 0.9, 88),
        "--accent-focus": hsl(hh, ss + 8, ll + 7),
        "--accent-tint": hsl(hh, ss, ll, "0.15"),
        # Text on a fill of the accent (--accent-ink, app.css). White on the bright gold
        # of a night scene has a contrast near 2:1, so those scenes write with their
        # darkest background. The dark gold of a day scene carries the default white.
        **({} if light else {"--accent-ink": "var(--bg-darkest)"}),
    }


def main():
    pal = json.load(open(os.path.join(HERE, "palette.json")))
    lines = [
        "/* Tea House theme - GENERATED by themes/teahouse/gen_theme_css.py. DO NOT EDIT.",
        " *",
        " * Artwork by Meomi (www.meomi.com), from Google's Gmail 'Tea House' theme.",
        " * Regenerate with: python3 themes/teahouse/gen_theme_css.py",
        " *",
        " * One block per time-of-day scene. data-theme is server-rendered; data-scene is",
        " * set from the browser clock before first paint (applyScene, the inline script",
        " * in index.html).",
        " */",
        "",
    ]
    summary = []

    for scene in SCENES:
        csrc = resolve(pal, scene, "canvastile_bg")
        canvas = pal[csrc]["canvastile_bg"]["palette"][0]["hex"]
        h, s, l = hex_to_hsl(canvas)
        light = luminance(canvas) > LUMA_LIGHT

        # One scale factor for every layer, from the two strips that must fit.
        hs = resolve(pal, scene, "headertile_bg")
        fs = resolve(pal, scene, "footertile_bg_rside")
        denom = pal[hs]["headertile_bg"]["size"][1] + pal[fs]["footertile_bg_rside"]["size"][1]

        images, sizes = [], []
        for var, layer in LAYER_ORDER:
            src = resolve(pal, scene, layer)
            if src is None:
                images.append((var, "none"))
                sizes.append("auto")
                continue
            images.append((var, f"url('{URL_BASE}/{src}/{layer}.webp')"))
            if layer == "canvastile_bg":
                sizes.append("auto")  # flat colour; scaling a solid tile buys nothing
            else:
                px = pal[src][layer]["size"][1]
                sizes.append(f"auto min({px}px, {px / denom * 100:.2f}svh)")

        v = build_vars(h, s, l, light)
        v.update(accent_vars(light))

        lines.append(f'/* {scene} - canvas {canvas}, {"LIGHT" if light else "dark"} */')
        lines.append(f'[data-theme="teahouse"][data-scene="{scene}"] {{')
        for var, val in images:
            lines.append(f"    {var}: {val};")
        lines.append(f"    --scene-sizes: {', '.join(sizes)};")
        lines.append("")
        for var, val in v.items():
            lines.append(f"    {var}: {val};")
        lines.append("}")
        lines.append("")
        summary.append((scene, canvas, "LIGHT" if light else "dark", denom))

    # Mobile sidebar. Under 768px the sidebar stops being a column beside the chat and
    # slides in as an overlay ON TOP of it, so the same alpha that looks right on
    # desktop leaves usernames competing with the messages showing through. Lift it.
    lines.append("/* Mobile: the sidebar overlays the chat rather than sitting beside it,")
    lines.append("   so it needs more body behind the names. Breakpoint matches")
    lines.append("   the sidebar's own slide-in media query in frame.css. */")
    lines.append("@media (max-width: 768px) {")
    for scene, canvas, mode, _ in summary:
        h2, s2, l2 = hex_to_hsl(canvas)
        light2 = mode == "LIGHT"
        cb2 = chrome_base(l2, light2)
        if light2:
            v = hsl(h2, s2 * 0.35, min(cb2 + 6, 92), "0.92")
        else:
            v = hsl(h2, s2 * 0.80, max(cb2 - 4, 6), "0.93")
        lines.append(f'    [data-theme="teahouse"][data-scene="{scene}"] {{ --bg-sidebar: {v}; }}')
    lines.append("}")
    lines.append("")

    # Scene-independent rules. data-scene is absent until the clock script runs, so
    # these also give the theme a sane look during that first frame.
    lines += [
        "/* Applies to every scene. */",
        '[data-theme="teahouse"] {',
        "    /* No wash by default: the artwork already keeps its detail in the top and",
        "       bottom strips, and the panels above carry their own alpha. */",
        "    --canvas-scrim: none;",
        "}",
        "",
    ]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        f.write("\n".join(lines))

    print(f"{'scene':10}{'canvas':9}{'mode':7}{'strip sum':>10}")
    for scene, canvas, mode, denom in summary:
        print(f"{scene:10}{canvas:9}{mode:7}{denom:>9}px")
    print(f"\nwrote {OUT} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
